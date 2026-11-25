// Agent Workspace — source-code outputs: what is in a code folder, and its build/test check.
//
// A team member can deliver a folder of source code instead of a document. Its check is a shell
// command run inside that folder: the one set in Factory Studio, else the folder's own
// factory-check.sh (the agent writes it), else a guess from the project's manifest
// (package.json, pyproject.toml, go.mod, …). Checks run in the person's login shell with a
// time limit; the last part of their output is kept with the run.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type CheckStatus = "running" | "passed" | "failed" | "error";

export interface CodeCheck {
  status: CheckStatus;
  command: string;
  /** Where the command came from. */
  source: "team" | "factory-check.sh" | "detected";
  trigger: "auto" | "manual";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  /** Last part of stdout+stderr. */
  output: string;
  /** Latest file change in the folder when the check started; a newer change makes the result stale. */
  sourceVersion: string | null;
}

export interface CodeFile { path: string; size: number }

export interface CodeScan {
  files: CodeFile[];
  /** ISO time of the newest file change, or null for an empty/missing folder. */
  latest: string | null;
  truncated: boolean;
}

/** Folders that are installed, generated or private: never listed and never counted as a change. */
export const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache",
  "coverage", ".nyc_output", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".tox", "target",
  ".gradle", ".idea", ".vscode", "vendor", ".dart_tool", "Pods", "obj",
]);

const MAX_FILES = 3000;
const OUTPUT_LIMIT = 200_000;
export const DEFAULT_CHECK_TIMEOUT_MS = 15 * 60 * 1000;

const scanCache = new Map<string, { at: number; scan: CodeScan }>();

/** Lists a code folder (skipping dependencies and build output); cached for a few seconds. */
export function scanCode(abs: string, cacheMs = 4000): CodeScan {
  const hit = scanCache.get(abs);
  if (hit && Date.now() - hit.at < cacheMs) return hit.scan;
  const files: CodeFile[] = [];
  let latest = 0;
  let truncated = false;
  const walk = (dir: string, rel: string) => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (truncated) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), childRel);
      } else if (e.isFile()) {
        if (e.name === ".DS_Store") continue;
        if (files.length >= MAX_FILES) { truncated = true; return; }
        try {
          const st = fs.statSync(path.join(dir, e.name));
          files.push({ path: childRel, size: st.size });
          if (st.mtimeMs > latest) latest = st.mtimeMs;
        } catch { /* vanished while listing */ }
      }
    }
  };
  try {
    if (fs.statSync(abs).isDirectory()) walk(abs, "");
  } catch { /* missing folder */ }
  const scan: CodeScan = { files, latest: latest ? new Date(latest).toISOString() : null, truncated };
  scanCache.set(abs, { at: Date.now(), scan });
  return scan;
}

/** The check to run in a code folder, or null when there is nothing to go on. */
export function resolveCheckCommand(abs: string, configured: string | undefined): { command: string; source: CodeCheck["source"] } | null {
  const explicit = configured?.trim();
  if (explicit) return { command: explicit, source: "team" };
  const has = (f: string) => fs.existsSync(path.join(abs, f));
  if (has("factory-check.sh")) return { command: "bash factory-check.sh", source: "factory-check.sh" };
  if (has("package.json")) {
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const install = pm === "npm" ? (has("package-lock.json") ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund") : `${pm} install`;
    const run = (script: string) => (pm === "yarn" ? `yarn run ${script} --if-present` : `${pm} run --if-present ${script}`);
    return { command: `${install} && ${run("build")} && ${run("test")}`, source: "detected" };
  }
  if (has("pyproject.toml") || has("requirements.txt")) {
    const install = has("requirements.txt") ? "python3 -m pip install -q -r requirements.txt" : "python3 -m pip install -q -e .";
    return { command: `${install} && python3 -m pytest -q`, source: "detected" };
  }
  if (has("go.mod")) return { command: "go build ./... && go test ./...", source: "detected" };
  if (has("Cargo.toml")) return { command: "cargo build && cargo test", source: "detected" };
  if (has("pom.xml")) return { command: has("mvnw") ? "./mvnw -q -B verify" : "mvn -q -B verify", source: "detected" };
  if (has("build.gradle") || has("build.gradle.kts")) return { command: has("gradlew") ? "./gradlew build" : "gradle build", source: "detected" };
  try {
    if (fs.readdirSync(abs).some((n) => n.endsWith(".sln") || n.endsWith(".csproj"))) return { command: "dotnet build && dotnet test", source: "detected" };
  } catch { /* missing */ }
  return null;
}

/** Reads one text file of a code folder, refusing paths outside it and binary files. */
export function readCodeFile(rootAbs: string, rel: string, maxBytes = 1024 * 1024): { content: string; size: number } {
  if (!rel || rel.includes("\0") || path.isAbsolute(rel)) throw new Error("bad path");
  const root = fs.realpathSync(rootAbs);
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep)) throw new Error("bad path");
  const real = fs.realpathSync(target);
  if (!real.startsWith(root + path.sep)) throw new Error("bad path");
  if (rel.split("/").some((part) => IGNORED_DIRS.has(part))) throw new Error("bad path");
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error("not a file");
  if (st.size > maxBytes) throw new Error(`too large (${Math.round(st.size / 1024)} KB)`);
  const buf = fs.readFileSync(real);
  if (buf.subarray(0, 8000).includes(0)) throw new Error("binary file");
  return { content: buf.toString("utf8"), size: st.size };
}

export interface RunningCheck {
  child: ChildProcess;
  done: Promise<CodeCheck>;
}

/** Runs a check in the person's login shell; resolves with the finished result. */
export function runCheck(opts: {
  cwd: string;
  command: string;
  source: CodeCheck["source"];
  trigger: CodeCheck["trigger"];
  sourceVersion: string | null;
  timeoutMs?: number;
  shell?: string;
  onStart?: (check: CodeCheck) => void;
}): RunningCheck {
  const startedAt = new Date();
  const base: CodeCheck = {
    status: "running", command: opts.command, source: opts.source, trigger: opts.trigger,
    startedAt: startedAt.toISOString(), output: "", sourceVersion: opts.sourceVersion,
  };
  opts.onStart?.(base);
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const k of Object.keys(env)) if (k.startsWith("ANTHROPIC_") || k.startsWith("OPENRIG_")) delete env[k];
  const shell = opts.shell ?? process.env.SHELL ?? "/bin/bash";
  // The login profile may put another (or a broken) node first; the daemon's own Node goes in front, after the profile ran.
  const nodeBin = path.dirname(process.execPath).replace(/'/g, "'\"'\"'");
  const script = `export PATH='${nodeBin}':"$PATH"; ${opts.command}`;
  const child = spawn(shell, ["-lc", script], { cwd: opts.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.length > OUTPUT_LIMIT * 1.5) output = output.slice(-OUTPUT_LIMIT);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  let timedOut = false;
  const kill = (signal: NodeJS.Signals) => {
    try { if (child.pid) process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill("SIGTERM");
    setTimeout(() => kill("SIGKILL"), 5000).unref();
  }, opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);
  timer.unref();
  const done = new Promise<CodeCheck>((resolve) => {
    const finish = (code: number | null, error?: string) => {
      clearTimeout(timer);
      const finishedAt = new Date();
      const tail = output.length > OUTPUT_LIMIT ? `…(earlier output cut)\n${output.slice(-OUTPUT_LIMIT)}` : output;
      const note = timedOut ? `\n\n[Factory Studio] Stopped after ${Math.round((opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS) / 60000)} minutes.` : error ? `\n\n[Factory Studio] ${error}` : "";
      resolve({
        ...base,
        status: error ? "error" : code === 0 && !timedOut ? "passed" : "failed",
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        exitCode: code,
        output: tail + note,
      });
    };
    child.on("error", (err) => finish(null, `Could not start the check: ${err.message}`));
    child.on("close", (code) => finish(code));
  });
  return { child, done };
}
