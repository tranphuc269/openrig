import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentApiClaudeSettings, agentApiKeyFile, clearAgentApiKey, readAgentApiSettings, saveAgentApiSettings, testAgentApi,
} from "../src/domain/agent-api-settings.js";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";

describe("agent API settings", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agent-api-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("saves the key privately and only ever shows its last 4 characters", () => {
    const view = saveAgentApiSettings({ apiKey: "sk-ant-secret-wxyz", baseUrl: "https://gw.example.com/anthropic/", model: "claude-sonnet-5-5" }, home, {});
    expect(view).toMatchObject({ source: "settings", hasKey: true, keyHint: "wxyz", baseUrl: "https://gw.example.com/anthropic", model: "claude-sonnet-5-5" });
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(statSync(agentApiKeyFile(home)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, "agent-api", "settings.json"), "utf8")).not.toContain("secret");
  });

  it("keeps the saved key when the key field is left blank, and clears base URL/model when blank", () => {
    saveAgentApiSettings({ apiKey: "sk-ant-first-1111", baseUrl: "https://a.example.com", model: "m-1" }, home, {});
    const view = saveAgentApiSettings({ apiKey: "", baseUrl: "", model: "" }, home, {});
    expect(view).toMatchObject({ hasKey: true, keyHint: "1111", baseUrl: null, model: null });
  });

  it("refuses bad values", () => {
    expect(() => saveAgentApiSettings({ apiKey: "has space in it" }, home, {})).toThrow(/API key/);
    expect(() => saveAgentApiSettings({ baseUrl: "ftp://x" }, home, {})).toThrow(/https/);
    expect(() => saveAgentApiSettings({ baseUrl: "https://u:p@x.com" }, home, {})).toThrow(/password/);
    expect(() => saveAgentApiSettings({ model: "bad model; rm -rf" }, home, {})).toThrow(/Model/);
  });

  it("falls back to the daemon's ANTHROPIC_* environment, copying the key to a private file", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-from-env-9876", ANTHROPIC_BASE_URL: "https://proxy.example.com", ANTHROPIC_MODEL: "claude-opus-5-5" };
    expect(readAgentApiSettings(home, env)).toMatchObject({ source: "environment", keyHint: "9876", baseUrl: "https://proxy.example.com", model: "claude-opus-5-5" });
    const s = agentApiClaudeSettings(home, env)!;
    expect(s.env).toEqual({ ANTHROPIC_BASE_URL: "https://proxy.example.com", ANTHROPIC_MODEL: "claude-opus-5-5" });
    expect(s.apiKeyHelper).toContain("api-key.env");
    expect(s.apiKeyHelper).not.toContain("sk-ant");
    expect(statSync(join(home, "agent-api", "api-key.env")).mode & 0o777).toBe(0o600);
    // Saved settings win over the environment; clearing the saved key falls back again.
    saveAgentApiSettings({ apiKey: "sk-ant-saved-0000", model: "claude-haiku-5-5" }, home, env);
    expect(readAgentApiSettings(home, env)).toMatchObject({ source: "settings", keyHint: "0000", model: "claude-haiku-5-5" });
    expect(clearAgentApiKey(home, env)).toMatchObject({ source: "environment", keyHint: "9876" });
    expect(existsSync(agentApiKeyFile(home))).toBe(false);
  });

  it("has nothing to give a launch without a key", () => {
    expect(agentApiClaudeSettings(home, {})).toBeNull();
    expect(readAgentApiSettings(home, {})).toMatchObject({ source: "none", hasKey: false, keyHint: null });
  });

  it("tests the connection with one tiny request and explains a refusal", async () => {
    saveAgentApiSettings({ apiKey: "sk-ant-test-5555", baseUrl: "https://gw.example.com", model: "claude-sonnet-5-5" }, home, {});
    const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const ok = await testAgentApi({ home, env: {}, fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch });
    expect(ok.ok).toBe(true);
    expect(seen[0]).toMatchObject({ url: "https://gw.example.com/v1/messages", body: { model: "claude-sonnet-5-5", max_tokens: 1 } });
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-ant-test-5555");
    const bad = await testAgentApi({ home, env: {}, fetchImpl: (async () =>
      new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })) as unknown as typeof fetch });
    expect(bad).toMatchObject({ ok: false, status: 401 });
    expect(bad.message).toContain("refused");
  });

  it("gives every Claude launch the key through apiKeyHelper, and the base URL and model through env", () => {
    const before = process.env.OPENRIG_HOME;
    const envKey = process.env.ANTHROPIC_API_KEY;
    process.env.OPENRIG_HOME = home;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const plain = operationalLaunchArgs("claude-code", {} as never);
      expect(JSON.stringify(plain)).not.toContain("apiKeyHelper");
      saveAgentApiSettings({ apiKey: "sk-ant-launch-7777", baseUrl: "https://gw.example.com", model: "claude-sonnet-5-5" }, home, {});
      const args = operationalLaunchArgs("claude-code", { claudeAutoMode: undefined } as never);
      const at = args.indexOf("--settings");
      expect(at).toBeGreaterThanOrEqual(0);
      const settings = JSON.parse(args[at + 1]!) as { apiKeyHelper: string; env: Record<string, string> };
      expect(settings.apiKeyHelper).toBe(`/bin/cat '${agentApiKeyFile(home)}'`);
      expect(settings.env).toMatchObject({ ANTHROPIC_BASE_URL: "https://gw.example.com", ANTHROPIC_MODEL: "claude-sonnet-5-5" });
      expect(args.join(" ")).not.toContain("sk-ant-launch");
      // Codex launches are untouched.
      expect(JSON.stringify(operationalLaunchArgs("codex", {} as never))).not.toContain("apiKeyHelper");
    } finally {
      if (before === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = before;
      if (envKey !== undefined) process.env.ANTHROPIC_API_KEY = envKey;
    }
  });
});
