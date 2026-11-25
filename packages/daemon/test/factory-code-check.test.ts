import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readCodeFile, resolveCheckCommand, runCheck, scanCode } from "../src/domain/factory-studio/code-check.js";
import { FactoryRunStore } from "../src/domain/factory-studio/run-store.js";
import { FactoryRunService } from "../src/domain/factory-studio/run-service.js";
import { generateTeamFiles } from "../src/domain/factory-studio/generator.js";
import { parseFactoryTeamInput, type FactoryTeam } from "../src/domain/factory-studio/team.js";

const SHARED_AGENT_DIR = resolve(import.meta.dirname, "..", "specs", "agents", "shared");

describe("code folders", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "code-check-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const write = (rel: string, content: string | Buffer = "x") => {
    const p = join(tmp, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  };

  it("lists source files, skipping dependencies and build output", () => {
    write("src/index.ts");
    write("package.json", "{}");
    write("node_modules/react/index.js");
    write("dist/app.js");
    write(".git/HEAD");
    const scan = scanCode(tmp, 0);
    expect(scan.files.map((f) => f.path)).toEqual(["package.json", "src/index.ts"]);
    expect(scan.latest).not.toBeNull();
  });

  it("picks the check: the team's command, then factory-check.sh, then the manifest", () => {
    expect(resolveCheckCommand(tmp, undefined)).toBeNull();
    write("package.json", "{}");
    expect(resolveCheckCommand(tmp, undefined)).toEqual({ command: "npm install --no-audit --no-fund && npm run --if-present build && npm run --if-present test", source: "detected" });
    write("package-lock.json", "{}");
    expect(resolveCheckCommand(tmp, undefined)!.command).toMatch(/^npm ci/);
    write("factory-check.sh", "exit 0");
    expect(resolveCheckCommand(tmp, undefined)).toEqual({ command: "bash factory-check.sh", source: "factory-check.sh" });
    expect(resolveCheckCommand(tmp, " make test ")).toEqual({ command: "make test", source: "team" });
    const go = mkdtempSync(join(tmpdir(), "code-go-"));
    writeFileSync(join(go, "go.mod"), "module x");
    expect(resolveCheckCommand(go, "")!.command).toBe("go build ./... && go test ./...");
    rmSync(go, { recursive: true, force: true });
  });

  it("reads text files inside the folder only", () => {
    write("src/a.ts", "export const a = 1;\n");
    write("img.png", Buffer.from([0x89, 0x50, 0, 0, 1]));
    write("node_modules/x/index.js", "x");
    expect(readCodeFile(tmp, "src/a.ts").content).toBe("export const a = 1;\n");
    expect(() => readCodeFile(tmp, "../etc/passwd")).toThrow(/bad path/);
    expect(() => readCodeFile(tmp, "img.png")).toThrow(/binary/);
    expect(() => readCodeFile(tmp, "node_modules/x/index.js")).toThrow(/bad path/);
  });

  it("runs a check and reports pass, fail and time-out", async () => {
    const ok = await runCheck({ cwd: tmp, command: "echo building && echo done", source: "team", trigger: "manual", sourceVersion: null, shell: "/bin/sh" }).done;
    expect(ok).toMatchObject({ status: "passed", exitCode: 0 });
    expect(ok.output).toContain("building");
    const bad = await runCheck({ cwd: tmp, command: "echo 'FAIL: 1 test' >&2; exit 3", source: "team", trigger: "manual", sourceVersion: null, shell: "/bin/sh" }).done;
    expect(bad).toMatchObject({ status: "failed", exitCode: 3 });
    expect(bad.output).toContain("FAIL: 1 test");
    const slow = await runCheck({ cwd: tmp, command: "sleep 5", source: "team", trigger: "manual", sourceVersion: null, shell: "/bin/sh", timeoutMs: 200 }).done;
    expect(slow.status).toBe("failed");
    expect(slow.output).toContain("Stopped after");
  });
});

describe("source-code outputs in a run", () => {
  let tmp: string;
  let project: string;
  const team: FactoryTeam = {
    name: "code-team", title: "Code Team", summary: "", workflow: "sequential", createdAt: "", updatedAt: "",
    members: [{
      id: "dev", title: "Fullstack Engineer", role: "dev", runtime: "claude-code", instructions: "", skills: [], customSkills: [],
      deliverables: [
        { id: "backend", title: "Backend source code", path: "backend", outline: "", acceptance: "", kind: "code", check: "test -f ok.txt && echo all good" },
        { id: "report", title: "Implementation Report", path: "docs/report.md", outline: "", acceptance: "" },
      ],
    }],
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "code-run-"));
    project = join(tmp, "project");
    mkdirSync(project);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function service() {
    const store = new FactoryRunStore(join(tmp, "runs"));
    const svc = new FactoryRunService({
      store, dispatch: async () => ({ status: 200, data: [] }), teamDir: () => tmp, readTeam: () => team,
      checks: { shell: "/bin/sh", quietMs: 0, scanCacheMs: 0 },
    });
    const run = store.create({ team: team.name, teamTitle: team.title, task: "Build it", projectDir: project });
    store.update(run.id, (r) => { r.status = "running"; });
    return { svc, id: run.id };
  }

  it("checks the code on its own once the member has handed everything in, and again after a change", async () => {
    const { svc, id } = service();
    mkdirSync(join(project, "backend", "node_modules"), { recursive: true });
    writeFileSync(join(project, "backend", "server.js"), "console.log(1)");
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(project, "backend", "server.js"), old, old);
    let d = await svc.detail(id);
    const code = d.members[0]!.deliverables[0]!;
    expect(code).toMatchObject({ kind: "code", exists: true, files: 1, checkCommand: "test -f ok.txt && echo all good" });
    expect(code.check).toBeNull(); // the report isn't written yet: no hand-off, no check

    mkdirSync(join(project, "docs"));
    writeFileSync(join(project, "docs", "report.md"), "# Report");
    d = await svc.detail(id);
    expect(d.members[0]!.deliverables[0]!.check?.status).toBe("running");
    await svc.checkSettled(id, "dev", "backend");
    d = await svc.detail(id);
    expect(d.members[0]!.deliverables[0]!.check).toMatchObject({ status: "failed", trigger: "auto", source: "team" });

    // The same files aren't checked twice; a change is.
    expect((await svc.detail(id)).members[0]!.deliverables[0]!.check?.status).toBe("failed");
    writeFileSync(join(project, "backend", "ok.txt"), "fixed");
    const past = new Date(Date.now() - 60_000);
    const recent = new Date(Date.now() - 10_000);
    utimesSync(join(project, "backend", "ok.txt"), recent, recent);
    const store = (svc as unknown as { opts: { store: FactoryRunStore } }).opts.store;
    store.update(id, (r) => { r.checks!["dev/backend"]!.finishedAt = past.toISOString(); });
    d = await svc.detail(id);
    await svc.checkSettled(id, "dev", "backend");
    d = await svc.detail(id);
    expect(d.members[0]!.deliverables[0]!.check).toMatchObject({ status: "passed" });
    expect(d.members[0]!.deliverables[0]!.check?.output).toContain("all good");
    expect(d.run.events.some((e) => e.kind === "check" && /passed/.test(e.message))).toBe(true);
  });

  it("doesn't count files the check itself writes as a change", async () => {
    const { svc, id } = service();
    mkdirSync(join(project, "backend"), { recursive: true });
    writeFileSync(join(project, "backend", "server.js"), "x");
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(project, "backend", "server.js"), old, old);
    (team.members[0]!.deliverables[0] as { check?: string }).check = "echo lock > package-lock.json && test -f ok.txt";
    svc.checkNow(id, "dev", "backend");
    await svc.checkSettled(id, "dev", "backend");
    const d = await svc.detail(id);
    const code = d.members[0]!.deliverables[0]!;
    expect(code.check!.sourceVersion).toBe(code.modifiedAt);
    (team.members[0]!.deliverables[0] as { check?: string }).check = "test -f ok.txt && echo all good";
  });

  it("runs a check on request, lists the folder and reads files", async () => {
    const { svc, id } = service();
    mkdirSync(join(project, "backend", "src"), { recursive: true });
    writeFileSync(join(project, "backend", "src", "app.ts"), "export {};\n");
    writeFileSync(join(project, "backend", "ok.txt"), "");
    const started = svc.checkNow(id, "dev", "backend");
    expect(started.status).toBe("running");
    expect(() => svc.checkNow(id, "dev", "backend")).toThrow(/already running/);
    await svc.checkSettled(id, "dev", "backend");
    expect(svc.store.get(id)!.checks!["dev/backend"]!.status).toBe("passed");
    expect(svc.codeTree(id, "dev", "backend").files.map((f) => f.path)).toEqual(["ok.txt", "src/app.ts"]);
    expect(svc.codeFile(id, "dev", "backend", "src/app.ts").content).toBe("export {};\n");
    expect(() => svc.codeFile(id, "dev", "backend", "../../etc/hosts")).toThrow();
    expect(() => svc.readDeliverable(id, "dev", "backend")).toThrow(/folder of source code/);
  });
});

describe("code outputs in a team", () => {
  it("validates kind and check, and tells the agent the folder, the check and to pass it before hand-off", () => {
    const parsed = parseFactoryTeamInput({
      name: "t", title: "T", members: [{ id: "dev", title: "Dev", deliverables: [
        { id: "fe", title: "Frontend source code", path: "frontend", kind: "code", check: "npm ci && npm run build" },
        { id: "be", title: "Backend source code", path: "backend", kind: "code" },
      ] }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.team.members[0]!.deliverables[0]).toMatchObject({ kind: "code", check: "npm ci && npm run build" });
    expect(parseFactoryTeamInput({ name: "t", title: "T", members: [{ id: "a", title: "A", deliverables: [{ id: "x", title: "X", path: "x", kind: "video" }] }] }).ok).toBe(false);

    const { files } = generateTeamFiles({ ...parsed.team, createdAt: "", updatedAt: "" }, { sharedAgentDir: SHARED_AGENT_DIR, sharedSkillIds: new Set(), resolveSkill: () => null });
    const guide = (files.get("agents/dev/guidance/deliverables.md") as { content: string }).content;
    expect(guide).toContain("Frontend source code (source code)");
    expect(guide).toContain("cd 'frontend' && npm ci && npm run build");
    expect(guide).toContain("backend/factory-check.sh");
    expect(guide).toContain("Hand off only when it passes");
  });
});
