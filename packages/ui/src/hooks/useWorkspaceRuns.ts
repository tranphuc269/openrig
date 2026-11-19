// Agent Workspace — client for /api/factory/runs.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FactoryApiError } from "./useFactory.js";

export type RunStatus = "launching" | "running" | "failed" | "stopped";
export type RunPhase = "launching" | "failed" | "stopped" | "working" | "review" | "approved";
export type MemberPhase = "waiting" | "working" | "needs_input" | "delivered" | "approved" | "rework" | "offline";
export type ReviewDecision = "pending" | "approved" | "rework";

export interface RunEvent {
  at: string;
  kind: string;
  message: string;
  member?: string;
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
  reviews: Record<string, { status: ReviewDecision; feedback?: string; rounds: number; updatedAt: string }>;
  events: RunEvent[];
}

export interface RunDeliverable {
  id: string;
  title: string;
  path: string;
  exists: boolean;
  size: number | null;
  modifiedAt: string | null;
  review: { status: ReviewDecision; feedback?: string; rounds: number; updatedAt?: string };
}

export interface RunMember {
  id: string;
  title: string;
  runtime: string;
  session: string;
  phase: MemberPhase;
  seat: { sessionStatus: string | null; startupStatus: string | null; activity: string | null } | null;
  deliverables: RunDeliverable[];
}

export interface RunDetail {
  run: FactoryRun;
  phase: RunPhase;
  workflow: "sequential" | "parallel" | null;
  teamMissing: boolean;
  members: RunMember[];
  progress: { delivered: number; approved: number; total: number };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // fall through
  }
  if (!res.ok) {
    const b = (body ?? {}) as { message?: string; error?: string };
    throw new FactoryApiError(b.message ?? b.error ?? `HTTP ${res.status}`, [], res.status);
  }
  return body as T;
}

const KEY = ["factory", "runs"] as const;

export function useRuns() {
  return useQuery({
    queryKey: [...KEY],
    queryFn: () => request<FactoryRun[]>("/api/factory/runs"),
    refetchInterval: 10_000,
  });
}

export function useRunDetail(id: string) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => request<RunDetail>(`/api/factory/runs/${encodeURIComponent(id)}`),
    refetchInterval: (q) => {
      const phase = q.state.data?.phase;
      return phase === "stopped" || phase === "failed" ? false : phase === "launching" ? 2_000 : 5_000;
    },
  });
}

export function outputUrl(runId: string, member: string, deliverable: string, download = false): string {
  const base = `/api/factory/runs/${encodeURIComponent(runId)}/outputs/${encodeURIComponent(member)}/${encodeURIComponent(deliverable)}`;
  return download ? `${base}?download=1` : base;
}

/** Content of one output; refetched when its modification time changes. */
export function useRunOutput(runId: string, member: string | null, deliverable: string | null, version: string | null) {
  return useQuery({
    queryKey: [...KEY, runId, "output", member, deliverable, version],
    enabled: !!member && !!deliverable && !!version,
    queryFn: async () => {
      const res = await fetch(outputUrl(runId, member!, deliverable!));
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(b.message ?? `HTTP ${res.status}`);
      }
      return res.text();
    },
  });
}

export function useMemberScreen(runId: string, member: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, runId, "screen", member],
    enabled: !!member && enabled,
    queryFn: () => request<{ content: string; capturedAt: string }>(`/api/factory/runs/${encodeURIComponent(runId)}/screen/${encodeURIComponent(member!)}`),
    refetchInterval: 4_000,
    retry: false,
  });
}

function useRunMutation<TVars>(runId: string, fn: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, runId] });
      void qc.invalidateQueries({ queryKey: [...KEY], exact: true });
    },
  });
}

export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { team: string; task: string; projectDir: string }) =>
      request<FactoryRun>("/api/factory/runs", { method: "POST", body: JSON.stringify(vars) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...KEY] }),
  });
}

export function useReview(runId: string) {
  return useRunMutation(runId, (vars: { member: string; deliverable: string; decision: ReviewDecision; feedback?: string }) =>
    request<FactoryRun>(`/api/factory/runs/${encodeURIComponent(runId)}/review`, { method: "POST", body: JSON.stringify(vars) }));
}

export function useMessageMember(runId: string) {
  return useRunMutation(runId, (vars: { member: string; text: string }) =>
    request<FactoryRun>(`/api/factory/runs/${encodeURIComponent(runId)}/message`, { method: "POST", body: JSON.stringify(vars) }));
}

export function useStopRun(runId: string) {
  return useRunMutation(runId, () =>
    request<FactoryRun>(`/api/factory/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" }));
}

// ── Requests addressed to you (GET /api/attention) ────────────────────────
export interface AttentionAsk {
  id: string;
  kind: string;
  summary: string;
  asker?: string;
  recipient?: string | null;
  answer?: { verb: "answer" | "approve" | "resolve"; actorSession: string };
  humanQuestions?: unknown[];
  urgency?: string;
  at?: string;
  unblocks?: string;
}

/** Open requests from any of `sessions` that you can answer here. */
export function useTeamAsks(sessions: string[], enabled: boolean) {
  return useQuery({
    queryKey: ["attention", "team-asks", sessions.join(",")],
    enabled: enabled && sessions.length > 0,
    refetchInterval: 8_000,
    queryFn: async () => {
      const res = await fetch("/api/attention");
      if (!res.ok) return [] as AttentionAsk[];
      const body = (await res.json()) as { items?: AttentionAsk[] };
      const wanted = new Set(sessions);
      return (body.items ?? []).filter((i) => i.answer && i.id.startsWith("queue:") && i.asker && wanted.has(i.asker));
    },
  });
}
