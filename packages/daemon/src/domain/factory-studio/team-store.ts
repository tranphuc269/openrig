// Factory Studio — on-disk team store.
//
// Teams live under <teamsRoot>/<name>/ (default $OPENRIG_HOME/specs/factory),
// which is inside the user spec library root, so a saved team shows up in the
// spec library and launches with `rig up <name>`.
//
// A save writes the whole team into a staging folder, validates every
// generated spec there, and only then swaps it into place, so a failed save
// never leaves a half-written team behind.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { resolveAgentRef } from "../agent-resolver.js";
import { validateAgentSpecFromYaml, validateRigSpecFromYaml } from "../spec-validation-service.js";
import { generateTeamFiles, sessionFor, type GeneratedFile, type OfficeToolOptions, type SkillPlacement } from "./generator.js";
import { isFactorySlug, type FactoryTeam, type FactoryTeamInput } from "./team.js";

export interface FactoryTeamSummary {
  name: string;
  title: string;
  summary: string;
  workflow: FactoryTeam["workflow"];
  memberCount: number;
  deliverableCount: number;
  members: Array<{ id: string; title: string; runtime: string; session: string; deliverables: number }>;
  updatedAt: string;
  folder: string;
}

export interface FactoryTeamDetail {
  team: FactoryTeam;
  folder: string;
  rigYaml: string;
  sessions: Record<string, string>;
}

export interface SkillSource {
  /** Library id → { leaf name, absolute folder } or null. */
  getSkill(id: string): { name: string; absolutePath: string } | null;
}

export interface FactoryTeamStoreOpts {
  teamsRoot: string;
  sharedAgentDir: string;
  skillSource: SkillSource | null;
  /** Word/Excel support: the office tool command and the form library. */
  office?: OfficeToolOptions;
  now?: () => Date;
}

export class FactoryStoreError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 422 | 500, readonly code: string, message: string, readonly errors: string[] = []) {
    super(message);
  }
}

const realFs = {
  readFile: (p: string) => fs.readFileSync(p, "utf-8"),
  exists: (p: string) => fs.existsSync(p),
};

export class FactoryTeamStore {
  private readonly now: () => Date;

  constructor(private readonly opts: FactoryTeamStoreOpts) {
    this.now = opts.now ?? (() => new Date());
  }

  get teamsRoot(): string {
    return this.opts.teamsRoot;
  }

  private teamDir(name: string): string {
    if (!isFactorySlug(name)) throw new FactoryStoreError(400, "invalid_name", `Invalid team name "${name}"`);
    return path.join(this.opts.teamsRoot, name);
  }

  /** Ids of skills the shared AgentSpec declares, mapped to their absolute folders. */
  private sharedSkills(): Map<string, string> {
    const out = new Map<string, string>();
    try {
      const raw = parseYaml(fs.readFileSync(path.join(this.opts.sharedAgentDir, "agent.yaml"), "utf-8")) as {
        resources?: { skills?: Array<{ id?: string; path?: string }> };
      };
      for (const s of raw?.resources?.skills ?? []) {
        if (s.id && s.path) out.set(s.id, path.resolve(this.opts.sharedAgentDir, s.path));
      }
    } catch {
      // No shared spec: every library skill is copied instead.
    }
    return out;
  }

  private realpath(p: string): string {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }

  generate(input: FactoryTeamInput, existing?: FactoryTeam | null) {
    const stamp = this.now().toISOString();
    const team: FactoryTeam = { ...input, createdAt: existing?.createdAt ?? stamp, updatedAt: stamp };
    const shared = this.sharedSkills();
    const sharedByDir = new Map([...shared].map(([id, dir]) => [this.realpath(dir), id]));
    const resolveSkill = (libraryId: string): SkillPlacement | null => {
      const skill = this.opts.skillSource?.getSkill(libraryId);
      if (!skill) return null;
      const sharedId = sharedByDir.get(this.realpath(skill.absolutePath));
      if (sharedId) return { kind: "shared", id: sharedId };
      return { kind: "copy", id: skill.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "skill", sourceDir: skill.absolutePath };
    };
    const result = generateTeamFiles(team, {
      sharedAgentDir: this.opts.sharedAgentDir,
      sharedSkillIds: new Set(shared.keys()),
      resolveSkill,
      ...(this.opts.office ? { office: this.opts.office } : {}),
    });
    return { team, ...result };
  }

  /** Validate a generated file set in memory (no filesystem writes). */
  validateInMemory(files: Map<string, GeneratedFile>): string[] {
    const errors: string[] = [];
    for (const [rel, file] of files) {
      if (file.kind !== "text") continue;
      if (rel === "rig.yaml") {
        const r = validateRigSpecFromYaml(file.content);
        if (!r.valid) errors.push(...r.errors.map((e) => `rig.yaml: ${e}`));
      } else if (rel.endsWith("/agent.yaml")) {
        const r = validateAgentSpecFromYaml(file.content);
        if (!r.valid) errors.push(...r.errors.map((e) => `${rel}: ${e}`));
      }
    }
    return errors;
  }

  preview(input: FactoryTeamInput) {
    const existing = this.read(input.name);
    const { team, files, errors } = this.generate(input, existing);
    const allErrors = [...errors, ...this.validateInMemory(files)];
    const textFiles: Record<string, string> = {};
    for (const [rel, file] of files) {
      textFiles[rel] = file.kind === "text" ? file.content : `(copied from ${file.sourceDir})`;
    }
    return { team, valid: allErrors.length === 0, errors: allErrors, files: textFiles };
  }

  private writeFiles(dir: string, files: Map<string, GeneratedFile>): void {
    for (const [rel, file] of files) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (file.kind === "text") fs.writeFileSync(target, file.content);
      else fs.cpSync(file.sourceDir, target, { recursive: true, dereference: true });
    }
  }

  /** Resolve every member's AgentSpec (imports included) inside a written folder. */
  private validateOnDisk(dir: string, team: FactoryTeam): string[] {
    const errors: string[] = [];
    for (const m of team.members) {
      const r = resolveAgentRef(`local:agents/${m.id}`, dir, realFs);
      if (!r.ok) {
        errors.push(`agents/${m.id}: ${"errors" in r ? r.errors.join("; ") : r.error}`);
        continue;
      }
      const available = new Set([
        ...r.resolved.spec.resources.skills.map((s) => s.id),
        ...r.imports.flatMap((imp) => imp.spec.resources.skills.map((s) => s.id)),
      ]);
      for (const used of r.resolved.spec.profiles["default"]?.uses.skills ?? []) {
        const bare = used.includes(":") ? used.split(":").slice(1).join(":") : used;
        if (!available.has(bare)) errors.push(`agents/${m.id}: skill "${used}" is not declared by the member or the shared spec`);
      }
    }
    return errors;
  }

  save(input: FactoryTeamInput, opts: { createOnly?: boolean } = {}): FactoryTeamDetail {
    const finalDir = this.teamDir(input.name);
    const existing = this.read(input.name);
    if (opts.createOnly && fs.existsSync(finalDir)) {
      throw new FactoryStoreError(409, "team_exists", `A team named "${input.name}" already exists`);
    }
    const { team, files, errors } = this.generate(input, existing);
    const memErrors = [...errors, ...this.validateInMemory(files)];
    if (memErrors.length) throw new FactoryStoreError(422, "invalid_team", "The team does not produce valid specs", memErrors);

    fs.mkdirSync(this.opts.teamsRoot, { recursive: true });
    const suffix = randomBytes(4).toString("hex");
    const staging = path.join(this.opts.teamsRoot, `.staging-${input.name}-${suffix}`);
    const trash = path.join(this.opts.teamsRoot, `.trash-${input.name}-${suffix}`);
    try {
      this.writeFiles(staging, files);
      const diskErrors = this.validateOnDisk(staging, team);
      if (diskErrors.length) throw new FactoryStoreError(422, "invalid_team", "The generated agent specs do not resolve", diskErrors);
      if (fs.existsSync(finalDir)) fs.renameSync(finalDir, trash);
      fs.renameSync(staging, finalDir);
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (fs.existsSync(trash) && !fs.existsSync(finalDir)) fs.renameSync(trash, finalDir);
      throw err;
    }
    fs.rmSync(trash, { recursive: true, force: true });
    return this.detail(team);
  }

  read(name: string): FactoryTeam | null {
    const file = path.join(this.teamDir(name), "factory.json");
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as FactoryTeam;
    } catch {
      return null;
    }
  }

  detail(teamOrName: FactoryTeam | string): FactoryTeamDetail {
    const team = typeof teamOrName === "string" ? this.read(teamOrName) : teamOrName;
    if (!team) throw new FactoryStoreError(404, "team_not_found", `No team named "${String(teamOrName)}"`);
    const folder = this.teamDir(team.name);
    let rigYaml = "";
    try {
      rigYaml = fs.readFileSync(path.join(folder, "rig.yaml"), "utf-8");
    } catch {
      // A team whose folder lost rig.yaml still reports its definition.
    }
    const sessions = Object.fromEntries(team.members.map((m) => [m.id, sessionFor(team, m)]));
    return { team, folder, rigYaml, sessions };
  }

  list(): FactoryTeamSummary[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.opts.teamsRoot).filter((n) => isFactorySlug(n));
    } catch {
      return [];
    }
    const out: FactoryTeamSummary[] = [];
    for (const name of names) {
      const team = this.read(name);
      if (!team) continue;
      out.push({
        name: team.name,
        title: team.title,
        summary: team.summary,
        workflow: team.workflow,
        memberCount: team.members.length,
        deliverableCount: team.members.reduce((n, m) => n + m.deliverables.length, 0),
        members: team.members.map((m) => ({
          id: m.id,
          title: m.title,
          runtime: m.runtime,
          session: sessionFor(team, m),
          deliverables: m.deliverables.length,
        })),
        updatedAt: team.updatedAt,
        folder: this.teamDir(team.name),
      });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  remove(name: string): void {
    const dir = this.teamDir(name);
    if (!fs.existsSync(path.join(dir, "factory.json"))) {
      throw new FactoryStoreError(404, "team_not_found", `No team named "${name}"`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
