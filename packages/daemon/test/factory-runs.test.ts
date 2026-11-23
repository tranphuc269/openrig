import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clearAgentApiKey, saveAgentApiSettings } from "../src/domain/agent-api-settings.js";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { factoryRoutes } from "../src/routes/factory.js";
import type { Dispatch } from "../src/domain/factory-studio/run-service.js";

const SHARED_AGENT_DIR = resolve(import.meta.dirname, "..", "specs", "agents", "shared");

const TEAM = {
  name: "doc-team",
  title: "Doc Team",
  summary: "",
  workflow: "sequential",
  members: [
    { id: "architect", title: "Architect", runtime: "claude-code", instructions: "", skills: [], customSkills: [],
      deliverables: [{ id: "design", title: "System Design", path: "docs/design.md", outline: "", acceptance: "" }] },
    { id: "qa", title: "QA", runtime: "claude-code", instructions: "", skills: [], customSkills: [],
      deliverables: [{ id: "tests", title: "Test Plan", path: "docs/tests.md", outline: "", acceptance: "" }] },
  ],
};

interface Call { method: string; path: string; body?: Record<string, unknown> }

describe("factory runs (Agent Workspace)", () => {
  let tmp: string;
  let project: string;
  let calls: Call[];
  let liveRig: boolean;
  let startup: string;
  let app: Hono;
  let runsRoutes: ReturnType<typeof factoryRoutes>;

  const dispatch: Dispatch = async (method, path, body) => {
    calls.push({ method, path, body: body as Record<string, unknown> | undefined });
    if (path === "/api/rigs/summary") return { status: 200, data: liveRig ? [{ id: "rig-1", name: "doc-team", hasLiveAgents: true }] : [] };
    if (path === "/api/up") return { status: 201, data: { status: "completed", rigId: "rig-1" } };
    if (path === "/api/rigs/rig-1/nodes") {
      return { status: 200, data: [
        { canonicalSessionName: "team-architect@doc-team", sessionStatus: "running", startupStatus: startup, agentActivity: { state: "running" } },
        { canonicalSessionName: "team-qa@doc-team", sessionStatus: "running", startupStatus: startup, agentActivity: { state: "idle" } },
      ] };
    }
    if (path === "/api/transport/send") {
      return body && (body as { session?: string }).session === "team-gone@doc-team"
        ? { status: 200, data: { ok: true, outcome: "recorded", sent: false } }
        : { status: 200, data: { ok: true, sent: true } };
    }
    if (path === "/api/down") return { status: 200, data: { ok: true } };
    if (path.startsWith("/api/sessions/")) return { status: 200, data: { content: "hello from the pane", capturedAt: "t" } };
    return { status: 404, data: { error: "unexpected" } };
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "factory-runs-"));
    project = join(tmp, "project");
    mkdirSync(project);
    calls = [];
    liveRig = false;
    startup = "ready";
    runsRoutes = factoryRoutes({
      teamsRoot: () => join(tmp, "teams"),
      sharedAgentDir: SHARED_AGENT_DIR,
      runsRoot: join(tmp, "runs"),
      dispatch,
      runTiming: { pollMs: 1, readyTimeoutMs: 50, sleep: () => Promise.resolve() },
      agentApiHome: join(tmp, "openrig-home"),
    });
    saveAgentApiSettings({ apiKey: "sk-ant-test-key-1234" }, join(tmp, "openrig-home"), {});
    app = new Hono();
    app.route("/api/factory", runsRoutes);
    const res = await req("POST", "/api/factory/teams", TEAM);
    expect(res.status).toBe(201);
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const req = (method: string, url: string, body?: unknown) =>
    app.request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  /** Start a run and wait until its background launch settles. */
  async function startRun(): Promise<string> {
    const res = await req("POST", "/api/factory/runs", { team: "doc-team", task: "Build a todo app", projectDir: project });
    expect(res.status).toBe(202);
    const run = await res.json() as { id: string; status: string };
    expect(run.status).toBe("launching");
    for (let i = 0; i < 50; i++) {
      const d = await (await req("GET", `/api/factory/runs/${run.id}`)).json() as { run: { status: string } };
      if (d.run.status !== "launching") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    return run.id;
  }

  it("refuses to start a task until an API key is set in Settings", async () => {
    clearAgentApiKey(join(tmp, "openrig-home"), {});
    const res = await req("POST", "/api/factory/runs", { team: "doc-team", task: "Write the docs", projectDir: project });
    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ error: "agent_api_missing" });
    expect(calls.filter((c) => c.path === "/api/up")).toHaveLength(0);
  });

  it("launches the team in the project folder and sends the task to the first member only", async () => {
    const id = await startRun();
    const up = calls.find((c) => c.path === "/api/up")!;
    expect(up.body).toMatchObject({ cwdOverride: project, autoApprove: true });
    expect(String(up.body!.sourceRef)).toMatch(/doc-team\/rig\.yaml$/);
    const sends = calls.filter((c) => c.path === "/api/transport/send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body!.session).toBe("team-architect@doc-team");
    expect(String(sends[0]!.body!.text)).toContain("Build a todo app");
    expect(String(sends[0]!.body!.text)).toContain("docs/design.md");

    const detail = await (await req("GET", `/api/factory/runs/${id}`)).json() as {
      phase: string; members: Array<{ id: string; phase: string; seat: { activity: string } }>; progress: { total: number; delivered: number };
    };
    expect(detail.phase).toBe("working");
    expect(detail.members.map((m) => [m.id, m.phase])).toEqual([["architect", "working"], ["qa", "waiting"]]);
    expect(detail.members[0]!.seat.activity).toBe("running");
    expect(detail.progress).toMatchObject({ total: 2, delivered: 0 });
  });

  it("tracks outputs, serves them, and records approve and rework (rework messages the member)", async () => {
    const id = await startRun();
    mkdirSync(join(project, "docs"));
    writeFileSync(join(project, "docs/design.md"), "# Design\n");
    writeFileSync(join(project, "docs/tests.md"), "# Tests\n");

    let detail = await (await req("GET", `/api/factory/runs/${id}`)).json() as { phase: string; members: Array<{ phase: string }> };
    expect(detail.phase).toBe("review");
    expect(detail.members.map((m) => m.phase)).toEqual(["delivered", "delivered"]);

    const doc = await req("GET", `/api/factory/runs/${id}/outputs/architect/design?download=1`);
    expect(doc.status).toBe(200);
    expect(await doc.text()).toBe("# Design\n");
    expect(doc.headers.get("content-disposition")).toContain('filename="design.md"');

    expect((await req("POST", `/api/factory/runs/${id}/review`, { member: "qa", deliverable: "tests", decision: "rework" })).status).toBe(400);
    const sendsBefore = calls.filter((c) => c.path === "/api/transport/send").length;
    const rework = await req("POST", `/api/factory/runs/${id}/review`, { member: "qa", deliverable: "tests", decision: "rework", feedback: "Add load tests" });
    expect(rework.status).toBe(200);
    const sends = calls.filter((c) => c.path === "/api/transport/send");
    expect(sends.length).toBe(sendsBefore + 1);
    expect(sends.at(-1)!.body).toMatchObject({ session: "team-qa@doc-team" });
    expect(String(sends.at(-1)!.body!.text)).toContain("Add load tests");

    await req("POST", `/api/factory/runs/${id}/review`, { member: "architect", deliverable: "design", decision: "approved" });
    detail = await (await req("GET", `/api/factory/runs/${id}`)).json() as { phase: string; members: Array<{ phase: string }> };
    expect(detail.members.map((m) => m.phase)).toEqual(["approved", "rework"]);
    expect(detail.phase).toBe("working");

    await req("POST", `/api/factory/runs/${id}/review`, { member: "qa", deliverable: "tests", decision: "approved" });
    detail = await (await req("GET", `/api/factory/runs/${id}`)).json() as { phase: string; members: Array<{ phase: string }> };
    expect(detail.phase).toBe("approved");
  });

  it("reports an undelivered rework instead of recording it", async () => {
    const team = structuredClone(TEAM);
    team.members[1]!.id = "gone";
    expect((await req("PUT", "/api/factory/teams/doc-team", team)).status).toBe(200);
    const id = await startRun();
    mkdirSync(join(project, "docs"));
    writeFileSync(join(project, "docs/tests.md"), "# Tests\n");
    const res = await req("POST", `/api/factory/runs/${id}/review`, { member: "gone", deliverable: "tests", decision: "rework", feedback: "More cases" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { message: string }).message).toMatch(/not running/);
    const d = await (await req("GET", `/api/factory/runs/${id}`)).json() as { run: { reviews: Record<string, unknown> } };
    expect(d.run.reviews).toEqual({});
  });

  it("refuses outputs that escape the project through a symlink", async () => {
    const id = await startRun();
    mkdirSync(join(tmp, "outside"));
    writeFileSync(join(tmp, "outside", "secret.md"), "secret");
    symlinkSync(join(tmp, "outside"), join(project, "docs"));
    const res = await req("GET", `/api/factory/runs/${id}/outputs/architect/design`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("secret");
  });

  it("refuses a second task while the team is busy, a missing folder, and a rig already running outside a task", async () => {
    await startRun();
    expect((await req("POST", "/api/factory/runs", { team: "doc-team", task: "Again", projectDir: project })).status).toBe(409);

    const fresh = mkdtempSync(join(tmpdir(), "factory-runs-2-"));
    try {
      const a = new Hono();
      a.route("/api/factory", factoryRoutes({
        teamsRoot: () => join(tmp, "teams"), sharedAgentDir: SHARED_AGENT_DIR, runsRoot: join(fresh, "runs"), dispatch,
        runTiming: { pollMs: 1, readyTimeoutMs: 50, sleep: () => Promise.resolve() },
        agentApiHome: join(tmp, "openrig-home"),
      }));
      const post = (b: unknown) => a.request("/api/factory/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
      expect((await post({ team: "doc-team", task: "x", projectDir: join(tmp, "nope") })).status).toBe(400);
      expect((await post({ team: "doc-team", task: "x", projectDir: "relative/dir" })).status).toBe(400);

      liveRig = true;
      const res = await post({ team: "doc-team", task: "x", projectDir: project });
      const run = await res.json() as { id: string };
      let status = "launching";
      let error = "";
      for (let i = 0; i < 50 && status === "launching"; i++) {
        const d = await (await a.request(`/api/factory/runs/${run.id}`)).json() as { run: { status: string; error?: string } };
        status = d.run.status;
        error = d.run.error ?? "";
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(status).toBe("failed");
      expect(error).toMatch(/already running/);
      expect(calls.filter((c) => c.path === "/api/up")).toHaveLength(1);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("fails the run when seats never become ready, and stops a running team", async () => {
    startup = "pending";
    const failedId = await startRun();
    const failed = await (await req("GET", `/api/factory/runs/${failedId}`)).json() as { phase: string; run: { error: string } };
    expect(failed.phase).toBe("failed");
    expect(failed.run.error).toMatch(/did not finish starting/);

    startup = "ready";
    const id = await startRun();
    const screen = await (await req("GET", `/api/factory/runs/${id}/screen/architect`)).json() as { content: string };
    expect(screen.content).toBe("hello from the pane");
    const stopped = await req("POST", `/api/factory/runs/${id}/stop`);
    expect(stopped.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ path: "/api/down", body: { rigId: "rig-1", snapshot: true } });
    const d = await (await req("GET", `/api/factory/runs/${id}`)).json() as { phase: string };
    expect(d.phase).toBe("stopped");
  });
});
