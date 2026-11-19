// Factory Studio routes — create and edit teams from the web UI.
//
//   GET    /api/factory/templates          deliverable templates
//   GET    /api/factory/teams              team summaries
//   GET    /api/factory/teams/:name        one team (definition, rig.yaml, session names)
//   POST   /api/factory/teams/preview      validate + render the generated files, write nothing
//   POST   /api/factory/teams              create (409 when the name exists)
//   PUT    /api/factory/teams/:name        create or replace
//   DELETE /api/factory/teams/:name        remove the team folder
//
// A saved team is a normal RigSpec under the user spec library root, so the
// spec library is rescanned after every write and `rig up <name>` launches it.

import * as nodePath from "node:path";
import { Hono, type Context } from "hono";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import { DELIVERABLE_TEMPLATES } from "../domain/factory-studio/templates.js";
import { parseFactoryTeamInput } from "../domain/factory-studio/team.js";
import { FactoryStoreError, FactoryTeamStore } from "../domain/factory-studio/team-store.js";
import { FactoryRunStore } from "../domain/factory-studio/run-store.js";
import { FactoryRunService, RunError, type Dispatch } from "../domain/factory-studio/run-service.js";
import type { SkillLibraryDiscoveryService } from "../domain/skill-library-discovery.js";
import type { SpecLibraryService } from "../domain/spec-library-service.js";

export interface FactoryRoutesOpts {
  /** Folder holding one sub-folder per team. Default: $OPENRIG_HOME/specs/factory. */
  teamsRoot?: () => string;
  /** The daemon's shared AgentSpec folder. Default: <daemon>/specs/agents/shared. */
  sharedAgentDir?: string;
  /** Folder of Agent Workspace run records. Default: $OPENRIG_HOME/factory/runs. */
  runsRoot?: string;
  /** In-process call into the daemon's own /api routes (launch, send, down). Runs are disabled without it. */
  dispatch?: Dispatch;
  /** Test hooks for the launch wait. */
  runTiming?: { pollMs?: number; readyTimeoutMs?: number; sleep?: (ms: number) => Promise<void> };
}

const DEFAULT_SHARED_AGENT_DIR = nodePath.resolve(import.meta.dirname, "..", "..", "specs", "agents", "shared");

function services(c: Context) {
  return {
    skills: c.get("skillLibraryDiscoveryService" as never) as SkillLibraryDiscoveryService | undefined,
    library: c.get("specLibraryService" as never) as SpecLibraryService | undefined,
  };
}

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof FactoryStoreError) {
    return c.json({ error: err.code, message: err.message, errors: err.errors }, err.status);
  }
  return c.json({ error: "factory_failed", message: err instanceof Error ? err.message : String(err) }, 500);
}

async function readInput(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false as const, errors: ["body: must be valid JSON"] };
  }
  return parseFactoryTeamInput(body);
}

export function factoryRoutes(opts: FactoryRoutesOpts = {}): Hono {
  const router = new Hono();
  const teamsRoot = opts.teamsRoot ?? (() => nodePath.join(getDefaultOpenRigPath("specs"), "factory"));
  const sharedAgentDir = opts.sharedAgentDir ?? DEFAULT_SHARED_AGENT_DIR;

  const storeFor = (c: Context) => new FactoryTeamStore({
    teamsRoot: teamsRoot(),
    sharedAgentDir,
    skillSource: services(c).skills ?? null,
  });

  /** A team name must not shadow a rig from another library root (`rig up <name>` would be ambiguous). */
  const nameConflict = (c: Context, store: FactoryTeamStore, name: string): string | null => {
    const lib = services(c).library;
    if (!lib) return null;
    const root = nodePath.resolve(store.teamsRoot) + nodePath.sep;
    const clash = lib.list({ kind: "rig" }).find((e) => e.name === name && !nodePath.resolve(e.sourcePath).startsWith(root));
    return clash ? clash.sourcePath : null;
  };

  const rescan = (c: Context) => {
    try {
      services(c).library?.scan();
    } catch {
      // The library rescans on its own sync; a failed rescan does not undo the save.
    }
  };

  router.get("/templates", (c) => c.json(DELIVERABLE_TEMPLATES));

  router.get("/teams", (c) => c.json(storeFor(c).list()));

  router.post("/teams/preview", async (c) => {
    const parsed = await readInput(c);
    if (!parsed.ok) return c.json({ valid: false, errors: parsed.errors, files: {} }, 200);
    try {
      const store = storeFor(c);
      const preview = store.preview(parsed.team);
      const clash = nameConflict(c, store, parsed.team.name);
      if (clash) preview.errors.push(`name: "${parsed.team.name}" is already used by the rig at ${clash}`);
      return c.json({ ...preview, valid: preview.errors.length === 0 });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  const save = async (c: Context, createOnly: boolean, pathName?: string) => {
    const parsed = await readInput(c);
    if (!parsed.ok) return c.json({ error: "invalid_team", message: "The team definition is invalid", errors: parsed.errors }, 400);
    if (pathName !== undefined && parsed.team.name !== pathName) {
      return c.json({ error: "name_mismatch", message: `Body name "${parsed.team.name}" does not match the URL "${pathName}"`, errors: [] }, 400);
    }
    try {
      const store = storeFor(c);
      const clash = nameConflict(c, store, parsed.team.name);
      if (clash) {
        return c.json({ error: "name_taken", message: `"${parsed.team.name}" is already used by the rig at ${clash}`, errors: [] }, 409);
      }
      const detail = store.save(parsed.team, { createOnly });
      rescan(c);
      return c.json(detail, createOnly ? 201 : 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  };

  router.post("/teams", (c) => save(c, true));
  router.put("/teams/:name", (c) => save(c, false, c.req.param("name")));

  router.get("/teams/:name", (c) => {
    try {
      return c.json(storeFor(c).detail(c.req.param("name")));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.delete("/teams/:name", (c) => {
    try {
      storeFor(c).remove(c.req.param("name"));
      rescan(c);
      return c.json({ ok: true });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ── Agent Workspace: runs ─────────────────────────────────────────────
  //   GET  /runs                                          run list
  //   POST /runs                    {team, task, projectDir}   start (202; launch continues in the background)
  //   GET  /runs/:id                                      run + per-member progress and outputs
  //   GET  /runs/:id/outputs/:member/:deliverable[?download=1]  one output document
  //   POST /runs/:id/review         {member, deliverable, decision, feedback}
  //   POST /runs/:id/message        {member, text}
  //   GET  /runs/:id/screen/:member                       the member's terminal, last 80 lines
  //   POST /runs/:id/stop                                 rig down (with snapshot)
  const dispatch = opts.dispatch;
  const runs = dispatch
    ? new FactoryRunService({
        store: new FactoryRunStore(opts.runsRoot ?? nodePath.join(getDefaultOpenRigPath("factory"), "runs")),
        dispatch,
        teamDir: (name) => nodePath.join(teamsRoot(), name),
        readTeam: (name) => {
          try {
            return new FactoryTeamStore({ teamsRoot: teamsRoot(), sharedAgentDir, skillSource: null }).read(name);
          } catch {
            return null;
          }
        },
        ...opts.runTiming,
      })
    : null;

  const runError = (c: Context, err: unknown): Response => {
    if (err instanceof RunError) return c.json({ error: err.code, message: err.message }, err.status);
    return c.json({ error: "run_failed", message: err instanceof Error ? err.message : String(err) }, 500);
  };
  const withRuns = (c: Context, fn: (svc: FactoryRunService) => Promise<Response> | Response) => {
    if (!runs) return c.json({ error: "runs_unavailable", message: "Agent Workspace is not wired on this daemon" }, 503);
    return Promise.resolve()
      .then(() => fn(runs))
      .catch((err) => runError(c, err));
  };
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const text = (v: unknown) => (typeof v === "string" ? v : "");

  router.get("/runs", (c) => withRuns(c, (svc) => c.json(svc.store.list())));

  router.post("/runs", (c) => withRuns(c, async (svc) => {
    const b = await body(c);
    const run = svc.start({ team: text(b.team), task: text(b.task), projectDir: b.projectDir });
    return c.json(run, 202);
  }));

  router.get("/runs/:id", (c) => withRuns(c, async (svc) => c.json(await svc.detail(c.req.param("id")))));

  router.get("/runs/:id/outputs/:member/:deliverable", (c) => withRuns(c, (svc) => {
    const doc = svc.readDeliverable(c.req.param("id"), c.req.param("member"), c.req.param("deliverable"));
    const download = c.req.query("download") === "1";
    const type = /\.(md|markdown)$/i.test(doc.fileName) ? "text/markdown; charset=utf-8"
      : /\.json$/i.test(doc.fileName) ? "application/json; charset=utf-8"
      : /\.(ya?ml)$/i.test(doc.fileName) ? "text/yaml; charset=utf-8"
      : "text/plain; charset=utf-8";
    const headers: Record<string, string> = { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (download) headers["content-disposition"] = `attachment; filename="${doc.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
    return new Response(new Uint8Array(doc.content), { status: 200, headers });
  }));

  router.post("/runs/:id/review", (c) => withRuns(c, async (svc) => {
    const b = await body(c);
    return c.json(await svc.review(c.req.param("id"), {
      member: text(b.member),
      deliverable: text(b.deliverable),
      decision: b.decision,
      feedback: b.feedback,
    }));
  }));

  router.post("/runs/:id/message", (c) => withRuns(c, async (svc) => {
    const b = await body(c);
    return c.json(await svc.message(c.req.param("id"), text(b.member), b.text));
  }));

  router.get("/runs/:id/screen/:member", (c) => withRuns(c, async (svc) => c.json(await svc.screen(c.req.param("id"), c.req.param("member")))));

  router.post("/runs/:id/stop", (c) => withRuns(c, async (svc) => c.json(await svc.stop(c.req.param("id")))));

  return router;
}
