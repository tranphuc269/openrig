// Factory Studio — client for /api/factory (team builder).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type FactoryRuntime = "claude-code" | "codex";
export type FactoryWorkflowMode = "sequential" | "parallel";

export interface FactoryDeliverable {
  id: string;
  title: string;
  path: string;
  outline: string;
  acceptance: string;
  /** Word/Excel form id (only for .docx / .xlsx paths). */
  template?: string;
  /** "code": path is a folder of source code, checked by `check` after hand-off. */
  kind?: "code";
  /** Build/test command run in the folder. Empty: the agent's factory-check.sh, else detected. */
  check?: string;
}

export interface FactoryCustomSkill {
  name: string;
  description: string;
  content: string;
}

export interface FactoryMember {
  id: string;
  title: string;
  role: string;
  runtime: FactoryRuntime;
  model?: string;
  effort?: string;
  instructions: string;
  skills: string[];
  customSkills: FactoryCustomSkill[];
  deliverables: FactoryDeliverable[];
}

export type FactoryAutonomy = "ask" | "full";

export interface FactoryTeamInput {
  name: string;
  title: string;
  summary: string;
  workflow: FactoryWorkflowMode;
  /** "full": agents never stop for permission or answers. Absent means "ask". */
  autonomy?: FactoryAutonomy;
  members: FactoryMember[];
}

export interface FactoryTeam extends FactoryTeamInput {
  createdAt: string;
  updatedAt: string;
}

export interface FactoryTeamSummary {
  name: string;
  title: string;
  summary: string;
  workflow: FactoryWorkflowMode;
  autonomy?: FactoryAutonomy;
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

export interface DeliverableTemplate {
  id: string;
  title: string;
  path: string;
  suggestedRole: string;
  outline: string;
  acceptance: string;
  kind?: "code";
  check?: string;
}

export interface FactoryPreview {
  valid: boolean;
  errors: string[];
  files: Record<string, string>;
}

/** Error carrying the daemon's per-field validation messages. */
export class FactoryApiError extends Error {
  constructor(message: string, readonly errors: string[] = [], readonly status = 0) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error bodies fall through to the status message.
  }
  if (!res.ok) {
    const b = (body ?? {}) as { message?: string; errors?: string[] };
    throw new FactoryApiError(b.message ?? `HTTP ${res.status}`, b.errors ?? [], res.status);
  }
  return body as T;
}

const KEY = ["factory"] as const;

export function useFactoryTeams() {
  return useQuery({
    queryKey: [...KEY, "teams"],
    queryFn: () => request<FactoryTeamSummary[]>("/api/factory/teams"),
  });
}

export function useFactoryTeam(name: string | null) {
  return useQuery({
    queryKey: [...KEY, "team", name],
    queryFn: () => request<FactoryTeamDetail>(`/api/factory/teams/${encodeURIComponent(name!)}`),
    enabled: !!name,
  });
}

export function useDeliverableTemplates() {
  return useQuery({
    queryKey: [...KEY, "templates"],
    queryFn: () => request<DeliverableTemplate[]>("/api/factory/templates"),
    staleTime: Infinity,
  });
}

export function usePreviewTeam() {
  return useMutation({
    mutationFn: (team: FactoryTeamInput) =>
      request<FactoryPreview>("/api/factory/teams/preview", { method: "POST", body: JSON.stringify(team) }),
  });
}

export function useSaveTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ team, isNew }: { team: FactoryTeamInput; isNew: boolean }) =>
      isNew
        ? request<FactoryTeamDetail>("/api/factory/teams", { method: "POST", body: JSON.stringify(team) })
        : request<FactoryTeamDetail>(`/api/factory/teams/${encodeURIComponent(team.name)}`, {
            method: "PUT",
            body: JSON.stringify(team),
          }),
    onSuccess: (detail) => {
      qc.setQueryData([...KEY, "team", detail.team.name], detail);
      void qc.invalidateQueries({ queryKey: [...KEY, "teams"] });
      void qc.invalidateQueries({ queryKey: ["spec-library"] });
    },
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      request<{ ok: true }>(`/api/factory/teams/${encodeURIComponent(name)}`, { method: "DELETE" }),
    onSuccess: (_r, name) => {
      qc.removeQueries({ queryKey: [...KEY, "team", name] });
      void qc.invalidateQueries({ queryKey: [...KEY, "teams"] });
    },
  });
}

/** Lowercase-hyphen slug for names and ids. */
export function toSlug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
