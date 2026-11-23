// Agent API settings — one Anthropic API key, base URL and model that every Claude Code agent uses.
//
// Stored under $OPENRIG_HOME/agent-api/:
//   settings.json  { baseUrl?, model?, updatedAt }   (no secrets)
//   api-key        the key, mode 0600
//
// When nothing is saved, the daemon's own environment (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL,
// ANTHROPIC_MODEL) is used; its key is copied to a private file so a launch never puts it on a
// command line. Agents get the key through Claude Code's `apiKeyHelper`, which reads that file:
// an ANTHROPIC_API_KEY variable would stop every new agent at Claude Code's "use this API key?" prompt.

import fs from "node:fs";
import path from "node:path";
import { getOpenRigHome } from "../openrig-compat.js";
import { shellQuote } from "../adapters/shell-quote.js";

export interface AgentApiSettingsView {
  /** Where the active values come from. "none": no key anywhere, agents can't start. */
  source: "settings" | "environment" | "none";
  hasKey: boolean;
  /** Last 4 characters of the active key, for recognising it. Never the key itself. */
  keyHint: string | null;
  baseUrl: string | null;
  model: string | null;
  /** What is saved in Settings (null: not saved, the environment's value applies). */
  saved: { baseUrl: string | null; model: string | null };
  /** The daemon environment's values, shown so the person knows what a reset falls back to. */
  environment: { hasKey: boolean; baseUrl: string | null; model: string | null };
  updatedAt: string | null;
}

export interface AgentApiSettingsInput {
  /** New key. Omitted or "" keeps the saved key. */
  apiKey?: string;
  baseUrl?: string | null;
  model?: string | null;
}

interface StoredSettings { baseUrl?: string; model?: string; updatedAt?: string }

export class AgentApiSettingsError extends Error {
  constructor(readonly field: "apiKey" | "baseUrl" | "model", message: string) {
    super(message);
  }
}

const KEY_RE = /^[!-~]{8,8192}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

function dir(home: string): string { return path.join(home, "agent-api"); }
function settingsFile(home: string): string { return path.join(dir(home), "settings.json"); }
export function agentApiKeyFile(home: string): string { return path.join(dir(home), "api-key"); }
function envKeyFile(home: string): string { return path.join(dir(home), "api-key.env"); }

export function validateBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AgentApiSettingsError("baseUrl", "Base URL must be a full URL, like https://api.anthropic.com"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AgentApiSettingsError("baseUrl", "Base URL must start with https:// or http://");
  if (url.username || url.password || url.search || url.hash) throw new AgentApiSettingsError("baseUrl", "Base URL can't contain a user, password, query or #fragment");
  return value.replace(/\/+$/, "");
}

export function validateModel(value: string): string {
  if (!MODEL_RE.test(value)) throw new AgentApiSettingsError("model", "Model must be a model id such as claude-sonnet-5-5 (letters, digits, . _ - : / @)");
  return value;
}

function validateKey(value: string): string {
  if (!KEY_RE.test(value)) throw new AgentApiSettingsError("apiKey", "The API key must be at least 8 characters, with no spaces or line breaks");
  return value;
}

function readStored(home: string): StoredSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(home), "utf8")) as StoredSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

/** Writes a private file atomically: created 0600, then renamed into place. */
function writePrivate(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function readKey(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0 || st.size > 8192) return null;
    const key = fs.readFileSync(file, "utf8").trim();
    return KEY_RE.test(key) ? key : null;
  } catch { return null; }
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

function safeEnvUrl(value: string | null): string | null {
  if (!value) return null;
  try { return validateBaseUrl(value); } catch { return null; }
}

function safeEnvModel(value: string | null): string | null {
  return value && MODEL_RE.test(value) ? value : null;
}

/** The values agents launch with: saved settings first, then the daemon's environment. */
export function resolveAgentApi(home = getOpenRigHome(), env: NodeJS.ProcessEnv = process.env): {
  source: AgentApiSettingsView["source"]; keyFile: string | null; key: string | null; baseUrl: string | null; model: string | null;
} {
  const stored = readStored(home);
  const savedKey = readKey(agentApiKeyFile(home));
  const envKey = envValue(env, "ANTHROPIC_API_KEY");
  const baseUrl = stored.baseUrl ?? safeEnvUrl(envValue(env, "ANTHROPIC_BASE_URL"));
  const model = stored.model ?? safeEnvModel(envValue(env, "ANTHROPIC_MODEL"));
  if (savedKey) return { source: "settings", keyFile: agentApiKeyFile(home), key: savedKey, baseUrl, model };
  if (envKey && KEY_RE.test(envKey)) {
    // Copy the environment's key to a private file the helper can read; refresh it when it changes.
    const file = envKeyFile(home);
    if (readKey(file) !== envKey) {
      try { writePrivate(file, envKey); } catch { return { source: "none", keyFile: null, key: null, baseUrl, model }; }
    }
    return { source: "environment", keyFile: file, key: envKey, baseUrl, model };
  }
  return { source: "none", keyFile: null, key: null, baseUrl, model };
}

export function readAgentApiSettings(home = getOpenRigHome(), env: NodeJS.ProcessEnv = process.env): AgentApiSettingsView {
  const r = resolveAgentApi(home, env);
  const envKey = envValue(env, "ANTHROPIC_API_KEY");
  const stored = readStored(home);
  return {
    source: r.source,
    hasKey: !!r.key,
    keyHint: r.key ? r.key.slice(-4) : null,
    baseUrl: r.baseUrl,
    model: r.model,
    saved: { baseUrl: stored.baseUrl ?? null, model: stored.model ?? null },
    environment: {
      hasKey: !!envKey,
      baseUrl: safeEnvUrl(envValue(env, "ANTHROPIC_BASE_URL")),
      model: safeEnvModel(envValue(env, "ANTHROPIC_MODEL")),
    },
    updatedAt: stored.updatedAt ?? null,
  };
}

/** Saves the settings. A blank base URL or model removes it (the environment's, if any, applies again). */
export function saveAgentApiSettings(input: AgentApiSettingsInput, home = getOpenRigHome(), env: NodeJS.ProcessEnv = process.env): AgentApiSettingsView {
  const stored = readStored(home);
  const next: StoredSettings = { ...stored };
  if (input.baseUrl !== undefined) {
    const v = input.baseUrl?.trim();
    if (v) next.baseUrl = validateBaseUrl(v); else delete next.baseUrl;
  }
  if (input.model !== undefined) {
    const v = input.model?.trim();
    if (v) next.model = validateModel(v); else delete next.model;
  }
  const key = input.apiKey?.trim();
  if (key) writePrivate(agentApiKeyFile(home), validateKey(key));
  next.updatedAt = new Date().toISOString();
  writePrivate(settingsFile(home), JSON.stringify(next, null, 2) + "\n");
  return readAgentApiSettings(home, env);
}

/** Forgets the saved key (the environment's key, if any, applies again). */
export function clearAgentApiKey(home = getOpenRigHome(), env: NodeJS.ProcessEnv = process.env): AgentApiSettingsView {
  fs.rmSync(agentApiKeyFile(home), { force: true });
  return readAgentApiSettings(home, env);
}

/** The Claude Code `--settings` entries that point an agent at the configured API, or null when no key is set. */
export function agentApiClaudeSettings(home = getOpenRigHome(), env: NodeJS.ProcessEnv = process.env): { apiKeyHelper: string; env: Record<string, string> } | null {
  const r = resolveAgentApi(home, env);
  if (!r.keyFile) return null;
  const vars: Record<string, string> = {};
  if (r.baseUrl) vars["ANTHROPIC_BASE_URL"] = r.baseUrl;
  if (r.model) vars["ANTHROPIC_MODEL"] = r.model;
  return { apiKeyHelper: `/bin/cat ${shellQuote(r.keyFile)}`, env: vars };
}

/** Sends one tiny request with the configured values. Resolves to null when it works, else a readable reason. */
export async function testAgentApi(opts: { home?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<{ ok: boolean; message: string; status?: number }> {
  const r = resolveAgentApi(opts.home, opts.env);
  if (!r.key) return { ok: false, message: "No API key is set." };
  const model = r.model ?? "claude-haiku-5-5";
  const base = r.baseUrl ?? "https://api.anthropic.com";
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": r.key,
        authorization: `Bearer ${r.key}`,
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    if (res.ok) return { ok: true, status: res.status, message: `Connected. ${model} answered at ${new URL(base).host}.` };
    let detail = "";
    try {
      const body = await res.json() as { error?: { message?: string } };
      detail = body?.error?.message ?? "";
    } catch { /* not JSON */ }
    const hint = res.status === 401 || res.status === 403 ? "The key was refused."
      : res.status === 404 ? "The endpoint or model wasn't found. Check the base URL and model."
      : res.status === 400 ? "The request was refused. Check the model name."
      : `The API answered ${res.status}.`;
    return { ok: false, status: res.status, message: detail ? `${hint} ${detail}` : hint };
  } catch (err) {
    const name = (err as Error)?.name;
    return { ok: false, message: name === "TimeoutError" ? `No answer from ${base} within 20 seconds.` : `Couldn't reach ${base}: ${(err as Error).message}` };
  }
}
