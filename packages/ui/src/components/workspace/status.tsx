// Agent Workspace — shared status labels and badges (friendly design kit).
import type { MemberPhase, ReviewDecision, RunPhase } from "../../hooks/useWorkspaceRuns.js";
import { Pill, type Tone } from "../factory/fields.js";

export const RUN_PHASE: Record<RunPhase, { label: string; tone: Tone }> = {
  launching: { label: "Starting team", tone: "info" },
  working: { label: "In progress", tone: "primary" },
  review: { label: "Ready for review", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  stopped: { label: "Stopped", tone: "neutral" },
};

export const MEMBER_PHASE: Record<MemberPhase, { label: string; tone: Tone }> = {
  waiting: { label: "Waiting", tone: "neutral" },
  working: { label: "Working", tone: "primary" },
  needs_input: { label: "Needs you", tone: "warning" },
  delivered: { label: "Delivered", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  rework: { label: "Reworking", tone: "danger" },
  offline: { label: "Offline", tone: "neutral" },
};

export const REVIEW: Record<ReviewDecision, { label: string; tone: Tone }> = {
  pending: { label: "To review", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rework: { label: "Changes asked", tone: "danger" },
};

export function Badge({ tone, children, pulse, testId }: { tone: Tone; children: React.ReactNode; pulse?: boolean; testId?: string }) {
  return <Pill tone={tone} dot pulse={pulse} testId={testId}>{children}</Pill>;
}

export function RunPhaseBadge({ phase }: { phase: RunPhase }) {
  const p = RUN_PHASE[phase];
  return <Badge tone={p.tone} pulse={phase === "launching" || phase === "working"} testId="run-phase">{p.label}</Badge>;
}

export function ProgressBar({ delivered, approved, total }: { delivered: number; approved: number; total: number }) {
  const pct = (n: number) => (total ? `${(n / total) * 100}%` : "0%");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="fx-h3">{approved} of {total} documents approved</span>
        <span className="fx-tiny">{delivered} written</span>
      </div>
      <div className="fx-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={approved}>
        <span style={{ width: pct(delivered), background: "color-mix(in srgb, var(--fx-primary) 30%, transparent)" }} />
        <span style={{ width: pct(approved), background: "var(--fx-success)" }} />
      </div>
    </div>
  );
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return iso;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
