// Usage & cost — reads the daemon's provider usage model and per-seat cost view.
//   GET /api/provider/status        plan-limit windows per signed-in account + seat accounts (memory-only read)
//   GET /api/telemetry/usage/cost   what each seat's harness reports about cost, beside its tokens
// Both are passive reads: they never trigger a provider lookup. Figures are shown as served; a missing
// figure reads as missing, never as $0.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type Row = Record<string, unknown>;

export interface UsageWindow {
  window?: string;
  durationMins?: number;
  remainingPercent?: number | null;
  level?: string;
  levelReason?: string;
  freshness?: string;
  freshnessReason?: string;
  resetsAt?: string | null;
  observedAt?: string | null;
  seatSession?: string;
  status?: string;
}

export interface UsageRow {
  provider?: string;
  identity?: Row | null;
  windows?: UsageWindow[];
  seats?: number | string;
  currentAvailability?: string;
  unavailableReason?: string;
  lastRefresh?: Row | null;
  signIn?: Row;
}

export interface ProviderStatus {
  usage?: UsageRow[];
  seatAccounts?: Row[];
  accounts?: Row[];
  asOf?: string;
}

export interface CostSeat {
  seatSession: string;
  runtime?: string;
  status: string;
  costUsd?: number | null;
  tokens?: { input?: number | null; output?: number | null } | null;
  window?: { since?: string | null; asOf?: string | null } | null;
  stale?: boolean;
  reason?: string;
  note?: string;
}

export interface CostView {
  seats: CostSeat[];
  note?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  return body;
}

export function useProviderStatus() {
  return useQuery({
    queryKey: ["usage", "provider-status"],
    queryFn: () => getJson<ProviderStatus>("/api/provider/status"),
    refetchInterval: 30_000,
  });
}

export function useCostView(opts: { refetchMs?: number } = {}) {
  return useQuery({
    queryKey: ["usage", "cost"],
    queryFn: () => getJson<CostView>("/api/telemetry/usage/cost"),
    refetchInterval: opts.refetchMs ?? 30_000,
  });
}

/** Turns on plan-limit tracking (provider.usage_windows). The daemon may need a restart to adopt it. */
export function useEnableUsageWindows() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/config/${encodeURIComponent("provider.usage_windows")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["usage"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

/** "$1.23"; a real amount below a cent reads "<$0.01", never "$0.00". */
export function formatUsd(value: number): string {
  return value > 0 && value < 0.005 ? "<$0.01" : `$${value.toFixed(2)}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function windowLabel(w: UsageWindow): string {
  if (w.durationMins === 300) return "5-hour limit";
  if (w.durationMins === 10080) return "Weekly limit";
  if (typeof w.durationMins === "number") return `${w.durationMins}-minute limit`;
  return w.window ?? "Limit";
}

/** Sum of the seats whose harness reported a cost. Seats without a figure are counted separately, never as $0. */
export function costTotals(seats: CostSeat[]) {
  const reported = seats.filter((s) => s.status === "reported" && typeof s.costUsd === "number");
  return {
    usd: reported.reduce((n, s) => n + (s.costUsd as number), 0),
    reportedSeats: reported.length,
    unreportedSeats: seats.length - reported.length,
    tokensIn: seats.reduce((n, s) => n + (s.tokens?.input ?? 0), 0),
    tokensOut: seats.reduce((n, s) => n + (s.tokens?.output ?? 0), 0),
  };
}
