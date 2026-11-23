import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { parse } from "yaml";
import { generateTeamFiles } from "../src/domain/factory-studio/generator.js";
import { parseFactoryTeamInput, type FactoryTeam } from "../src/domain/factory-studio/team.js";
import { validateRigSpecFromYaml } from "../src/domain/spec-validation-service.js";
import { claudePostureFlag } from "../src/adapters/yolo-mode.js";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";

const SHARED_AGENT_DIR = resolve(import.meta.dirname, "..", "specs", "agents", "shared");
const opts = { sharedAgentDir: SHARED_AGENT_DIR, sharedSkillIds: new Set<string>(), resolveSkill: () => null };

function team(autonomy?: "ask" | "full"): FactoryTeam {
  return {
    name: "auto-team", title: "Auto Team", summary: "", workflow: "sequential", createdAt: "", updatedAt: "",
    ...(autonomy ? { autonomy } : {}),
    members: [{ id: "pa", title: "PA", role: "pa", runtime: "claude-code", instructions: "", skills: [], customSkills: [], deliverables: [] }],
  };
}

const text = (files: Map<string, unknown>, key: string) => (files.get(key) as { content: string }).content;

describe("team autonomy", () => {
  it("defaults to ask and only stores full", () => {
    const base = { name: "t", title: "T", members: [{ id: "a", title: "A" }] };
    const ask = parseFactoryTeamInput(base);
    expect(ask.ok && ask.team.autonomy).toBeUndefined();
    const full = parseFactoryTeamInput({ ...base, autonomy: "full" });
    expect(full.ok && full.team.autonomy).toBe("full");
    expect(parseFactoryTeamInput({ ...base, autonomy: "yolo" }).ok).toBe(false);
  });

  it("full auto puts the rig on the yolo policy, non-interruptive, and tells agents not to wait", () => {
    const { files } = generateTeamFiles(team("full"), opts);
    const rig = text(files, "rig.yaml");
    expect(parse(rig)).toMatchObject({ permission_policy: "builtin:yolo", non_interruptive: true });
    expect(validateRigSpecFromYaml(rig).valid).toBe(true);
    expect(text(files, "CULTURE.md")).toContain("full auto");
  });

  it("ask keeps the default permission floor", () => {
    const { files } = generateTeamFiles(team(), opts);
    const rig = parse(text(files, "rig.yaml")) as Record<string, unknown>;
    expect(rig.permission_policy).toBeUndefined();
    expect(rig.non_interruptive).toBeUndefined();
    expect(text(files, "CULTURE.md")).not.toContain("full auto");
  });

  it("a full_bypass Claude seat skips permissions and the bypass warning", () => {
    expect(claudePostureFlag({}, "full_bypass")).toContain("--dangerously-skip-permissions");
    expect(operationalLaunchArgs("claude-code", { launchPosture: "full_bypass", nonInterruptive: true, managedCompaction: false }).join(" "))
      .toContain("skipDangerousModePermissionPrompt");
  });
});
