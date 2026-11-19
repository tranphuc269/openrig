// Agent Workspace — runs a Factory Studio team on a task.
//
// Launching, messaging and stopping go through the daemon's own HTTP routes
// (POST /api/up, /api/transport/send, /api/down …) via an in-process
// dispatcher, so a run behaves exactly like `rig up` + `rig send` from the CLI.

import * as fs from "node:fs";
import * as path from "node:path";
import type { FactoryMember, FactoryTeam } from "./team.js";
import { sessionFor } from "./generator.js";
import { FactoryRunStore, reviewKey, type FactoryRun, type ReviewDecision } from "./run-store.js";

export type Dispatch = (method: "GET" | "POST", apiPath: string, body?: unknown) => Promise<{ status: number; data: unknown }>;

export class RunError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 502, readonly code: string, message: string) {
    super(message);
  }
}

export interface RunServiceOpts {
  store: FactoryRunStore;
  dispatch: Dispatch;
  /** Folder of a saved team (holds rig.yaml). */
  teamDir: (name: string) => string;
  readTeam: (name: string) => FactoryTeam | null;
  /** Poll interval and limit while waiting for seats to start. */
  pollMs?: number;
  readyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SeatState {
  sessionStatus: string | null;
  startupStatus: string | null;
  activity: string | null;
}

export type MemberPhase = "waiting" | "working" | "needs_input" | "delivered" | "approved" | "rework" | "offline";
export type RunPhase = "launching" | "failed" | "stopped" | "working" | "review" | "approved";

export interface DeliverableState {
  id: string;
  title: string;
  path: string;
  exists: boolean;
  size: number | null;
  modifiedAt: string | null;
  review: { status: ReviewDecision; feedback?: string; rounds: number; updatedAt?: string };
}

export interface RunMemberState {
  id: string;
  title: string;
  runtime: string;
  session: string;
  phase: MemberPhase;
  seat: SeatState | null;
  deliverables: DeliverableState[];
}

export interface RunDetail {
  run: FactoryRun;
  phase: RunPhase;
  workflow: FactoryTeam["workflow"] | null;
  teamMissing: boolean;
  members: RunMemberState[];
  progress: { delivered: number; approved: number; total: number };
}

const MAX_DOC_BYTES = 2 * 1024 * 1024;

export function validateProjectDir(raw: unknown): string {
  const dir = typeof raw === "string" ? raw.trim() : "";
  if (!dir || !path.isAbsolute(dir)) throw new RunError(400, "invalid_project_dir", "Project folder must be an absolute path");
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) throw new RunError(400, "invalid_project_dir", "Project folder cannot be the filesystem root");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new RunError(400, "project_dir_missing", `Project folder does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new RunError(400, "invalid_project_dir", `Not a folder: ${resolved}`);
  return resolved;
}

/** Absolute path of a declared deliverable, refusing anything that escapes the project (symlinks included). */
export function resolveDeliverablePath(projectDir: string, relPath: string): string | null {
  const root = fs.existsSync(projectDir) ? fs.realpathSync(projectDir) : path.resolve(projectDir);
  const target = path.resolve(root, relPath);
  if (!target.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(target)) return target;
  const real = fs.realpathSync(target);
  return real.startsWith(root + path.sep) ? real : null;
}

function nodeArray(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  const nodes = (data as { nodes?: unknown })?.nodes;
  return Array.isArray(nodes) ? (nodes as Array<Record<string, unknown>>) : [];
}

function seatFrom(node: Record<string, unknown> | undefined): SeatState | null {
  if (!node) return null;
  const activity = node["agentActivity"] as { state?: string } | undefined;
  return {
    sessionStatus: (node["sessionStatus"] as string | null) ?? null,
    startupStatus: (node["startupStatus"] as string | null) ?? null,
    activity: activity?.state ?? null,
  };
}

export class FactoryRunService {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly opts: RunServiceOpts) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get store(): FactoryRunStore {
    return this.opts.store;
  }

  /** Resolves when the background launch of a run settles (tests and shutdown). */
  settled(id: string): Promise<void> {
    return this.inFlight.get(id) ?? Promise.resolve();
  }

  /** A run left "launching" with no launch in progress was cut off by a daemon restart. */
  private reapInterrupted(run: FactoryRun): FactoryRun {
    if (run.status !== "launching" || this.inFlight.has(run.id)) return run;
    return this.store.update(run.id, (r) => {
      r.status = "failed";
      r.error = "The launch was interrupted (the daemon restarted). Start the task again.";
    }, { kind: "launch_failed", message: "Launch interrupted by a daemon restart" });
  }

  private team(run: FactoryRun): FactoryTeam {
    const team = this.opts.readTeam(run.team);
    if (!team) throw new RunError(404, "team_not_found", `The team "${run.team}" no longer exists in Factory Studio`);
    return team;
  }

  private member(team: FactoryTeam, memberId: string): FactoryMember {
    const m = team.members.find((x) => x.id === memberId);
    if (!m) throw new RunError(404, "member_not_found", `No member "${memberId}" in team ${team.name}`);
    return m;
  }

  start(input: { team: string; task: string; projectDir: unknown }): FactoryRun {
    const team = this.opts.readTeam(input.team);
    if (!team) throw new RunError(404, "team_not_found", `No team named "${input.team}"`);
    const task = input.task.trim();
    if (!task) throw new RunError(400, "task_required", "Describe the task for the team");
    if (task.length > 20_000) throw new RunError(413, "task_too_long", "The task is too long (max 20,000 characters)");
    const projectDir = validateProjectDir(input.projectDir);
    const active = this.store.list()
      .map((r) => this.reapInterrupted(r))
      .find((r) => r.team === team.name && (r.status === "launching" || r.status === "running"));
    if (active) {
      throw new RunError(409, "team_busy", `This team is already working on ${active.id}. Stop that task before starting another one.`);
    }
    const run = this.store.create({ team: team.name, teamTitle: team.title, task, projectDir });
    const p = this.launch(run.id, team).catch((err: unknown) => {
      this.store.update(run.id, (r) => {
        r.status = "failed";
        r.error = err instanceof Error ? err.message : String(err);
      }, { kind: "launch_failed", message: err instanceof Error ? err.message : String(err) });
    }).finally(() => this.inFlight.delete(run.id));
    this.inFlight.set(run.id, p);
    return run;
  }

  private async launch(runId: string, team: FactoryTeam): Promise<void> {
    const run = this.store.get(runId)!;
    const summary = await this.opts.dispatch("GET", "/api/rigs/summary");
    const existing = nodeArray(summary.data).find((r) => r["name"] === team.name);
    if (existing && existing["hasLiveAgents"] === true) {
      throw new Error(`The rig "${team.name}" is already running outside this task. Stop it (rig down ${team.name}) and try again.`);
    }

    this.store.update(runId, () => {}, { kind: "launch", message: existing ? "Restarting the team in the project folder" : "Launching the team in the project folder" });
    const up = await this.opts.dispatch("POST", "/api/up", {
      sourceRef: existing ? team.name : path.join(this.opts.teamDir(team.name), "rig.yaml"),
      cwdOverride: run.projectDir,
      autoApprove: true,
    });
    const upData = (up.data ?? {}) as Record<string, unknown>;
    if (up.status >= 400) {
      const err = upData["error"];
      const msg = typeof err === "string" ? err : (err as { fact?: string })?.fact ?? `rig up failed (HTTP ${up.status})`;
      throw new Error(msg);
    }
    const rigId = (upData["rigId"] as string | undefined) ?? existing?.["id"] as string | undefined;
    if (!rigId) throw new Error("rig up did not report a rig id");
    this.store.update(runId, (r) => { r.rigId = rigId; }, { kind: "launched", message: `Team started (rig ${rigId})` });

    // Wait until the seats that receive the task have finished their startup.
    const targets = team.workflow === "sequential" ? team.members.slice(0, 1) : team.members;
    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 5 * 60_000);
    for (;;) {
      const nodes = nodeArray((await this.opts.dispatch("GET", `/api/rigs/${encodeURIComponent(rigId)}/nodes`)).data);
      const states = targets.map((m) => seatFrom(nodes.find((n) => n["canonicalSessionName"] === sessionFor(team, m))));
      const failed = states.find((s) => s?.startupStatus === "failed");
      if (failed) throw new Error("A team member failed to start. Open Topology for details.");
      if (states.every((s) => s && (s.startupStatus === "ready" || s.startupStatus === "attention_required"))) break;
      if (Date.now() > deadline) throw new Error("Team members did not finish starting within 5 minutes");
      await this.sleep(this.opts.pollMs ?? 3000);
    }

    for (const m of targets) {
      const res = await this.send(team, m, this.taskMessage(team, m, run));
      this.store.update(runId, () => {}, { kind: "task_sent", member: m.id, message: res });
    }
    this.store.update(runId, (r) => { r.status = "running"; });
  }

  private taskMessage(team: FactoryTeam, member: FactoryMember, run: FactoryRun): string {
    const docs = member.deliverables.map((d) => `- ${d.title}: ${d.path}`).join("\n") || "- (no documents declared; report your result as a message)";
    const flow = team.workflow === "sequential" && team.members.length > 1
      ? "When your documents are complete, hand off to the next member exactly as your role guidance says, including this task text."
      : "Work on your part now; other members work on theirs in parallel.";
    return [
      `[Factory Studio task ${run.id}]`,
      "Task from the person:",
      run.task,
      "",
      `Project folder: ${run.projectDir}`,
      "Write these documents (paths relative to the project folder):",
      docs,
      "",
      flow,
    ].join("\n");
  }

  private async send(team: FactoryTeam, member: FactoryMember, text: string): Promise<string> {
    const res = await this.opts.dispatch("POST", "/api/transport/send", {
      session: sessionFor(team, member),
      text,
      waitForIdleMs: 180_000,
    });
    const data = (res.data ?? {}) as Record<string, unknown>;
    if (res.status >= 400 || data["ok"] === false) {
      const reason = (data["error"] as string | undefined) ?? (data["reason"] as string | undefined) ?? `HTTP ${res.status}`;
      throw new RunError(502, "send_failed", `Could not deliver to ${member.title}: ${reason}`);
    }
    // "recorded": the seat does not exist (team stopped or crashed) — the text only went to the outbox.
    if (data["outcome"] === "recorded") {
      throw new RunError(502, "not_delivered", `${member.title} is not running, so the message was not delivered. Start the task again or restart the team.`);
    }
    // "retained" and similar: the seat is busy; the daemon delivers it later.
    if (data["sent"] === false) return `Queued for ${member.title}: ${(data["warning"] as string | undefined) ?? "not delivered yet"}`;
    return `Sent to ${member.title}`;
  }

  async detail(id: string): Promise<RunDetail> {
    const stored = this.store.get(id);
    if (!stored) throw new RunError(404, "run_not_found", `No run "${id}"`);
    const run = this.reapInterrupted(stored);
    const team = this.opts.readTeam(run.team);

    let nodes: Array<Record<string, unknown>> = [];
    if (run.rigId && run.status !== "stopped") {
      try {
        nodes = nodeArray((await this.opts.dispatch("GET", `/api/rigs/${encodeURIComponent(run.rigId)}/nodes`)).data);
      } catch {
        nodes = [];
      }
    }

    const members: RunMemberState[] = (team?.members ?? []).map((m) => {
      const session = sessionFor(team!, m);
      const seat = seatFrom(nodes.find((n) => n["canonicalSessionName"] === session));
      const deliverables: DeliverableState[] = m.deliverables.map((d) => {
        const abs = resolveDeliverablePath(run.projectDir, d.path);
        let stat: fs.Stats | null = null;
        try {
          stat = abs ? fs.statSync(abs) : null;
        } catch {
          stat = null;
        }
        const r = run.reviews[reviewKey(m.id, d.id)];
        return {
          id: d.id,
          title: d.title,
          path: d.path,
          exists: !!stat?.isFile() && stat.size > 0,
          size: stat?.isFile() ? stat.size : null,
          modifiedAt: stat?.isFile() ? stat.mtime.toISOString() : null,
          review: r ? { status: r.status, feedback: r.feedback, rounds: r.rounds, updatedAt: r.updatedAt } : { status: "pending", rounds: 0 },
        };
      });
      return { id: m.id, title: m.title, runtime: m.runtime, session, seat, deliverables, phase: "working" as MemberPhase };
    });

    // Member phase: review state first, then files, then seat activity.
    members.forEach((m, i) => {
      const ds = m.deliverables;
      const anyRework = ds.some((d) => d.review.status === "rework");
      const allApproved = ds.length > 0 && ds.every((d) => d.review.status === "approved");
      const allExist = ds.length > 0 && ds.every((d) => d.exists);
      const prevDone = i === 0 || team?.workflow !== "sequential" || members[i - 1]!.deliverables.every((d) => d.exists);
      if (anyRework) m.phase = "rework";
      else if (allApproved) m.phase = "approved";
      else if (allExist) m.phase = "delivered";
      else if (run.status === "stopped" || (run.rigId && m.seat === null && run.status === "running")) m.phase = "offline";
      else if (m.seat?.activity === "needs_input") m.phase = "needs_input";
      else if (!prevDone && !ds.some((d) => d.exists)) m.phase = "waiting";
      else m.phase = "working";
    });

    const all = members.flatMap((m) => m.deliverables);
    const progress = {
      total: all.length,
      delivered: all.filter((d) => d.exists).length,
      approved: all.filter((d) => d.review.status === "approved").length,
    };
    let phase: RunPhase;
    if (run.status === "launching" || run.status === "failed" || run.status === "stopped") phase = run.status;
    else if (progress.total > 0 && progress.approved === progress.total) phase = "approved";
    else if (progress.total > 0 && progress.delivered === progress.total && !all.some((d) => d.review.status === "rework")) phase = "review";
    else phase = "working";

    return { run, phase, workflow: team?.workflow ?? null, teamMissing: !team, members, progress };
  }

  readDeliverable(id: string, memberId: string, deliverableId: string): { content: Buffer; fileName: string; path: string } {
    const run = this.store.get(id);
    if (!run) throw new RunError(404, "run_not_found", `No run "${id}"`);
    const member = this.member(this.team(run), memberId);
    const d = member.deliverables.find((x) => x.id === deliverableId);
    if (!d) throw new RunError(404, "deliverable_not_found", `No output "${deliverableId}" for ${member.title}`);
    const abs = resolveDeliverablePath(run.projectDir, d.path);
    if (!abs) throw new RunError(400, "path_escape", `${d.path} resolves outside the project folder`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new RunError(404, "not_written", `${d.title} has not been written yet (${d.path})`);
    }
    if (!stat.isFile()) throw new RunError(404, "not_written", `${d.path} is not a file`);
    if (stat.size > MAX_DOC_BYTES) throw new RunError(413, "too_large", `${d.path} is larger than 2 MB`);
    return { content: fs.readFileSync(abs), fileName: path.basename(d.path), path: d.path };
  }

  async review(id: string, input: { member: string; deliverable: string; decision: unknown; feedback?: unknown }): Promise<FactoryRun> {
    const run = this.store.get(id);
    if (!run) throw new RunError(404, "run_not_found", `No run "${id}"`);
    const team = this.team(run);
    const member = this.member(team, input.member);
    const d = member.deliverables.find((x) => x.id === input.deliverable);
    if (!d) throw new RunError(404, "deliverable_not_found", `No output "${input.deliverable}" for ${member.title}`);
    const decision = input.decision;
    if (decision !== "approved" && decision !== "rework" && decision !== "pending") {
      throw new RunError(400, "invalid_decision", "decision must be approved, rework or pending");
    }
    const feedback = typeof input.feedback === "string" ? input.feedback.trim() : "";
    if (decision === "rework" && !feedback) throw new RunError(400, "feedback_required", "Say what to change when asking for rework");

    let sent: string | null = null;
    if (decision === "rework") {
      if (run.status !== "running") throw new RunError(409, "team_not_running", "The team is not running, so it cannot rework the document");
      sent = await this.send(team, member, [
        `[Factory Studio rework ${run.id}]`,
        `The person reviewed "${d.title}" (${d.path}) and asks for changes:`,
        feedback,
        "",
        "Update the same file. Add or update a \"Revision notes\" section at the top listing what you changed, then report done.",
        "Do not hand off to the next member again unless the change affects their documents.",
      ].join("\n"));
    }
    return this.store.update(id, (r) => {
      const key = reviewKey(member.id, d.id);
      const prev = r.reviews[key];
      r.reviews[key] = {
        status: decision,
        ...(feedback ? { feedback } : {}),
        updatedAt: new Date().toISOString(),
        rounds: (prev?.rounds ?? 0) + (decision === "rework" ? 1 : 0),
      };
    }, {
      kind: "review",
      member: member.id,
      message: decision === "approved" ? `Approved ${d.title}` : decision === "rework" ? `Rework requested on ${d.title}: ${feedback}${sent ? ` (${sent})` : ""}` : `Reset review of ${d.title}`,
    });
  }

  async message(id: string, memberId: string, text: unknown): Promise<FactoryRun> {
    const run = this.store.get(id);
    if (!run) throw new RunError(404, "run_not_found", `No run "${id}"`);
    if (run.status !== "running") throw new RunError(409, "team_not_running", "The team is not running");
    const body = typeof text === "string" ? text.trim() : "";
    if (!body) throw new RunError(400, "text_required", "Write a message");
    const team = this.team(run);
    const member = this.member(team, memberId);
    const sent = await this.send(team, member, `[Factory Studio message ${run.id}]\n${body}`);
    return this.store.update(id, () => {}, { kind: "message", member: member.id, message: `${sent}: ${body.slice(0, 300)}` });
  }

  async screen(id: string, memberId: string): Promise<{ content: string; capturedAt: string }> {
    const run = this.store.get(id);
    if (!run) throw new RunError(404, "run_not_found", `No run "${id}"`);
    const team = this.team(run);
    const member = this.member(team, memberId);
    const res = await this.opts.dispatch("GET", `/api/sessions/${encodeURIComponent(sessionFor(team, member))}/preview?lines=80`);
    const data = (res.data ?? {}) as { content?: string; capturedAt?: string; error?: string; hint?: string };
    if (res.status >= 400) throw new RunError(502, "screen_unavailable", data.hint ?? data.error ?? `HTTP ${res.status}`);
    return { content: data.content ?? "", capturedAt: data.capturedAt ?? new Date().toISOString() };
  }

  async stop(id: string): Promise<FactoryRun> {
    const run = this.store.get(id);
    if (!run) throw new RunError(404, "run_not_found", `No run "${id}"`);
    if (run.status === "stopped") return run;
    if (run.rigId) {
      const res = await this.opts.dispatch("POST", "/api/down", { rigId: run.rigId, snapshot: true });
      if (res.status >= 400) {
        const data = (res.data ?? {}) as { error?: string };
        throw new RunError(502, "stop_failed", data.error ?? `rig down failed (HTTP ${res.status})`);
      }
    }
    return this.store.update(id, (r) => { r.status = "stopped"; }, { kind: "stopped", message: "Team stopped" });
  }
}
