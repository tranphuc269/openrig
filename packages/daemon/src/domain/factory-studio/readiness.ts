// Readiness — "can a team actually run on this machine?" in one read, for the web UI.
//
// Every check is a fact read now (a login-shell lookup, a file, a setting, the provider read model),
// never a guess. Tool lookups run in a login shell (`bash -lc`) because that is the PATH the agents'
// own shells get: `rig` being on your interactive PATH (an alias, say) doesn't mean agents can run it.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addHumanFragment, showHuman } from "../gateway/human-registry.js";
import { channelStateDigest, runChannelOperation } from "../gateway/channel-operations.js";
import { setDefaultPerson } from "../gateway/participants.js";
import { readAgentApiSettings } from "../agent-api-settings.js";

export type CheckState = "ok" | "warn" | "fail" | "unknown";

export interface ReadinessCheck {
  id: string;
  title: string;
  state: CheckState;
  detail: string;
  /** Shell command the person can run to fix it, when there is one. */
  fixCommand?: string;
  /** In-app fix the UI offers (it calls the matching endpoint). */
  fixAction?: "register-person" | "enable-usage" | "open-settings";
  required: boolean;
}

export interface ReadinessReport {
  checkedAt: string;
  ready: boolean;
  checks: ReadinessCheck[];
}

export type Dispatch = (method: "GET" | "POST", apiPath: string, body?: unknown) => Promise<{ status: number; data: unknown }>;

export type ShellLookup = (command: string) => Promise<{ path: string | null; version: string | null }>;

/** Where a command resolves in a login shell, and its first version line. */
export const loginShellLookup: ShellLookup = (command) =>
  new Promise((resolve) => {
    if (!/^[a-z0-9_-]+$/i.test(command)) return resolve({ path: null, version: null });
    const script = `p=$(command -v ${command}) && echo "$p" && (${command} --version 2>/dev/null || ${command} -V 2>/dev/null) | head -n 1`;
    execFile("bash", ["-lc", script], { timeout: 8_000, env: { ...process.env, TERM: "dumb" } }, (err, stdout) => {
      const lines = String(stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (err && lines.length === 0) return resolve({ path: null, version: null });
      resolve({ path: lines[0] ?? null, version: lines[1] ?? null });
    });
  });

function nodeCheck(): ReadinessCheck {
  const major = Number(process.versions.node.split(".")[0]);
  const ok = major === 22 || major === 24;
  return {
    id: "node",
    title: "Node.js",
    state: ok ? "ok" : "warn",
    detail: ok ? `Node ${process.versions.node}` : `Node ${process.versions.node} is not a supported version (22 or 24).`,
    ...(ok ? {} : { fixCommand: "nvm install 22 && nvm use 22" }),
    required: false,
  };
}

async function toolCheck(lookup: ShellLookup, cmd: string, title: string, opts: { required: boolean; fix: string; missing: string }): Promise<ReadinessCheck> {
  const found = await lookup(cmd);
  return found.path
    ? { id: cmd, title, state: "ok", detail: found.version ? `${found.version} · ${found.path}` : found.path, required: opts.required }
    : { id: cmd, title, state: opts.required ? "fail" : "warn", detail: opts.missing, fixCommand: opts.fix, required: opts.required };
}

export async function readReadiness(opts: { dispatch: Dispatch; lookup?: ShellLookup; agentApiHome?: string }): Promise<ReadinessReport> {
  const lookup = opts.lookup ?? loginShellLookup;
  const [rig, tmux, claude, config, people] = await Promise.all([
    lookup("rig"),
    lookup("tmux"),
    lookup("claude"),
    opts.dispatch("GET", "/api/config").catch(() => ({ status: 0, data: null })),
    opts.dispatch("GET", "/api/gateway/participants").catch(() => ({ status: 0, data: null })),
  ]);
  const once: ShellLookup = async (c) => ({ rig, tmux, claude }[c as "rig"] ?? { path: null, version: null });

  const checks: ReadinessCheck[] = [];
  checks.push(nodeCheck());
  checks.push(await toolCheck(once, "tmux", "tmux", { required: true, fix: "brew install tmux", missing: "Agents run inside tmux, and it isn't installed." }));
  checks.push(await toolCheck(once, "rig", "rig command for agents", {
    required: true,
    fix: "npm install -g ./packages/cli   # from your openrig checkout",
    missing: "Agents can't find `rig` in their login shell, so they can't hand work to each other or ask you questions. An alias in ~/.zshrc doesn't count.",
  }));
  checks.push(await toolCheck(once, "claude", "Claude Code", { required: true, fix: "npm install -g @anthropic-ai/claude-code", missing: "Not installed. Every agent runs on Claude Code." }));

  // Agents run on the Anthropic API key, base URL and model from Settings, not on a Claude/Codex sign-in.
  const api = readAgentApiSettings(opts.agentApiHome);
  checks.push(api.hasKey
    ? {
        id: "agent-api",
        title: "Anthropic API key for agents",
        state: "ok",
        detail: `Key ••••${api.keyHint}${api.source === "environment" ? " from the daemon's environment" : ""} · ${api.model ?? "Claude Code's default model"} · ${api.baseUrl ?? "api.anthropic.com"}`,
        required: true,
      }
    : {
        id: "agent-api",
        title: "Anthropic API key for agents",
        state: "fail",
        detail: "Agents can't start without an API key. Add it in Settings, or start the daemon with ANTHROPIC_API_KEY set.",
        fixAction: "open-settings",
        required: true,
      });

  const settings = ((config.data as { settings?: Record<string, { value?: unknown }> } | null)?.settings) ?? {};
  const defaultPerson = ((people.data as { default?: { id?: string | null } } | null)?.default?.id) ?? null;
  checks.push(defaultPerson
    ? { id: "person", title: "You're registered as the person agents ask", state: "ok", detail: `Questions go to ${defaultPerson}.`, required: false }
    : {
        id: "person",
        title: "You're registered as the person agents ask",
        state: "warn",
        detail: "No person is registered, so agents can't send you questions or approvals. They can only stop and wait at a prompt.",
        fixAction: "register-person",
        fixCommand: 'rig gateway human add <id> --display-name "<Your name>" --delivery-class B --default',
        required: false,
      });

  const usageOn = settings["provider.usage_windows"]?.value === true;
  checks.push(usageOn
    ? { id: "usage", title: "Plan-limit tracking", state: "ok", detail: "On: Usage & cost shows how much of your limits is left.", required: false }
    : { id: "usage", title: "Plan-limit tracking", state: "warn", detail: "Off: Usage & cost won't show plan limits. With an API key, cost is still tracked per task.", fixAction: "enable-usage", fixCommand: "rig config set provider.usage_windows true", required: false });

  return {
    checkedAt: new Date().toISOString(),
    ready: checks.every((c) => !c.required || c.state === "ok"),
    checks,
  };
}

const ENTITY = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Register the person agents ask (what `rig gateway human add <id> --display-name … --delivery-class B --default` does). */
export async function registerDefaultPerson(input: { entityId: unknown; displayName: unknown }, home?: string) {
  const entityId = typeof input.entityId === "string" ? input.entityId.trim().toLowerCase() : "";
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (!ENTITY.test(entityId)) return { ok: false as const, error: "Use a short id: lowercase letters, numbers and hyphens (e.g. linh)." };
  if (!displayName || displayName.length > 80) return { ok: false as const, error: "Enter your name (up to 80 characters)." };
  const fragment = {
    entityId,
    class: "human",
    displayName,
    address: `${entityId}@external`,
    connectorBindings: [],
    prefs: { deliveryClass: "B" },
  };
  const before = showHuman(entityId, home);
  if (before.ok) return { ok: false as const, error: `"${entityId}" is already registered. Pick another id.` };
  const result = await runChannelOperation({
    actor: "openrig-web-ui",
    provenance: "claimed:v1",
    reason: "register human delivery (web UI readiness)",
    action: "binding",
    subject: `${entityId}@external`,
    before: { digest: channelStateDigest(null) },
    run: async () => {
      const res = addHumanFragment(fragment, home);
      if (!res.ok) throw new Error(res.error);
      return { value: res, after: { digest: channelStateDigest(res.fragment.connectorBindings) }, effect: "applied" as const };
    },
  }, home);
  const def = setDefaultPerson(entityId, home);
  if (!def.ok) return { ok: false as const, error: `Registered, but couldn't make ${entityId} the default: ${def.error}` };
  return { ok: true as const, entityId, address: `${entityId}@external`, path: result.value.path };
}

// ── Folder picker ──────────────────────────────────────────────────────
export interface FolderEntry { name: string; path: string; isGitRepo: boolean }

export function listFolders(raw: unknown): { path: string; parent: string | null; home: string; entries: FolderEntry[] } {
  const home = os.homedir();
  const dir = typeof raw === "string" && raw.trim() ? path.resolve(raw.trim()) : home;
  const entries: FolderEntry[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith(".") || d.name === "node_modules") continue;
    const full = path.join(dir, d.name);
    entries.push({ name: d.name, path: full, isGitRepo: fs.existsSync(path.join(full, ".git")) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, home, entries: entries.slice(0, 500) };
}

export function checkFolder(raw: unknown) {
  const p = typeof raw === "string" ? raw.trim() : "";
  if (!p || !path.isAbsolute(p)) return { path: p, valid: false, reason: "Use a full path that starts with /." };
  const resolved = path.resolve(p);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { path: resolved, valid: false, reason: "This folder doesn't exist yet." };
  }
  if (!stat.isDirectory()) return { path: resolved, valid: false, reason: "This is a file, not a folder." };
  let writable = true;
  try {
    fs.accessSync(resolved, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  return {
    path: resolved,
    valid: writable && resolved !== path.parse(resolved).root,
    reason: !writable ? "The team can't write to this folder." : resolved === path.parse(resolved).root ? "Pick a project folder, not the filesystem root." : null,
    isGitRepo: fs.existsSync(path.join(resolved, ".git")),
    hasDocs: fs.existsSync(path.join(resolved, "docs")),
  };
}

export function createFolder(raw: unknown) {
  const p = typeof raw === "string" ? raw.trim() : "";
  if (!p || !path.isAbsolute(p)) return { ok: false as const, error: "Use a full path that starts with /." };
  const resolved = path.resolve(p);
  const home = os.homedir();
  if (!resolved.startsWith(home + path.sep)) return { ok: false as const, error: "New folders can only be created inside your home folder." };
  fs.mkdirSync(resolved, { recursive: true });
  return { ok: true as const, path: resolved };
}
