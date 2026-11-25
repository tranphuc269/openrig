import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveAgentApiSettings } from "../src/domain/agent-api-settings.js";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { factoryRoutes } from "../src/routes/factory.js";
import type { ShellLookup } from "../src/domain/factory-studio/readiness.js";

describe("factory readiness + folder picker", () => {
  let tmp: string;
  let home: string;
  let installed: Record<string, string>;
  let defaultPerson: string | null;
  let usageWindows: boolean;
  let usageRows: unknown[] | undefined;
  let rigHelp: string | null;

  const lookup: ShellLookup = async (cmd) => (installed[cmd] ? { path: installed[cmd]!, version: `${cmd} 1.0` } : { path: null, version: null });
  const dispatch = async (_m: string, p: string) => {
    if (p === "/api/provider/status") return { status: 200, data: usageRows ? { usage: usageRows } : {} };
    if (p === "/api/config") return { status: 200, data: { settings: { "provider.usage_windows": { value: usageWindows } } } };
    if (p === "/api/gateway/participants") return { status: 200, data: { default: { id: defaultPerson } } };
    return { status: 404, data: {} };
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "factory-ready-"));
    rigHelp = "  docx --style <form.docx> --content <draft.md> --out <file.docx>";
    home = join(tmp, "openrig-home");
    mkdirSync(home);
    installed = { tmux: "/opt/homebrew/bin/tmux", claude: "/usr/local/bin/claude" };
    defaultPerson = null;
    usageWindows = false;
    usageRows = undefined;
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function app() {
    const a = new Hono();
    a.route("/api/factory", factoryRoutes({
      teamsRoot: () => join(tmp, "teams"), runsRoot: join(tmp, "runs"), dispatch: dispatch as never,
      readiness: { lookup, home, rigProbe: async () => rigHelp },
      agentApiHome: home,
    }));
    return a;
  }
  const req = (method: string, url: string, body?: unknown) =>
    app().request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const byId = (checks: Array<{ id: string }>, id: string) => checks.find((c) => c.id === id) as Record<string, unknown>;

  it("reports what blocks a team: rig missing from the login shell and no API key are required failures", async () => {
    const r = await (await req("GET", "/api/factory/readiness")).json() as { ready: boolean; checks: Array<{ id: string }> };
    expect(r.ready).toBe(false);
    expect(byId(r.checks, "rig")).toMatchObject({ state: "fail", required: true });
    expect(byId(r.checks, "tmux")).toMatchObject({ state: "ok" });
    expect(byId(r.checks, "agent-api")).toMatchObject({ state: "fail", required: true, fixAction: "open-settings" });
    expect(byId(r.checks, "person")).toMatchObject({ state: "warn", fixAction: "register-person" });
    expect(byId(r.checks, "usage")).toMatchObject({ state: "warn", fixAction: "enable-usage" });
    // Sign-in and Codex aren't checked any more: agents run on the API key from Settings.
    expect(byId(r.checks, "codex")).toBeUndefined();
    expect(byId(r.checks, "claude-sign-in")).toBeUndefined();
  });

  it("is ready once the required tools and an API key are there, and shows the key's last 4 characters only", async () => {
    installed.rig = "/usr/local/bin/rig";
    defaultPerson = "linh";
    saveAgentApiSettings({ apiKey: "sk-ant-secret-abcd", model: "claude-sonnet-5-5" }, home, {});
    const r = await (await req("GET", "/api/factory/readiness")).json() as { ready: boolean; checks: Array<{ id: string }> };
    expect(r.ready).toBe(true);
    const api = byId(r.checks, "agent-api");
    expect(api).toMatchObject({ state: "ok" });
    expect(String(api.detail)).toContain("••••abcd");
    expect(String(api.detail)).toContain("claude-sonnet-5-5");
    expect(JSON.stringify(r)).not.toContain("sk-ant-secret");
    expect(byId(r.checks, "person")).toMatchObject({ state: "ok" });
  });

  it("fails when the rig agents run is older than this OpenRig (no rig office --style)", async () => {
    installed.rig = "/usr/local/bin/rig";
    saveAgentApiSettings({ apiKey: "sk-ant-test-1234" }, home, {});
    rigHelp = "error: unknown command 'office'";
    const report = await (await req("GET", "/api/factory/readiness")).json() as { ready: boolean; checks: Array<{ id: string; state: string; detail: string }> };
    const rig = report.checks.find((c) => c.id === "rig")!;
    expect(rig.state).toBe("fail");
    expect(rig.detail).toContain("older than this OpenRig");
    expect(report.ready).toBe(false);
  });

  it("requires Claude Code", async () => {
    installed = { tmux: "/t", rig: "/r" };
    const r = await (await req("GET", "/api/factory/readiness")).json() as { ready: boolean; checks: Array<{ id: string }> };
    expect(r.ready).toBe(false);
    expect(byId(r.checks, "claude")).toMatchObject({ state: "fail", required: true });
  });

  it("registers the person agents ask, as the default, and refuses bad or duplicate ids", async () => {
    expect((await req("POST", "/api/factory/readiness/person", { entityId: "Bad Id", displayName: "Linh" })).status).toBe(400);
    const res = await req("POST", "/api/factory/readiness/person", { entityId: "linh", displayName: "Linh Nguyen" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, address: "linh@external" });
    const human = parse(readFileSync(join(home, "gateway", "humans", "linh.yaml"), "utf-8"));
    expect(human).toMatchObject({ entityId: "linh", displayName: "Linh Nguyen", prefs: { deliveryClass: "B" } });
    expect(parse(readFileSync(join(home, "gateway", "participants.yaml"), "utf-8")).default).toBe("linh");
    expect((await req("POST", "/api/factory/readiness/person", { entityId: "linh", displayName: "Again" })).status).toBe(400);
  });

  it("lists sub-folders, checks a folder and creates one only inside home", async () => {
    mkdirSync(join(tmp, "proj", ".git"), { recursive: true });
    mkdirSync(join(tmp, "notes"));
    mkdirSync(join(tmp, ".hidden"));
    const list = await (await req("GET", `/api/factory/fs/folders?path=${encodeURIComponent(tmp)}`)).json() as { entries: Array<{ name: string; isGitRepo: boolean }>; parent: string };
    expect(list.entries.map((e) => e.name)).toEqual(expect.arrayContaining(["notes", "proj"]));
    expect(list.entries.find((e) => e.name === ".hidden")).toBeUndefined();
    expect(list.entries.find((e) => e.name === "proj")?.isGitRepo).toBe(true);

    expect(await (await req("GET", `/api/factory/fs/check?path=${encodeURIComponent(join(tmp, "proj"))}`)).json()).toMatchObject({ valid: true, isGitRepo: true });
    expect(await (await req("GET", `/api/factory/fs/check?path=${encodeURIComponent(join(tmp, "nope"))}`)).json()).toMatchObject({ valid: false });
    expect(await (await req("GET", "/api/factory/fs/check?path=relative")).json()).toMatchObject({ valid: false });

    expect((await req("POST", "/api/factory/fs/folders", { path: join(tmp, "new-project") })).status).toBe(400);
    expect(existsSync(join(tmp, "new-project"))).toBe(false);
  });
});
