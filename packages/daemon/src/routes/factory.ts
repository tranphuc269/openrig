// Factory Studio routes — create and edit teams from the web UI.
//
//   GET    /api/factory/templates          deliverable templates
//   GET    /api/factory/teams              team summaries
//   GET    /api/factory/teams/:name        one team (definition, rig.yaml, session names)
//   POST   /api/factory/teams/preview      validate + render the generated files, write nothing
//   POST   /api/factory/teams              create (409 when the name exists)
//   PUT    /api/factory/teams/:name        create or replace
//   DELETE /api/factory/teams/:name        remove the team folder
//   GET    /api/factory/office-templates   Word/Excel forms (POST raw file + x-file-name to upload;
//          GET/:id file, GET /:id/inspect placeholders/sheets, DELETE /:id)
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
import { checkFolder, createFolder, listFolders, readReadiness, registerDefaultPerson, type RigProbe, type ShellLookup } from "../domain/factory-studio/readiness.js";
import { AgentApiSettingsError, clearAgentApiKey, readAgentApiSettings, saveAgentApiSettings, testAgentApi } from "../domain/agent-api-settings.js";
import { OfficeTemplateError, OfficeTemplateStore, MAX_TEMPLATE_BYTES, officeTemplatesDir } from "../domain/factory-studio/office/office-templates.js";
import { inspectDocx } from "../domain/factory-studio/office/docx.js";
import { inspectXlsx } from "../domain/factory-studio/office/xlsx.js";
import { previewOffice } from "../domain/factory-studio/office/preview.js";
import type { OfficeToolOptions } from "../domain/factory-studio/generator.js";
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
  /** Test hooks for readiness: tool lookup and the OpenRig home the person is registered in. */
  readiness?: { lookup?: ShellLookup; home?: string; rigProbe?: RigProbe };
  /** OpenRig home holding agent-api/ (tests). Default: $OPENRIG_HOME. */
  agentApiHome?: string;
  /** Test hook for the connection test. */
  agentApiFetch?: typeof fetch;
  /** Folder of uploaded Word/Excel forms. Default: $OPENRIG_HOME/factory/office-templates. */
  officeTemplatesDir?: string;
  /** Test hooks for the launch wait. */
  runTiming?: { pollMs?: number; readyTimeoutMs?: number; sleep?: (ms: number) => Promise<void> };
  /** Source-code checks: time limit, shell, auto-run on hand-off, quiet time before an auto-run. */
  runChecks?: { timeoutMs?: number; shell?: string; auto?: boolean; quietMs?: number; maxParallel?: number };
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

  const forms = new OfficeTemplateStore(opts.officeTemplatesDir ?? officeTemplatesDir());
  const office: OfficeToolOptions = {
    command: "rig office",
    resolveTemplate: (id) => {
      const meta = forms.get(id);
      const file = meta ? forms.filePath(id) : null;
      return meta && file ? { path: file, format: meta.format, name: meta.name } : null;
    },
  };

  const storeFor = (c: Context) => new FactoryTeamStore({
    teamsRoot: teamsRoot(),
    sharedAgentDir,
    skillSource: services(c).skills ?? null,
    office,
  });

  const formError = (c: Context, err: unknown): Response => {
    if (err instanceof OfficeTemplateError) return c.json({ error: err.code, message: err.message }, err.status);
    return c.json({ error: "form_failed", message: err instanceof Error ? err.message : String(err) }, 400);
  };

  // ── Word/Excel forms ──────────────────────────────────────────────────
  router.get("/office-templates", (c) => c.json(forms.list()));

  router.post("/office-templates", async (c) => {
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_TEMPLATE_BYTES) return c.json({ error: "too_large", message: "Forms can be at most 10 MB" }, 413);
    let name = c.req.header("x-file-name") ?? "";
    try { name = decodeURIComponent(name); } catch { /* keep as sent */ }
    try {
      const buf = Buffer.from(await c.req.arrayBuffer());
      return c.json(await forms.save(name, buf), 201);
    } catch (err) {
      return formError(c, err);
    }
  });

  router.get("/office-templates/:id", (c) => {
    try {
      const { meta, content } = forms.read(c.req.param("id"));
      const type = meta.format === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      return new Response(new Uint8Array(content), {
        status: 200,
        headers: {
          "content-type": type,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (err) {
      return formError(c, err);
    }
  });

  router.get("/office-templates/:id/inspect", async (c) => {
    try {
      const { meta, content } = forms.read(c.req.param("id"));
      return c.json(meta.format === "docx"
        ? { format: "docx", docx: await inspectDocx(content) }
        : { format: "xlsx", xlsx: await inspectXlsx(content) });
    } catch (err) {
      return formError(c, err);
    }
  });

  router.delete("/office-templates/:id", (c) => {
    const id = c.req.param("id");
    const store = storeFor(c);
    const usedBy = store.list().flatMap((summary) => {
      const team = store.read(summary.name);
      return team?.members.some((m) => m.deliverables.some((d) => d.template === id)) ? [team.title] : [];
    });
    if (usedBy.length && c.req.query("force") !== "1") {
      return c.json({ error: "template_in_use", message: `Used by ${usedBy.join(", ")}. Pick another form there first.`, teams: usedBy }, 409);
    }
    try {
      forms.remove(id);
      return c.json({ ok: true });
    } catch (err) {
      return formError(c, err);
    }
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
        checks: opts.runChecks,
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

  /** Teams saved before Settings existed may name Codex or a per-member model; save them again as Claude Code
   *  members so the launch uses the API key, base URL and model from Settings. */
  const upgradeTeamRuntime = (c: Context, name: string) => {
    if (!name) return;
    const store = storeFor(c);
    let team;
    try { team = store.read(name); } catch { return; }
    if (!team) return;
    // Regenerated on every start, so agents always get guidance for this daemon's tools (and teams saved
    // with Codex or a per-member model move to Claude Code with the Settings model).
    store.save({ ...team, members: team.members.map(({ model: _model, ...m }) => ({ ...m, runtime: "claude-code" as const })) });
  };

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
    if (!readAgentApiSettings(opts.agentApiHome).hasKey) {
      return c.json({ error: "agent_api_missing", message: "Agents need an Anthropic API key. Add it in Settings, then start the task again." }, 412);
    }
    upgradeTeamRuntime(c, text(b.team));
    const run = svc.start({ team: text(b.team), task: text(b.task), projectDir: b.projectDir });
    return c.json(run, 202);
  }));

  router.get("/runs/:id", (c) => withRuns(c, async (svc) => c.json(await svc.detail(c.req.param("id")))));

  router.get("/runs/:id/outputs/:member/:deliverable", (c) => withRuns(c, (svc) => {
    const doc = svc.readDeliverable(c.req.param("id"), c.req.param("member"), c.req.param("deliverable"));
    const download = c.req.query("download") === "1";
    const office = /\.(docx|xlsx)$/i.test(doc.fileName);
    if (office && c.req.query("preview") === "1") {
      return previewOffice(doc.fileName, doc.content)
        .then((preview) => c.json(preview))
        .catch((err: Error) => c.json({ error: "preview_failed", message: err.message }, 422));
    }
    const type = /\.(md|markdown)$/i.test(doc.fileName) ? "text/markdown; charset=utf-8"
      : /\.json$/i.test(doc.fileName) ? "application/json; charset=utf-8"
      : /\.(ya?ml)$/i.test(doc.fileName) ? "text/yaml; charset=utf-8"
      : /\.docx$/i.test(doc.fileName) ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : /\.xlsx$/i.test(doc.fileName) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "text/plain; charset=utf-8";
    const headers: Record<string, string> = { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (download) headers["content-disposition"] = `attachment; filename="${doc.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
    return new Response(new Uint8Array(doc.content), { status: 200, headers });
  }));

  // Source-code outputs: run the build/test check, list the folder, read one file.
  router.post("/runs/:id/checks/:member/:deliverable", (c) => withRuns(c, (svc) =>
    c.json(svc.checkNow(c.req.param("id"), c.req.param("member"), c.req.param("deliverable")), 202)));

  router.get("/runs/:id/code/:member/:deliverable", (c) => withRuns(c, (svc) =>
    c.json(svc.codeTree(c.req.param("id"), c.req.param("member"), c.req.param("deliverable")))));

  router.get("/runs/:id/code/:member/:deliverable/file", (c) => withRuns(c, (svc) =>
    c.json(svc.codeFile(c.req.param("id"), c.req.param("member"), c.req.param("deliverable"), c.req.query("path") ?? ""))));

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

  // ── Readiness and folder picker ───────────────────────────────────────
  //   GET  /readiness                       checks a team needs (tools, sign-in, person, tracking)
  //   POST /readiness/person {entityId, displayName}   register you as the default person agents ask
  //   GET  /fs/folders?path=                sub-folders of a folder (default: home), for the folder picker
  //   GET  /fs/check?path=                  is this a usable project folder
  //   POST /fs/folders {path}               create a new project folder inside home
  router.get("/readiness", async (c) => {
    if (!dispatch) return c.json({ error: "readiness_unavailable", message: "Readiness is not wired on this daemon" }, 503);
    return c.json(await readReadiness({ dispatch, lookup: opts.readiness?.lookup, rigProbe: opts.readiness?.rigProbe, agentApiHome: opts.agentApiHome }));
  });
  router.post("/readiness/person", async (c) => {
    const b = await body(c);
    try {
      const res = await registerDefaultPerson({ entityId: b.entityId, displayName: b.displayName }, opts.readiness?.home);
      return res.ok ? c.json(res, 201) : c.json({ error: "person_not_registered", message: res.error }, 400);
    } catch (err) {
      return c.json({ error: "person_not_registered", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
  router.get("/fs/folders", (c) => {
    try {
      return c.json(listFolders(c.req.query("path")));
    } catch (err) {
      return c.json({ error: "folder_unreadable", message: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
  router.get("/fs/check", (c) => c.json(checkFolder(c.req.query("path"))));
  router.post("/fs/folders", async (c) => {
    const b = await body(c);
    try {
      const res = createFolder(b.path);
      return res.ok ? c.json(res, 201) : c.json({ error: "folder_not_created", message: res.error }, 400);
    } catch (err) {
      return c.json({ error: "folder_not_created", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── Agent API settings ────────────────────────────────────────────────
  //   GET    /settings/agent-api        key hint (never the key), base URL, model, where they come from
  //   PUT    /settings/agent-api        {apiKey?, baseUrl?, model?}   blank base URL/model removes it
  //   DELETE /settings/agent-api/key    forget the saved key
  //   POST   /settings/agent-api/test   one tiny request with the active values
  router.get("/settings/agent-api", (c) => c.json(readAgentApiSettings(opts.agentApiHome)));
  router.put("/settings/agent-api", async (c) => {
    const b = await body(c);
    const opt = (v: unknown) => (v === undefined ? undefined : v === null ? null : typeof v === "string" ? v : String(v));
    try {
      return c.json(saveAgentApiSettings({ apiKey: typeof b.apiKey === "string" ? b.apiKey : undefined, baseUrl: opt(b.baseUrl), model: opt(b.model) }, opts.agentApiHome));
    } catch (err) {
      if (err instanceof AgentApiSettingsError) return c.json({ error: "invalid_setting", field: err.field, message: err.message }, 400);
      return c.json({ error: "settings_not_saved", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
  router.delete("/settings/agent-api/key", (c) => c.json(clearAgentApiKey(opts.agentApiHome)));
  router.post("/settings/agent-api/test", async (c) => c.json(await testAgentApi({ home: opts.agentApiHome, fetchImpl: opts.agentApiFetch })));

  router.post("/runs/:id/stop", (c) => withRuns(c, async (svc) => c.json(await svc.stop(c.req.param("id")))));

  return router;
}
