// Agent Workspace — runs of Factory Studio teams.
//
// A run is one task given to one team in one project directory. It records
// the launch, the task message, and the person's review of every deliverable
// (approve / request rework). Deliverable files themselves stay in the
// project; the run only reads the paths the team declared.
//
// Storage: one JSON file per run under <runsRoot>/<id>.json
// (default $OPENRIG_HOME/factory/runs).

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { CodeCheck } from "./code-check.js";

export type RunStatus = "launching" | "running" | "failed" | "stopped";
export type ReviewDecision = "pending" | "approved" | "rework";

export interface RunEvent {
  at: string;
  kind: "created" | "launch" | "launched" | "task_sent" | "launch_failed" | "review" | "message" | "stopped" | "error" | "check";
  message: string;
  member?: string;
}

export interface DeliverableReview {
  status: ReviewDecision;
  feedback?: string;
  updatedAt: string;
  /** How many times rework was requested. */
  rounds: number;
}

export interface FactoryRun {
  id: string;
  team: string;
  teamTitle: string;
  task: string;
  projectDir: string;
  status: RunStatus;
  rigId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** Keyed by "<memberId>/<deliverableId>". */
  reviews: Record<string, DeliverableReview>;
  /** Build/test checks of source-code outputs, keyed like reviews. */
  checks?: Record<string, CodeCheck>;
  events: RunEvent[];
}

const RUN_ID = /^run-[a-z0-9]{6,32}$/;

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

export function reviewKey(memberId: string, deliverableId: string): string {
  return `${memberId}/${deliverableId}`;
}

export class FactoryRunStore {
  constructor(private readonly runsRoot: string, private readonly now: () => Date = () => new Date()) {}

  private file(id: string): string {
    if (!isRunId(id)) throw new Error(`Invalid run id "${id}"`);
    return path.join(this.runsRoot, `${id}.json`);
  }

  private write(run: FactoryRun): FactoryRun {
    fs.mkdirSync(this.runsRoot, { recursive: true });
    const target = this.file(run.id);
    const tmp = `${target}.${randomBytes(3).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`);
    fs.renameSync(tmp, target);
    return run;
  }

  create(fields: Pick<FactoryRun, "team" | "teamTitle" | "task" | "projectDir">): FactoryRun {
    const stamp = this.now().toISOString();
    const datePart = stamp.slice(0, 10).replace(/-/g, "");
    const run: FactoryRun = {
      ...fields,
      id: `run-${datePart}${randomBytes(4).toString("hex")}`,
      status: "launching",
      createdAt: stamp,
      updatedAt: stamp,
      reviews: {},
      events: [{ at: stamp, kind: "created", message: "Task created" }],
    };
    return this.write(run);
  }

  get(id: string): FactoryRun | null {
    if (!isRunId(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.file(id), "utf-8")) as FactoryRun;
    } catch {
      return null;
    }
  }

  list(): FactoryRun[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.runsRoot);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => this.get(n.slice(0, -5)))
      .filter((r): r is FactoryRun => r !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Read-modify-write one run. Synchronous, so two updates in one daemon never interleave. */
  update(id: string, fn: (run: FactoryRun) => void, event?: Omit<RunEvent, "at">): FactoryRun {
    const run = this.get(id);
    if (!run) throw new Error(`No run "${id}"`);
    fn(run);
    run.updatedAt = this.now().toISOString();
    if (event) run.events.push({ at: run.updatedAt, ...event });
    if (run.events.length > 200) run.events = run.events.slice(-200);
    return this.write(run);
  }

  remove(id: string): boolean {
    try {
      fs.rmSync(this.file(id));
      return true;
    } catch {
      return false;
    }
  }
}
