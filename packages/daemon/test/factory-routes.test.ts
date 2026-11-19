import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { factoryRoutes } from "../src/routes/factory.js";
import { validateRigSpecFromYaml } from "../src/domain/spec-validation-service.js";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { SpecReviewService } from "../src/domain/spec-review-service.js";

const SHARED_AGENT_DIR = resolve(import.meta.dirname, "..", "specs", "agents", "shared");

function team(overrides: Record<string, unknown> = {}) {
  return {
    name: "doc-team",
    title: "Doc Team",
    summary: "Writes the design, API and test documents",
    workflow: "sequential",
    members: [
      {
        id: "architect",
        title: "Solution Architect",
        role: "architect",
        runtime: "claude-code",
        model: "opus",
        instructions: "Design the system.",
        skills: ["shared-debug"],
        customSkills: [{ name: "c4-diagrams", description: "Draw C4 diagrams", content: "Use Mermaid C4." }],
        deliverables: [
          { id: "system-design", title: "System Design", path: "docs/design/system-design.md", outline: "# System Design", acceptance: "Has a diagram" },
        ],
      },
      {
        id: "backend",
        title: "Backend Engineer",
        runtime: "codex",
        instructions: "Write the API doc.",
        skills: ["workspace-skill"],
        customSkills: [],
        deliverables: [{ id: "api-spec", title: "API Spec", path: "docs/api/api-spec.md", outline: "", acceptance: "" }],
      },
      {
        id: "qa",
        title: "QA Engineer",
        runtime: "claude-code",
        instructions: "Write the test plan.",
        skills: [],
        customSkills: [],
        deliverables: [{ id: "test-plan", title: "Test Plan", path: "docs/testing/test-plan.md", outline: "", acceptance: "" }],
      },
    ],
    ...overrides,
  };
}

describe("factory routes", () => {
  let tmp: string;
  let teamsRoot: string;
  let workspaceSkillDir: string;
  let lib: SpecLibraryService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "factory-routes-"));
    teamsRoot = join(tmp, "specs", "factory");
    workspaceSkillDir = join(tmp, "ws-skills", "openapi-writer");
    mkdirSync(workspaceSkillDir, { recursive: true });
    writeFileSync(join(workspaceSkillDir, "SKILL.md"), "---\nname: openapi-writer\ndescription: x\n---\nWrite OpenAPI.\n");
    lib = new SpecLibraryService({ roots: [{ path: join(tmp, "specs"), sourceType: "user_file" }], specReviewService: new SpecReviewService() });
    lib.scan();
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function app(): Hono {
    const skills: Record<string, { id: string; name: string; absolutePath: string }> = {
      "shared-debug": { id: "shared-debug", name: "systematic-debugging", absolutePath: join(SHARED_AGENT_DIR, "skills/process/systematic-debugging") },
      "workspace-skill": { id: "workspace-skill", name: "openapi-writer", absolutePath: workspaceSkillDir },
    };
    const a = new Hono();
    a.use("*", async (c, next) => {
      c.set("skillLibraryDiscoveryService" as never, { getSkill: (id: string) => skills[id] ?? null } as never);
      c.set("specLibraryService" as never, lib);
      await next();
    });
    a.route("/api/factory", factoryRoutes({ teamsRoot: () => teamsRoot, sharedAgentDir: SHARED_AGENT_DIR }));
    return a;
  }

  const send = (method: string, url: string, body?: unknown) =>
    app().request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("serves deliverable templates", async () => {
    const res = await send("GET", "/api/factory/templates");
    const body = await res.json() as Array<{ id: string }>;
    expect(body.map((t) => t.id)).toEqual(expect.arrayContaining(["system-design", "api-spec", "test-plan"]));
  });

  it("creates a team whose rig and agent specs are valid and resolvable", async () => {
    const res = await send("POST", "/api/factory/teams", team());
    expect(res.status).toBe(201);
    const detail = await res.json() as { sessions: Record<string, string>; folder: string };
    expect(detail.sessions.architect).toBe("team-architect@doc-team");

    const dir = join(teamsRoot, "doc-team");
    const rigYaml = readFileSync(join(dir, "rig.yaml"), "utf-8");
    expect(validateRigSpecFromYaml(rigYaml)).toEqual({ valid: true, errors: [] });
    const rig = parse(rigYaml);
    expect(rig.pods[0].members.map((m: { id: string }) => m.id)).toEqual(["architect", "backend", "qa"]);
    expect(rig.pods[0].members[0].model).toBe("opus");
    expect(rig.pods[0].edges).toEqual([
      { kind: "delegates_to", from: "architect", to: "backend" },
      { kind: "delegates_to", from: "backend", to: "qa" },
    ]);

    // Shared skill referenced by id; custom skill written locally.
    const architect = parse(readFileSync(join(dir, "agents/architect/agent.yaml"), "utf-8"));
    expect(architect.profiles.default.uses.skills).toEqual(["systematic-debugging", "c4-diagrams"]);
    expect(readFileSync(join(dir, "agents/architect/skills/c4-diagrams/SKILL.md"), "utf-8")).toContain("name: c4-diagrams");

    // Workspace skill copied into the member folder.
    const backend = parse(readFileSync(join(dir, "agents/backend/agent.yaml"), "utf-8"));
    expect(backend.resources.skills).toEqual([{ id: "openapi-writer", path: "skills/openapi-writer" }]);
    expect(existsSync(join(dir, "agents/backend/skills/openapi-writer/SKILL.md"))).toBe(true);

    // Deliverables and handoff guidance.
    expect(readFileSync(join(dir, "agents/architect/guidance/deliverables.md"), "utf-8")).toContain("`docs/design/system-design.md`");
    expect(readFileSync(join(dir, "agents/architect/guidance/role.md"), "utf-8")).toContain("rig send team-backend@doc-team");
    expect(readFileSync(join(dir, "agents/qa/guidance/role.md"), "utf-8")).toContain("You are the last step");

    // The spec library sees it after the save.
    expect(lib.list({ kind: "rig" }).map((e) => e.name)).toContain("doc-team");
    // No staging or trash folders are left behind.
    expect(readdirSync(teamsRoot)).toEqual(["doc-team"]);
  });

  it("refuses to create a duplicate, then replaces it with PUT and keeps createdAt", async () => {
    const first = await (await send("POST", "/api/factory/teams", team())).json() as { team: { createdAt: string } };
    expect((await send("POST", "/api/factory/teams", team())).status).toBe(409);
    const res = await send("PUT", "/api/factory/teams/doc-team", team({ title: "Renamed", workflow: "parallel" }));
    expect(res.status).toBe(200);
    const saved = await res.json() as { team: { title: string; createdAt: string } };
    expect(saved.team.title).toBe("Renamed");
    expect(saved.team.createdAt).toBe(first.team.createdAt);
    expect(parse(readFileSync(join(teamsRoot, "doc-team/rig.yaml"), "utf-8")).pods[0].edges).toEqual([]);
  });

  it("rejects unsafe deliverable paths, duplicate ids and unknown skills", async () => {
    const bad = team();
    bad.members[0]!.deliverables[0]!.path = "../escape.md";
    bad.members[1]!.id = "architect";
    const res = await send("POST", "/api/factory/teams", bad);
    expect(res.status).toBe(400);
    const body = await res.json() as { errors: string[] };
    expect(body.errors.join("\n")).toMatch(/relative path/);
    expect(body.errors.join("\n")).toMatch(/duplicate member id/);

    const unknown = team();
    unknown.members[0]!.skills = ["nope"];
    const res2 = await send("POST", "/api/factory/teams", unknown);
    expect(res2.status).toBe(422);
    expect(existsSync(join(teamsRoot, "doc-team"))).toBe(false);
  });

  it("previews without writing and lists, reads and deletes teams", async () => {
    const preview = await (await send("POST", "/api/factory/teams/preview", team())).json() as { valid: boolean; files: Record<string, string> };
    expect(preview.valid).toBe(true);
    expect(Object.keys(preview.files)).toEqual(expect.arrayContaining(["rig.yaml", "agents/qa/agent.yaml"]));
    expect(existsSync(join(teamsRoot, "doc-team"))).toBe(false);

    await send("POST", "/api/factory/teams", team());
    const list = await (await send("GET", "/api/factory/teams")).json() as Array<{ name: string; deliverableCount: number }>;
    expect(list).toMatchObject([{ name: "doc-team", deliverableCount: 3 }]);
    expect((await send("GET", "/api/factory/teams/doc-team")).status).toBe(200);
    expect((await send("DELETE", "/api/factory/teams/doc-team")).status).toBe(200);
    expect((await send("GET", "/api/factory/teams/doc-team")).status).toBe(404);
    expect((await send("GET", "/api/factory/teams/..%2Fescape")).status).toBe(400);
  });
});
