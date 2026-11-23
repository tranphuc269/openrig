// Readiness + folder picker — client for /api/factory/readiness and /api/factory/fs/*.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type CheckState = "ok" | "warn" | "fail" | "unknown";

export interface ReadinessCheck {
  id: string;
  title: string;
  state: CheckState;
  detail: string;
  fixCommand?: string;
  fixAction?: "register-person" | "enable-usage" | "check-sign-in";
  required: boolean;
}

export interface ReadinessReport {
  checkedAt: string;
  ready: boolean;
  checks: ReadinessCheck[];
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  return body;
}

export function useReadiness(opts: { refetchMs?: number | false } = {}) {
  return useQuery({
    queryKey: ["readiness"],
    queryFn: () => json<ReadinessReport>("/api/factory/readiness"),
    refetchInterval: opts.refetchMs ?? false,
    staleTime: 15_000,
  });
}

export function useRegisterPerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { entityId: string; displayName: string }) =>
      json<{ ok: true; entityId: string; address: string }>("/api/factory/readiness/person", { method: "POST", body: JSON.stringify(v) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["readiness"] }),
  });
}

/** Ask the daemon to read Claude and Codex sign-in and limits now (POST /api/provider/usage/refresh). */
export function useCheckSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(
        (["claude", "codex"] as const).map((provider) =>
          json("/api/provider/usage/refresh", { method: "POST", body: JSON.stringify({ provider }) })),
      );
      const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      if (failed.length === results.length) throw failed[0]!.reason;
      return results;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["readiness"] });
      void qc.invalidateQueries({ queryKey: ["usage"] });
    },
  });
}

export interface FolderListing {
  path: string;
  parent: string | null;
  home: string;
  entries: Array<{ name: string; path: string; isGitRepo: boolean }>;
}

export function useFolders(path: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["fs", "folders", path ?? "~"],
    enabled,
    queryFn: () => json<FolderListing>(`/api/factory/fs/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  });
}

export interface FolderCheck {
  path: string;
  valid: boolean;
  reason?: string | null;
  isGitRepo?: boolean;
  hasDocs?: boolean;
}

export function useFolderCheck(path: string) {
  const trimmed = path.trim();
  return useQuery({
    queryKey: ["fs", "check", trimmed],
    enabled: trimmed.length > 1,
    queryFn: () => json<FolderCheck>(`/api/factory/fs/check?path=${encodeURIComponent(trimmed)}`),
    staleTime: 5_000,
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => json<{ ok: true; path: string }>("/api/factory/fs/folders", { method: "POST", body: JSON.stringify({ path }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["fs"] }),
  });
}
