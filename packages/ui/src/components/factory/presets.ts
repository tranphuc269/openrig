// Factory Studio — member presets and empty values.
import type { DeliverableTemplate, FactoryDeliverable, FactoryMember, FactoryTeamInput } from "../../hooks/useFactory.js";

export interface MemberPreset {
  id: string;
  title: string;
  role: string;
  runtime: FactoryMember["runtime"];
  instructions: string;
  /** Deliverable template ids added with the preset. */
  templates: string[];
}

export const MEMBER_PRESETS: MemberPreset[] = [
  {
    id: "product-analyst",
    title: "Product Analyst",
    role: "product-analyst",
    runtime: "claude-code",
    instructions: "Turn the task into clear, testable requirements. Ask about anything ambiguous instead of guessing.",
    templates: ["prd"],
  },
  {
    id: "architect",
    title: "Solution Architect",
    role: "architect",
    runtime: "claude-code",
    instructions: "Design the system that satisfies the requirements: components, data model, key flows and trade-offs.",
    templates: ["system-design"],
  },
  {
    id: "backend",
    title: "Backend Engineer",
    role: "backend",
    runtime: "codex",
    instructions: "Specify the API and database from the system design. Keep it consistent with the data model.",
    templates: ["api-spec", "db-design"],
  },
  {
    id: "qa",
    title: "QA Engineer",
    role: "qa",
    runtime: "claude-code",
    instructions: "Plan how to verify every requirement. Map each requirement to test cases.",
    templates: ["test-plan"],
  },
  {
    id: "devops",
    title: "DevOps Engineer",
    role: "devops",
    runtime: "claude-code",
    instructions: "Describe how the system is built, deployed, configured, monitored and rolled back.",
    templates: ["deployment-guide"],
  },
];

export function deliverableFromTemplate(t: DeliverableTemplate): FactoryDeliverable {
  return { id: t.id, title: t.title, path: t.path, outline: t.outline, acceptance: t.acceptance };
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const root = base || "item";
  if (!used.has(root)) return root;
  let n = 2;
  while (used.has(`${root}-${n}`)) n++;
  return `${root}-${n}`;
}

export function memberFromPreset(preset: MemberPreset | null, templates: DeliverableTemplate[], takenIds: string[]): FactoryMember {
  if (!preset) {
    return {
      id: uniqueId("member", takenIds),
      title: "New member",
      role: "",
      runtime: "claude-code",
      instructions: "",
      skills: [],
      customSkills: [],
      deliverables: [],
    };
  }
  return {
    id: uniqueId(preset.id, takenIds),
    title: preset.title,
    role: preset.role,
    runtime: preset.runtime,
    instructions: preset.instructions,
    skills: [],
    customSkills: [],
    deliverables: preset.templates
      .map((id) => templates.find((t) => t.id === id))
      .filter((t): t is DeliverableTemplate => !!t)
      .map(deliverableFromTemplate),
  };
}

export function emptyTeam(): FactoryTeamInput {
  return { name: "", title: "", summary: "", workflow: "sequential", members: [] };
}

export const EFFORT_LEVELS: Record<FactoryMember["runtime"], string[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max"],
};
