// Usage & cost (/usage) — plan limits per signed-in account and what each agent has cost.
import { AlertCircle, CircleDollarSign, Gauge, Info, Power, RefreshCw, Users } from "lucide-react";
import {
  costTotals,
  formatTokens,
  formatUsd,
  useCostView,
  useEnableUsageWindows,
  useProviderStatus,
  windowLabel,
  type CostSeat,
  type Row,
  type UsageRow,
  type UsageWindow,
} from "../../hooks/useUsageCost.js";
import { Alert, Avatar, Button, EmptyState, Page, PageHeader, Panel, Pill, type Tone } from "../factory/fields.js";

const str = (v: unknown, fallback = "—") => (v === null || v === undefined || v === "" ? fallback : String(v));

function providerName(p: unknown): string {
  return p === "claude" ? "Claude" : p === "codex" ? "Codex" : str(p, "Provider");
}

function identityText(id: Row | null | undefined, signIn?: Row): string {
  if (!id) return signIn?.["state"] === "needs_sign_in" ? "Not signed in" : "Not checked yet";
  if (id["email"]) return String(id["email"]);
  if (id["orgName"]) return String(id["orgName"]);
  if (id["accountId"]) return `Account ${id["accountId"]}`;
  if (id["workspaceId"]) return `Workspace ${id["workspaceId"]}`;
  return "Identity not resolved yet";
}

function when(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  const abs = Math.abs(mins);
  const rel = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  return mins >= 0 ? `in ${rel}` : `${rel} ago`;
}

function levelTone(w: UsageWindow): Tone {
  const left = w.remainingPercent;
  if (typeof left !== "number") return "neutral";
  if (left <= 10) return "danger";
  if (left <= 30) return "warning";
  return "success";
}

function LimitBar({ w }: { w: UsageWindow }) {
  const left = typeof w.remainingPercent === "number" ? Math.max(0, Math.min(100, w.remainingPercent)) : null;
  const used = left === null ? null : 100 - left;
  const tone = levelTone(w);
  const color = tone === "danger" ? "var(--fx-danger)" : tone === "warning" ? "var(--fx-warning)" : "var(--fx-success)";
  return (
    <div className="flex flex-col gap-1.5" data-testid="usage-window">
      <div className="flex items-baseline justify-between gap-2">
        <span className="fx-h3">{windowLabel(w)}</span>
        <span className="text-[13px] font-semibold" style={{ color: left === null ? "var(--fx-subtle)" : color }}>
          {left === null ? "Unknown" : `${left}% left`}
        </span>
      </div>
      <div className="fx-progress">
        <span style={{ width: `${used ?? 0}%`, background: color }} />
      </div>
      <div className="fx-tiny flex flex-wrap gap-x-3">
        <span>Resets {when(w.resetsAt)}</span>
        <span>Checked {when(w.observedAt)}</span>
        {w.freshness && w.freshness !== "fresh" ? <span>· {w.freshnessReason ?? w.freshness}</span> : null}
      </div>
    </div>
  );
}

function AccountCard({ row }: { row: UsageRow }) {
  const windows = row.windows ?? [];
  const failed = (row.lastRefresh as Row | null | undefined)?.["outcome"] === "failed";
  const plan = [row.identity?.["planType"], row.identity?.["subscriptionType"]].filter(Boolean).join(" · ");
  return (
    <div className="fx-card flex flex-col gap-4 p-5" data-testid="usage-account">
      <div className="flex items-start gap-3">
        <Avatar name={providerName(row.provider)} colorKey={String(row.provider)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="fx-h2">{providerName(row.provider)}</span>
            {plan ? <Pill tone="primary">{plan}</Pill> : null}
          </div>
          <div className="fx-small truncate">{identityText(row.identity, row.signIn)}</div>
        </div>
        {row.seats !== undefined ? <Pill><Users className="h-3.5 w-3.5" /> {str(row.seats)} agents</Pill> : null}
      </div>
      {windows.length ? (
        <div className="flex flex-col gap-4">
          {windows.map((w, i) => <LimitBar key={i} w={w} />)}
        </div>
      ) : (
        <p className="fx-small">
          {row.lastRefresh ? row.unavailableReason ?? "No limit reading yet." : <>No reading yet. Limits appear after the next check: <code>rig provider status --refresh</code></>}
        </p>
      )}
      {failed ? (
        <Alert tone="warning" icon={<AlertCircle />}>
          Last check failed{(row.lastRefresh as Row)["reason"] ? `: ${(row.lastRefresh as Row)["reason"]}` : ""}. The numbers above are the last good reading.
        </Alert>
      ) : null}
    </div>
  );
}

const COST_STATUS: Record<string, { label: string; tone: Tone }> = {
  reported: { label: "Reported", tone: "success" },
  absent: { label: "Not reported", tone: "neutral" },
  "no-cost-method": { label: "No cost data", tone: "neutral" },
};

export function CostTable({ seats, emptyText }: { seats: CostSeat[]; emptyText: string }) {
  if (seats.length === 0) {
    return <EmptyState icon={<CircleDollarSign />} title="No cost yet">{emptyText}</EmptyState>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13.5px]" data-testid="cost-table">
        <thead>
          <tr className="fx-tiny text-left">
            <th className="pb-2 pr-4 font-medium">Agent</th>
            <th className="pb-2 pr-4 text-right font-medium">Cost</th>
            <th className="pb-2 pr-4 text-right font-medium">Tokens in</th>
            <th className="pb-2 pr-4 text-right font-medium">Tokens out</th>
            <th className="pb-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {seats.map((s) => {
            const status = COST_STATUS[s.status] ?? { label: s.status, tone: "neutral" as Tone };
            const [member, rig] = s.seatSession.split("@");
            return (
              <tr key={s.seatSession} className="border-t border-[color:var(--fx-border)]">
                <td className="py-2.5 pr-4">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={member ?? s.seatSession} colorKey={s.seatSession} size="sm" />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{member}</div>
                      <div className="fx-tiny truncate">{rig ? `${rig} · ` : ""}{s.runtime === "codex" ? "Codex" : s.runtime === "claude-code" ? "Claude Code" : str(s.runtime)}</div>
                    </div>
                  </div>
                </td>
                <td className="py-2.5 pr-4 text-right font-semibold tabular-nums">
                  {s.status === "reported" && typeof s.costUsd === "number" ? formatUsd(s.costUsd) : <span className="text-[color:var(--fx-subtle)]">—</span>}
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums">{formatTokens(s.tokens?.input)}</td>
                <td className="py-2.5 pr-4 text-right tabular-nums">{formatTokens(s.tokens?.output)}</td>
                <td className="py-2.5">
                  <div className="flex flex-col items-start gap-0.5">
                    <Pill tone={s.stale ? "warning" : status.tone}>{s.stale ? "Stale" : status.label}</Pill>
                    {s.reason || s.note ? <span className="fx-tiny max-w-[260px]">{s.reason ?? s.note}</span> : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function UsagePage() {
  const status = useProviderStatus();
  const cost = useCostView();
  const enable = useEnableUsageWindows();
  const usage = status.data?.usage;
  const seats = cost.data?.seats ?? [];
  const totals = costTotals(seats);

  return (
    <Page testId="usage-page">
      <PageHeader
        eyebrow="Usage & cost"
        title="Usage & cost"
        subtitle="How much of your plan limits is left, and what each agent has cost so far on this machine."
        actions={
          <Button onClick={() => { void status.refetch(); void cost.refetch(); }} disabled={status.isFetching || cost.isFetching}>
            <RefreshCw className={status.isFetching || cost.isFetching ? "animate-spin" : undefined} /> Refresh
          </Button>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        {[
          { icon: <CircleDollarSign />, label: "Estimated cost", value: totals.reportedSeats ? formatUsd(totals.usd) : "—", hint: totals.unreportedSeats ? `${totals.unreportedSeats} agent(s) don't report cost` : "Sum of agent estimates" },
          { icon: <Gauge />, label: "Tokens", value: `${formatTokens(totals.tokensIn)} in · ${formatTokens(totals.tokensOut)} out`, hint: "Across all agents" },
          { icon: <Users />, label: "Agents tracked", value: String(seats.length), hint: "On this daemon" },
        ].map((s) => (
          <div key={s.label} className="fx-card flex items-center gap-3 p-4">
            <span className="fx-empty-icon h-11 w-11 shrink-0 rounded-[12px]">{s.icon}</span>
            <div className="min-w-0">
              <div className="fx-small">{s.label}</div>
              <div className="text-[20px] font-bold tabular-nums">{s.value}</div>
              <div className="fx-tiny">{s.hint}</div>
            </div>
          </div>
        ))}
      </div>

      <section className="mb-6">
        <h2 className="fx-h2 mb-3 inline-flex items-center gap-2"><Gauge className="h-4 w-4" /> Plan limits</h2>
        {status.error ? (
          <Alert tone="danger" icon={<AlertCircle />} title="Could not read usage">{(status.error as Error).message}</Alert>
        ) : status.isLoading ? (
          <p className="fx-small">Loading…</p>
        ) : !Array.isArray(usage) ? (
          <div className="fx-card flex flex-wrap items-center gap-4 p-5" data-testid="usage-off">
            <span className="fx-empty-icon"><Power /></span>
            <div className="min-w-0 flex-1">
              <div className="fx-h3">Plan-limit tracking is off</div>
              <p className="fx-small mt-0.5">
                Turn it on to see how much of your Claude and Codex 5-hour and weekly limits is left. After turning it on, restart the daemon
                (<code>rig daemon stop</code>, then <code>rig daemon start</code>).
              </p>
              {enable.error ? <p className="mt-1 text-[13px] text-[color:var(--fx-danger)]">{(enable.error as Error).message}</p> : null}
              {enable.isSuccess ? <p className="mt-1 text-[13px] text-[color:var(--fx-success)]">Turned on. Restart the daemon to start tracking.</p> : null}
            </div>
            <Button variant="primary" onClick={() => enable.mutate()} disabled={enable.isPending || enable.isSuccess} data-testid="usage-enable">
              <Power /> {enable.isPending ? "Turning on…" : "Turn on"}
            </Button>
          </div>
        ) : usage.length === 0 ? (
          <EmptyState icon={<Gauge />} title="No accounts seen yet">
            Limits appear after an agent signed in to Claude or Codex has run on this machine.
          </EmptyState>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {usage.map((row, i) => <AccountCard key={i} row={row} />)}
          </div>
        )}
      </section>

      <Panel
        title={<span className="inline-flex items-center gap-2"><CircleDollarSign className="h-4 w-4" /> Cost by agent</span>}
        actions={<span className="fx-tiny hidden md:inline">Estimates reported by each tool, not an invoice</span>}
      >
        {cost.error ? (
          <Alert tone="danger" icon={<AlertCircle />} title="Could not read cost">{(cost.error as Error).message}</Alert>
        ) : cost.isLoading ? (
          <p className="fx-small">Loading…</p>
        ) : (
          <CostTable seats={seats} emptyText="Costs appear here once agents start working." />
        )}
        {cost.data?.note ? (
          <p className="fx-tiny mt-4 inline-flex items-start gap-1.5"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {cost.data.note}</p>
        ) : null}
      </Panel>
    </Page>
  );
}
