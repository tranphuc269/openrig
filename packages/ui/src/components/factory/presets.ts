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
    runtime: "claude-code",
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

// ── Team templates: ready-made teams to start from ──────────────────────
type TemplateDoc = string | FactoryDeliverable;

export interface TeamTemplate {
  id: string;
  /** Default rig name; distinct from OpenRig's built-in rigs (research, code-review, …) so it saves as-is. */
  rigName: string;
  title: string;
  summary: string;
  /** One line for the gallery card. */
  bestFor: string;
  workflow: FactoryTeamInput["workflow"];
  members: Array<{ id: string; title: string; role: string; runtime: FactoryMember["runtime"]; instructions: string; docs: TemplateDoc[] }>;
}

const doc = (id: string, title: string, path: string, outline: string, acceptance: string): FactoryDeliverable => ({ id, title, path, outline, acceptance });

export const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: "product-docs",
    rigName: "product-docs",
    title: "Product Docs Team",
    summary: "Turns an idea into requirements, a system design, an API spec and a test plan.",
    bestFor: "Planning a new product or a big feature",
    workflow: "sequential",
    members: [
      { id: "product-analyst", title: "Product Analyst", role: "product-analyst", runtime: "claude-code", instructions: MEMBER_PRESETS[0]!.instructions, docs: ["prd"] },
      { id: "architect", title: "Solution Architect", role: "architect", runtime: "claude-code", instructions: MEMBER_PRESETS[1]!.instructions, docs: ["system-design"] },
      { id: "backend", title: "Backend Engineer", role: "backend", runtime: "claude-code", instructions: MEMBER_PRESETS[2]!.instructions, docs: ["api-spec", "db-design"] },
      { id: "qa", title: "QA Engineer", role: "qa", runtime: "claude-code", instructions: MEMBER_PRESETS[3]!.instructions, docs: ["test-plan"] },
    ],
  },
  {
    id: "feature-delivery",
    rigName: "feature-team",
    title: "Feature Delivery Team",
    summary: "Designs, builds and verifies one feature in your codebase.",
    bestFor: "Shipping a feature end to end",
    workflow: "sequential",
    members: [
      { id: "architect", title: "Tech Lead", role: "architect", runtime: "claude-code", instructions: "Read the codebase and plan the change: which files, which approach, what could break. Keep the plan small and concrete.", docs: [doc("plan", "Implementation Plan", "docs/feature/plan.md", "# Implementation plan\n## Goal\n## Approach\n## Files to change\n## Risks\n## Test plan", "Names every file to change and how to verify it.")] },
      { id: "developer", title: "Developer", role: "developer", runtime: "claude-code", instructions: "Implement the plan in the codebase with tests. Keep commits small. Summarise what you changed.", docs: [doc("changes", "Change Summary", "docs/feature/changes.md", "# What changed\n## Summary\n## Files\n## How to try it\n## Follow-ups", "Lists every changed file and how to run the new tests.")] },
      { id: "qa", title: "QA Engineer", role: "qa", runtime: "claude-code", instructions: "Verify the feature by actually running it and its tests. Report what works, what doesn't, with evidence.", docs: [doc("verification", "Verification Report", "docs/feature/verification.md", "# Verification\n## What I tested\n## Results (pass/fail with evidence)\n## Bugs found\n## Verdict", "Every acceptance criterion has a pass/fail with evidence.")] },
    ],
  },
  {
    id: "bug-fix",
    rigName: "bug-fix-squad",
    title: "Bug Fix Squad",
    summary: "Finds the root cause of a bug, fixes it and proves the fix.",
    bestFor: "A bug report you want fixed properly",
    workflow: "sequential",
    members: [
      { id: "investigator", title: "Investigator", role: "investigator", runtime: "claude-code", instructions: "Reproduce the bug, then find the root cause. Don't fix it yet; explain it.", docs: [doc("root-cause", "Root Cause Report", "docs/bugs/root-cause.md", "# Root cause\n## How to reproduce\n## What happens vs expected\n## Root cause (file:line)\n## Proposed fix", "Includes exact reproduction steps and the file/line at fault.")] },
      { id: "fixer", title: "Fixer", role: "developer", runtime: "claude-code", instructions: "Fix the root cause described by the investigator, with a regression test that fails before the fix.", docs: [doc("fix", "Fix Notes", "docs/bugs/fix.md", "# Fix\n## Change\n## Regression test\n## Side effects checked", "Names the regression test and shows it failing before the fix.")] },
      { id: "qa", title: "Verifier", role: "qa", runtime: "claude-code", instructions: "Confirm the bug is gone using the original reproduction, and that nothing nearby broke.", docs: [doc("verify", "Verification", "docs/bugs/verification.md", "# Verification\n## Original repro: result\n## Related checks\n## Verdict", "The original reproduction now passes.")] },
    ],
  },
  {
    id: "code-review",
    rigName: "review-pair",
    title: "Code Review Pair",
    summary: "Two independent reviewers look at the same change from different angles.",
    bestFor: "A second and third opinion before merging",
    workflow: "parallel",
    members: [
      { id: "reviewer-claude", title: "Reviewer A", role: "reviewer", runtime: "claude-code", instructions: "Review the change for bugs, security issues and missing tests. Rank findings by severity with file:line.", docs: [doc("review-claude", "Review A", "docs/review/claude.md", "# Review\n## Summary\n## Findings (severity, file:line, why, fix)\n## Verdict", "Every finding has a severity and a file:line.")] },
      { id: "reviewer-codex", title: "Reviewer B", role: "reviewer", runtime: "claude-code", instructions: "Review the change for bugs, security issues and missing tests. Rank findings by severity with file:line.", docs: [doc("review-codex", "Review B", "docs/review/codex.md", "# Review\n## Summary\n## Findings (severity, file:line, why, fix)\n## Verdict", "Every finding has a severity and a file:line.")] },
    ],
  },
  {
    id: "research",
    rigName: "research-proposal",
    title: "Research & Proposal",
    summary: "Researches a question, then writes a recommendation you can share.",
    bestFor: "Choosing a technology or an approach",
    workflow: "sequential",
    members: [
      { id: "researcher", title: "Researcher", role: "researcher", runtime: "claude-code", instructions: "Research the question: options, trade-offs, evidence. Cite sources. Separate facts from opinions.", docs: [doc("research", "Research Notes", "docs/research/notes.md", "# Research\n## Question\n## Options\n## Comparison table\n## Sources", "Compares at least three options with sources.")] },
      { id: "writer", title: "Proposal Writer", role: "writer", runtime: "claude-code", instructions: "Turn the research into a clear recommendation for decision makers: one page, plain language.", docs: [doc("proposal", "Proposal", "docs/research/proposal.md", "# Proposal\n## Recommendation\n## Why\n## Costs and risks\n## Next steps", "States one clear recommendation and its main risk.")] },
    ],
  },
];

/** Build an editable team from a template (deliverable template ids resolved against the server's templates). */
export function teamFromTemplate(t: TeamTemplate, deliverableTemplates: DeliverableTemplate[]): FactoryTeamInput {
  return {
    name: t.rigName,
    title: t.title,
    summary: t.summary,
    workflow: t.workflow,
    members: t.members.map((m) => ({
      id: m.id,
      title: m.title,
      role: m.role,
      runtime: m.runtime,
      instructions: m.instructions,
      skills: [],
      customSkills: [],
      deliverables: m.docs
        .map((d) => (typeof d === "string" ? deliverableTemplates.find((x) => x.id === d) : d))
        .filter((d): d is DeliverableTemplate | FactoryDeliverable => !!d)
        .map((d) => ("suggestedRole" in d ? deliverableFromTemplate(d) : d)),
    })),
  };
}
