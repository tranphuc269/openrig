// Factory Studio — team definition model and input validation.
//
// A Factory Studio team is the person-facing source of truth (factory.json).
// From it the generator writes a normal OpenRig RigSpec + one AgentSpec per
// member, so a saved team launches with `rig up <name>` like any other rig.

export const FACTORY_RUNTIMES = ["claude-code", "codex"] as const;
export type FactoryRuntime = (typeof FACTORY_RUNTIMES)[number];

export const FACTORY_WORKFLOW_MODES = ["sequential", "parallel"] as const;
export type FactoryWorkflowMode = (typeof FACTORY_WORKFLOW_MODES)[number];

export interface FactoryDeliverable {
  id: string;
  title: string;
  /** Output path relative to the team's working directory. */
  path: string;
  outline: string;
  acceptance: string;
  /** Word/Excel form to follow (office template library id). Only for .docx / .xlsx paths. */
  template?: string;
}

/** The kind of file a deliverable is, from its path. */
export function deliverableFormat(p: string): "markdown" | "docx" | "xlsx" | "other" {
  if (/\.docx$/i.test(p)) return "docx";
  if (/\.xlsx$/i.test(p)) return "xlsx";
  if (/\.(md|markdown)$/i.test(p)) return "markdown";
  return "other";
}

const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{2,80}$/;

export interface FactoryCustomSkill {
  name: string;
  description: string;
  /** SKILL.md body (without frontmatter). */
  content: string;
}

export interface FactoryMember {
  id: string;
  title: string;
  /** Short role slug, written to the RigSpec member `role`. */
  role: string;
  runtime: FactoryRuntime;
  model?: string;
  effort?: string;
  /** What this member does, in the person's own words. */
  instructions: string;
  /** Skill library ids (GET /api/skills/library). */
  skills: string[];
  customSkills: FactoryCustomSkill[];
  deliverables: FactoryDeliverable[];
}

export interface FactoryTeam {
  name: string;
  title: string;
  summary: string;
  workflow: FactoryWorkflowMode;
  members: FactoryMember[];
  createdAt: string;
  updatedAt: string;
}

export type FactoryTeamInput = Omit<FactoryTeam, "createdAt" | "updatedAt">;

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_TEXT = 20_000;

export function isFactorySlug(value: unknown): value is string {
  return typeof value === "string" && SLUG.test(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function shortText(value: unknown, field: string, errors: string[], opts: { required?: boolean; max?: number } = {}): string {
  const text = str(value);
  if (opts.required && !text) errors.push(`${field}: required`);
  if (text.length > (opts.max ?? 200)) errors.push(`${field}: too long (max ${opts.max ?? 200} characters)`);
  if (/[\r\n]/.test(text)) errors.push(`${field}: must be a single line`);
  return text;
}

function longText(value: unknown, field: string, errors: string[]): string {
  const text = typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
  if (text.length > MAX_TEXT) errors.push(`${field}: too long (max ${MAX_TEXT} characters)`);
  return text;
}

function slug(value: unknown, field: string, errors: string[]): string {
  const text = str(value);
  if (!isFactorySlug(text)) errors.push(`${field}: use lowercase letters, numbers and hyphens, starting with a letter or number (got "${text}")`);
  return text;
}

/** A relative path that stays inside the working directory. */
export function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value)) return false;
  if (value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((part) => part !== ".." && part !== "" && part !== ".");
}

/** Validate untrusted JSON into a team definition. Returns errors instead of throwing. */
export function parseFactoryTeamInput(raw: unknown): { ok: true; team: FactoryTeamInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["body: must be a JSON object"] };
  const body = raw as Record<string, unknown>;

  const name = slug(body.name, "name", errors);
  const title = shortText(body.title, "title", errors, { required: true });
  const summary = shortText(body.summary, "summary", errors, { max: 500 });
  const workflow = str(body.workflow) || "sequential";
  if (!(FACTORY_WORKFLOW_MODES as readonly string[]).includes(workflow)) {
    errors.push(`workflow: must be one of ${FACTORY_WORKFLOW_MODES.join(", ")}`);
  }

  const rawMembers = Array.isArray(body.members) ? body.members : [];
  if (rawMembers.length === 0) errors.push("members: add at least one member");
  if (rawMembers.length > 16) errors.push("members: at most 16 members");

  const memberIds = new Set<string>();
  const outputPaths = new Map<string, string>();
  const members: FactoryMember[] = rawMembers.map((rm, mi) => {
    const p = `members[${mi}]`;
    const m = (rm && typeof rm === "object" ? rm : {}) as Record<string, unknown>;
    const id = slug(m.id, `${p}.id`, errors);
    if (memberIds.has(id)) errors.push(`${p}.id: duplicate member id "${id}"`);
    memberIds.add(id);

    // Every member runs on Claude Code with the API key, base URL and model from Settings
    // (GET /api/factory/settings/agent-api). A runtime or model sent by an older client is ignored.
    const runtime: FactoryRuntime = "claude-code";
    const model = undefined as string | undefined;
    const effort = shortText(m.effort, `${p}.effort`, errors, { max: 40 });

    const skills = Array.isArray(m.skills) ? m.skills.map(str).filter(Boolean) : [];
    if (new Set(skills).size !== skills.length) errors.push(`${p}.skills: duplicate skill`);

    const rawCustom = Array.isArray(m.customSkills) ? m.customSkills : [];
    const customNames = new Set<string>();
    const customSkills: FactoryCustomSkill[] = rawCustom.map((rc, ci) => {
      const cp = `${p}.customSkills[${ci}]`;
      const c = (rc && typeof rc === "object" ? rc : {}) as Record<string, unknown>;
      const cname = slug(c.name, `${cp}.name`, errors);
      if (customNames.has(cname)) errors.push(`${cp}.name: duplicate custom skill "${cname}"`);
      customNames.add(cname);
      const content = longText(c.content, `${cp}.content`, errors);
      if (!content) errors.push(`${cp}.content: required`);
      return {
        name: cname,
        description: shortText(c.description, `${cp}.description`, errors, { required: true, max: 300 }),
        content,
      };
    });

    const rawDeliverables = Array.isArray(m.deliverables) ? m.deliverables : [];
    const deliverableIds = new Set<string>();
    const deliverables: FactoryDeliverable[] = rawDeliverables.map((rd, di) => {
      const dp = `${p}.deliverables[${di}]`;
      const d = (rd && typeof rd === "object" ? rd : {}) as Record<string, unknown>;
      const did = slug(d.id, `${dp}.id`, errors);
      if (deliverableIds.has(did)) errors.push(`${dp}.id: duplicate deliverable id "${did}"`);
      deliverableIds.add(did);
      const outPath = str(d.path);
      if (!isSafeRelativePath(outPath)) {
        errors.push(`${dp}.path: must be a relative path inside the project, without ".." (got "${outPath}")`);
      } else {
        const owner = outputPaths.get(outPath);
        if (owner) errors.push(`${dp}.path: "${outPath}" is already the output of ${owner}`);
        outputPaths.set(outPath, `${id}/${did}`);
      }
      const template = str(d.template);
      if (template) {
        if (!TEMPLATE_ID.test(template)) errors.push(`${dp}.template: invalid form id "${template}"`);
        else if (deliverableFormat(outPath) !== "docx" && deliverableFormat(outPath) !== "xlsx") {
          errors.push(`${dp}.template: a form can only be used for a .docx or .xlsx document`);
        }
      }
      return {
        id: did,
        title: shortText(d.title, `${dp}.title`, errors, { required: true }),
        path: outPath,
        outline: longText(d.outline, `${dp}.outline`, errors),
        acceptance: longText(d.acceptance, `${dp}.acceptance`, errors),
        ...(template ? { template } : {}),
      };
    });

    return {
      id,
      title: shortText(m.title, `${p}.title`, errors, { required: true }),
      role: str(m.role) ? slug(m.role, `${p}.role`, errors) : id,
      runtime: runtime as FactoryRuntime,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      instructions: longText(m.instructions, `${p}.instructions`, errors),
      skills,
      customSkills,
      deliverables,
    };
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, team: { name, title, summary, workflow: workflow as FactoryWorkflowMode, members } };
}
