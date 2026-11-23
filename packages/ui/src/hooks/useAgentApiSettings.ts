// Agent API settings — client for /api/factory/settings/agent-api.
// The server never returns the key, only its last 4 characters.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface AgentApiSettings {
  source: "settings" | "environment" | "none";
  hasKey: boolean;
  keyHint: string | null;
  baseUrl: string | null;
  model: string | null;
  saved: { baseUrl: string | null; model: string | null };
  environment: { hasKey: boolean; baseUrl: string | null; model: string | null };
  updatedAt: string | null;
}

export interface AgentApiTestResult { ok: boolean; message: string; status?: number }

export class SettingsError extends Error {
  constructor(message: string, readonly field?: string) { super(message); }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string; field?: string };
  if (!res.ok) throw new SettingsError(body.message ?? body.error ?? `HTTP ${res.status}`, body.field);
  return body;
}

const URL_ = "/api/factory/settings/agent-api";

export function useAgentApiSettings() {
  return useQuery({ queryKey: ["agent-api-settings"], queryFn: () => json<AgentApiSettings>(URL_) });
}

function useInvalidate() {
  const qc = useQueryClient();
  return (data: AgentApiSettings) => {
    qc.setQueryData(["agent-api-settings"], data);
    void qc.invalidateQueries({ queryKey: ["readiness"] });
  };
}

export function useSaveAgentApiSettings() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (input: { apiKey?: string; baseUrl?: string | null; model?: string | null }) =>
      json<AgentApiSettings>(URL_, { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: done,
  });
}

export function useClearAgentApiKey() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: () => json<AgentApiSettings>(`${URL_}/key`, { method: "DELETE" }),
    onSuccess: done,
  });
}

export function useTestAgentApi() {
  return useMutation({
    mutationFn: () => json<AgentApiTestResult>(`${URL_}/test`, { method: "POST", body: "{}" }),
  });
}
