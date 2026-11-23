// Agent Workspace — one task (/workspace/runs/$runId): progress, outputs, review.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Check,
  CircleDollarSign,
  Clock,
  Hand,
  Download,
  FileText,
  FolderOpen,
  Loader2,
  MessageSquare,
  PenLine,
  RotateCcw,
  Send,
  Square,
  Terminal,
} from "lucide-react";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { OfficePreview } from "./OfficePreview.js";
import {
  outputUrl,
  useMemberScreen,
  useMessageMember,
  useReview,
  useRunDetail,
  useRunOutput,
  useRunOfficePreview,
  isOfficePath,
  useStopRun,
  type RunDeliverable,
  type RunDetail,
  type RunMember,
  useTeamAsks,
  type AttentionAsk,
} from "../../hooks/useWorkspaceRuns.js";
import { costTotals, formatTokens, formatUsd, useCostView } from "../../hooks/useUsageCost.js";
import { ReplyToAgent } from "../reply/ReplyToAgent.js";
import { cn } from "../../lib/utils.js";
import { Alert, Avatar, Button, EmptyState, Page, Panel, Pill, TextArea } from "../factory/fields.js";
import { Badge, MEMBER_PHASE, ProgressBar, REVIEW, RunPhaseBadge, timeAgo } from "./status.js";

type Selection = { member: string; deliverable: string };
type ToolTab = "screen" | "message" | "activity";

function firstInterestingOutput(detail: RunDetail): Selection | null {
  const all = detail.members.flatMap((m) => m.deliverables.map((d) => ({ m, d })));
  const pick = all.find(({ d }) => d.exists && d.review.status === "pending") ?? all.find(({ d }) => d.exists) ?? all[0];
  return pick ? { member: pick.m.id, deliverable: pick.d.id } : null;
}

export function RunPage({ runId }: { runId: string }) {
  const { data: detail, isLoading, error } = useRunDetail(runId);
  const stop = useStopRun(runId);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [tab, setTab] = useState<ToolTab>("screen");
  const [showTask, setShowTask] = useState(false);
  const sessions = detail?.members.map((m) => m.session) ?? [];
  const cost = useCostView({ refetchMs: 15_000 });
  const asks = useTeamAsks(sessions, detail?.run.status === "running");

  useEffect(() => {
    if (detail && !selection) setSelection(firstInterestingOutput(detail));
  }, [detail, selection]);

  if (isLoading) return <Page><p className="fx-small">Loading task…</p></Page>;
  if (error || !detail) {
    return (
      <Page>
        <Alert tone="danger" icon={<AlertCircle />} title="Task not found">
          {(error as Error | null)?.message} · <Link to="/workspace" className="underline">Back to tasks</Link>
        </Alert>
      </Page>
    );
  }

  const { run } = detail;
  const member = detail.members.find((m) => m.id === selection?.member) ?? detail.members[0] ?? null;
  const deliverable = member?.deliverables.find((d) => d.id === selection?.deliverable) ?? null;
  const live = run.status === "running";

  return (
    <Page testId="workspace-run-page" width={1360}>
      <div className="mb-3">
        <Link to="/workspace" className="fx-btn fx-btn-ghost fx-btn-sm -ml-2.5"><ArrowLeft /> All tasks</Link>
      </div>

      <section className="fx-card mb-5 p-5">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar name={run.teamTitle} colorKey={run.team} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="fx-h1 !text-[22px]">{run.teamTitle}</h1>
              <RunPhaseBadge phase={detail.phase} />
            </div>
            <p className={cn("mt-1.5 text-[14px] leading-relaxed", !showTask && "line-clamp-2")}>{run.task}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
              {run.task.length > 160 ? (
                <button type="button" onClick={() => setShowTask((v) => !v)} className="fx-link text-[12.5px]">
                  {showTask ? "Show less" : "Show full task"}
                </button>
              ) : null}
              <span className="fx-tiny inline-flex min-w-0 items-center gap-1.5">
                <FolderOpen className="h-3.5 w-3.5 shrink-0" /> <span className="fx-mono truncate">{run.projectDir}</span>
              </span>
              <span className="fx-tiny inline-flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" /> Started {timeAgo(run.createdAt)}</span>
            </div>
          </div>
          {run.status === "running" || run.status === "launching" ? (
            <Button
              variant="danger"
              data-testid="workspace-stop"
              disabled={stop.isPending || run.status === "launching"}
              onClick={() => {
                if (window.confirm("Stop every agent of this team? Their documents stay in the project folder.")) stop.mutate(undefined);
              }}
            >
              <Square /> {stop.isPending ? "Stopping…" : "Stop team"}
            </Button>
          ) : null}
        </div>
        <div className="fx-divider mt-4 grid gap-4 pt-4 md:grid-cols-[1fr_auto]">
          <ProgressBar {...detail.progress} />
          <TaskCost seats={(cost.data?.seats ?? []).filter((s) => sessions.includes(s.seatSession))} />
        </div>
        {stop.error ? <p className="mt-2 text-[13px] text-[color:var(--fx-danger)]">{(stop.error as Error).message}</p> : null}
      </section>

      <div className="mb-5 flex flex-col gap-3 empty:hidden">
        {run.status === "failed" ? (
          <Alert tone="danger" icon={<AlertCircle />} title="The team could not start" testId="workspace-run-error">{run.error}</Alert>
        ) : null}
        {run.status === "launching" ? (
          <Alert tone="info" icon={<Loader2 className="animate-spin" />} title="Starting your team">
            The agents are starting up and will get the task in a minute or two.
          </Alert>
        ) : null}
        {detail.teamMissing ? (
          <Alert tone="warning" icon={<AlertCircle />} title="Team deleted">
            The team "{run.team}" was deleted from Factory Studio, so its members and documents can't be shown.
          </Alert>
        ) : null}
      </div>

      <NeedsYou
        runId={run.id}
        live={live}
        asks={asks.data ?? []}
        members={detail.members}
        onOpenMember={(m) => { setSelection({ member: m.id, deliverable: m.deliverables[0]?.id ?? "" }); setTab("screen"); }}
      />

      <div className="grid gap-5 lg:grid-cols-[330px_1fr]">
        <Panel
          title={
            <span className="inline-flex items-center gap-2">
              Team <span className="fx-tiny font-normal">{detail.workflow === "sequential" ? "· one after another" : "· all at once"}</span>
            </span>
          }
          testId="workspace-members"
          bodyClassName="p-3"
          className="self-start"
        >
          <ol className="flex flex-col">
            {detail.members.map((m, i) => (
              <li key={m.id} className="flex flex-col">
                {i > 0 && detail.workflow === "sequential" ? (
                  <span className="ml-[27px] h-3 border-l-2 border-dashed border-[color:var(--fx-border-strong)]" aria-hidden="true" />
                ) : i > 0 ? <span className="h-2" /> : null}
                <MemberCard
                  member={m}
                  selection={selection}
                  onSelect={(deliverableId) => setSelection({ member: m.id, deliverable: deliverableId })}
                  onSelectMember={() => setSelection({ member: m.id, deliverable: m.deliverables[0]?.id ?? "" })}
                />
              </li>
            ))}
          </ol>
        </Panel>

        <div className="flex min-w-0 flex-col gap-5">
          {member && deliverable ? (
            <OutputPanel runId={run.id} member={member} deliverable={deliverable} canRework={live} />
          ) : (
            <Panel title="Document">
              <EmptyState icon={<FileText />} title="Pick a document">Choose a document from the team on the left.</EmptyState>
            </Panel>
          )}

          <section className="fx-card" data-testid="workspace-member-tools">
            <div role="tablist" className="fx-tabs px-3">
              {([
                ["screen", <Terminal key="i" />, `Live screen${member ? ` · ${member.title}` : ""}`],
                ["message", <MessageSquare key="i" />, "Message"],
                ["activity", <Activity key="i" />, "Activity"],
              ] as const).map(([id, icon, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  data-testid={`workspace-tab-${id}`}
                  onClick={() => setTab(id)}
                  className="fx-tab"
                >
                  {icon} {label}
                </button>
              ))}
            </div>
            <div className="p-4">
              {tab === "screen" ? <ScreenView runId={run.id} member={member} live={live} /> : null}
              {tab === "message" ? <MessageView runId={run.id} member={member} live={live} /> : null}
              {tab === "activity" ? <ActivityView detail={detail} /> : null}
            </div>
          </section>
        </div>
      </div>
    </Page>
  );
}

function MemberCard({ member, selection, onSelect, onSelectMember }: {
  member: RunMember;
  selection: Selection | null;
  onSelect: (deliverableId: string) => void;
  onSelectMember: () => void;
}) {
  const phase = MEMBER_PHASE[member.phase];
  const active = selection?.member === member.id;
  return (
    <div
      data-testid={`workspace-member-${member.id}`}
      className={cn("rounded-[12px] border p-1.5 transition-colors", active ? "border-[color:var(--fx-border-strong)] bg-[color:var(--fx-surface-2)]" : "border-transparent")}
    >
      <button type="button" onClick={onSelectMember} className="fx-row">
        <Avatar name={member.title} colorKey={member.id} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold">{member.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone={phase.tone} pulse={member.phase === "working"}>{phase.label}</Badge>
            <span className="fx-tiny">
              {member.runtime === "codex" ? "Codex" : "Claude Code"}
              {member.seat?.activity ? ` · ${member.seat.activity.replace("_", " ")}` : ""}
            </span>
          </span>
        </span>
      </button>
      {member.deliverables.length ? (
        <ul className="mt-0.5 flex flex-col gap-0.5 pl-[46px]">
          {member.deliverables.map((d) => {
            const on = active && selection?.deliverable === d.id;
            const review = REVIEW[d.review.status];
            return (
              <li key={d.id}>
                <button
                  type="button"
                  aria-selected={on}
                  data-testid={`workspace-output-${member.id}-${d.id}`}
                  onClick={() => onSelect(d.id)}
                  className="fx-row gap-2 py-1.5 pl-2"
                >
                  <FileText className={cn("h-4 w-4 shrink-0", d.exists ? "text-[color:var(--fx-primary-text)]" : "text-[color:var(--fx-subtle)]")} />
                  <span className={cn("min-w-0 flex-1 truncate text-[13px]", !d.exists && "text-[color:var(--fx-subtle)]")}>{d.title}</span>
                  {d.exists ? (
                    <span className={cn("h-2 w-2 shrink-0 rounded-full")} title={review.label} style={{ background: `var(--fx-${review.tone === "neutral" ? "subtle" : review.tone})` }} />
                  ) : (
                    <span className="fx-tiny">Not yet</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function OutputPanel({ runId, member, deliverable, canRework }: { runId: string; member: RunMember; deliverable: RunDeliverable; canRework: boolean }) {
  const office = isOfficePath(deliverable.path);
  const version = deliverable.exists ? deliverable.modifiedAt : null;
  const output = useRunOutput(runId, member.id, deliverable.id, office ? null : version);
  const officePreview = useRunOfficePreview(runId, member.id, deliverable.id, office ? version : null);
  const review = useReview(runId);
  const [feedback, setFeedback] = useState("");
  const [asking, setAsking] = useState(false);
  const status = REVIEW[deliverable.review.status];

  useEffect(() => {
    setAsking(false);
    setFeedback("");
  }, [member.id, deliverable.id]);

  const decide = (decision: "approved" | "rework" | "pending") =>
    review.mutate(
      { member: member.id, deliverable: deliverable.id, decision, ...(decision === "rework" ? { feedback } : {}) },
      { onSuccess: () => { setAsking(false); setFeedback(""); } },
    );

  return (
    <section className="fx-card" data-testid="workspace-output">
      <header className="fx-card-head flex-wrap">
        <div className="flex min-w-0 items-center gap-3">
          <span className="fx-empty-icon h-10 w-10 shrink-0 rounded-[10px]"><FileText className="!h-5 !w-5" /></span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="fx-h2 truncate">{deliverable.title}</h2>
              {deliverable.exists ? (
                <Pill tone={status.tone} dot testId="workspace-review-status">
                  {status.label}{deliverable.review.rounds ? ` · round ${deliverable.review.rounds + 1}` : ""}
                </Pill>
              ) : null}
            </div>
            <div className="fx-tiny mt-0.5 flex flex-wrap items-center gap-x-2">
              <span>by {member.title}</span>
              <span>·</span>
              <span className="fx-mono">{deliverable.path}</span>
              {deliverable.exists ? (
                <>
                  <span>·</span>
                  <span>{Math.max(1, Math.round((deliverable.size ?? 0) / 1024))} KB, updated {deliverable.modifiedAt ? timeAgo(deliverable.modifiedAt) : ""}</span>
                </>
              ) : null}
            </div>
          </div>
        </div>
        {deliverable.exists ? (
          <div className="flex items-center gap-2" data-testid="workspace-review-actions">
            <a href={outputUrl(runId, member.id, deliverable.id, true)} data-testid="workspace-download" className="fx-btn fx-btn-ghost fx-btn-sm">
              <Download /> Download
            </a>
            <Button size="sm" data-testid="workspace-ask-rework" disabled={review.isPending || !canRework} onClick={() => setAsking((v) => !v)} title={canRework ? undefined : "The team must be running"}>
              <PenLine /> Ask for changes
            </Button>
            {deliverable.review.status === "approved" ? (
              <Button size="sm" variant="ghost" disabled={review.isPending} onClick={() => decide("pending")}>
                <RotateCcw /> Undo approval
              </Button>
            ) : (
              <Button size="sm" variant="success" data-testid="workspace-approve" disabled={review.isPending} onClick={() => decide("approved")}>
                <Check /> Approve
              </Button>
            )}
          </div>
        ) : null}
      </header>

      <div className="fx-card-body">
        {deliverable.exists ? (
          <>
            {deliverable.review.status === "rework" && deliverable.review.feedback ? (
              <div className="mb-4">
                <Alert tone="warning" icon={<PenLine />} title={`You asked ${member.title} for changes`}>
                  {deliverable.review.feedback}
                </Alert>
              </div>
            ) : null}

            {asking ? (
              <div className="fx-inset mb-4 flex flex-col gap-3 p-4">
                <span className="fx-label">What should {member.title} change?</span>
                <TextArea
                  data-testid="workspace-rework-feedback"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="e.g. Add a sequence diagram for booking and explain how double bookings are prevented."
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <Button variant="primary" size="sm" data-testid="workspace-send-rework" disabled={!feedback.trim() || review.isPending} onClick={() => decide("rework")}>
                    <Send /> {review.isPending ? "Sending…" : `Send to ${member.title}`}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
                </div>
              </div>
            ) : null}
            {review.error ? (
              <div className="mb-4">
                <Alert tone="danger" icon={<AlertCircle />} title="Not sent">{(review.error as Error).message}</Alert>
              </div>
            ) : null}

            {office ? (
              <div data-testid="workspace-output-content">
                {officePreview.isLoading ? (
                  <p className="fx-small">Loading…</p>
                ) : officePreview.error ? (
                  <p className="text-[13px] text-[color:var(--fx-danger)]">{(officePreview.error as Error).message}</p>
                ) : officePreview.data ? (
                  <OfficePreview preview={officePreview.data} />
                ) : null}
              </div>
            ) : (
            <div className="fx-doc max-h-[640px] overflow-auto rounded-[12px] border border-[color:var(--fx-border)] bg-[color:var(--fx-surface)] p-5" data-testid="workspace-output-content">
              {output.isLoading ? (
                <p className="fx-small">Loading…</p>
              ) : output.error ? (
                <p className="text-[13px] text-[color:var(--fx-danger)]">{(output.error as Error).message}</p>
              ) : /\.(md|markdown)$/i.test(deliverable.path) ? (
                <MarkdownViewer content={output.data ?? ""} />
              ) : (
                <pre className="fx-pre whitespace-pre-wrap">{output.data}</pre>
              )}
            </div>
            )}
          </>
        ) : (
          <EmptyState icon={<PenLine />} title="Not written yet">
            {member.title} hasn't written this document yet. It shows up here as soon as the file exists.
          </EmptyState>
        )}
      </div>
    </section>
  );
}

function ScreenView({ runId, member, live }: { runId: string; member: RunMember | null; live: boolean }) {
  const screen = useMemberScreen(runId, member?.id ?? null, live);
  if (!live) return <p className="fx-small">The team isn't running, so there's no live screen.</p>;
  if (!member) return null;
  return (
    <div>
      <pre data-testid="workspace-screen" className="fx-terminal max-h-[360px] overflow-auto whitespace-pre-wrap">
        {screen.error ? `Screen unavailable: ${(screen.error as Error).message}` : screen.data?.content || "…"}
      </pre>
      <p className="fx-tiny mt-2">
        Read-only, refreshes every few seconds. To take over in a terminal: <code>tmux attach -t {member.session}</code>
      </p>
    </div>
  );
}

function MessageView({ runId, member, live }: { runId: string; member: RunMember | null; live: boolean }) {
  const send = useMessageMember(runId);
  const [text, setText] = useState("");
  if (!member) return null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Avatar name={member.title} colorKey={member.id} size="sm" />
        <span className="fx-small">Message <b className="text-[color:var(--fx-text)]">{member.title}</b>, for example to answer a question or add context.</span>
      </div>
      <TextArea data-testid="workspace-message" value={text} onChange={(e) => setText(e.target.value)} disabled={!live} placeholder={live ? "Write a message…" : "The team isn't running."} />
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          data-testid="workspace-send-message"
          disabled={!live || !text.trim() || send.isPending}
          onClick={() => send.mutate({ member: member.id, text }, { onSuccess: () => setText("") })}
        >
          <Send /> {send.isPending ? "Sending…" : "Send"}
        </Button>
        {send.error ? <span className="text-[13px] text-[color:var(--fx-danger)]">{(send.error as Error).message}</span> : null}
        {send.isSuccess ? <span className="text-[13px] text-[color:var(--fx-success)]">Sent</span> : null}
      </div>
    </div>
  );
}

function ActivityView({ detail }: { detail: RunDetail }) {
  const events = [...detail.run.events].reverse();
  return (
    <ol data-testid="workspace-activity" className="flex max-h-[360px] flex-col overflow-auto">
      {events.map((e, i) => {
        const bad = e.kind === "launch_failed" || e.kind === "error";
        return (
          <li key={i} className="flex gap-3 pb-3">
            <span className="mt-1.5 flex flex-col items-center">
              <span className="h-2 w-2 rounded-full" style={{ background: bad ? "var(--fx-danger)" : "var(--fx-primary)" }} />
              {i < events.length - 1 ? <span className="mt-1 w-px flex-1 bg-[color:var(--fx-border)]" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn("block break-words text-[13.5px]", bad && "text-[color:var(--fx-danger)]")}>{e.message}</span>
              <span className="fx-tiny">{timeAgo(e.at)}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function TaskCost({ seats }: { seats: import("../../hooks/useUsageCost.js").CostSeat[] }) {
  const t = costTotals(seats);
  return (
    <div data-testid="workspace-task-cost" className="flex items-center gap-3 md:min-w-[220px] md:justify-end">
      <span className="fx-empty-icon h-10 w-10 shrink-0 rounded-[10px]"><CircleDollarSign className="!h-5 !w-5" /></span>
      <div>
        <div className="fx-tiny">Cost so far (estimate)</div>
        <div className="text-[18px] font-bold tabular-nums">{t.reportedSeats ? formatUsd(t.usd) : "—"}</div>
        <div className="fx-tiny">
          {seats.length ? `${formatTokens(t.tokensIn)} in · ${formatTokens(t.tokensOut)} out` : "No cost reported yet"}
          {t.unreportedSeats && seats.length ? ` · ${t.unreportedSeats} not reporting` : ""}
        </div>
      </div>
    </div>
  );
}

/** Everything waiting on you: requests the team sent you, and agents stopped at a prompt. */
function NeedsYou({ runId, live, asks, members, onOpenMember }: {
  runId: string;
  live: boolean;
  asks: AttentionAsk[];
  members: RunMember[];
  onOpenMember: (m: RunMember) => void;
}) {
  const waiting = members.filter((m) => m.phase === "needs_input");
  if (!live || (asks.length === 0 && waiting.length === 0)) return null;
  const titleOf = (session: string | undefined) => members.find((m) => m.session === session)?.title ?? session ?? "An agent";
  return (
    <section data-testid="workspace-needs-you" className="fx-card mb-5 overflow-hidden" style={{ borderColor: "color-mix(in srgb, var(--fx-warning) 45%, var(--fx-border))" }}>
      <header className="fx-card-head" style={{ background: "var(--fx-warning-soft)" }}>
        <h2 className="fx-h2 inline-flex items-center gap-2" style={{ color: "var(--fx-warning)" }}>
          <Hand className="h-4 w-4" /> Needs you
          <span className="fx-count">{asks.length + waiting.length}</span>
        </h2>
      </header>
      <ul className="flex flex-col">
        {asks.map((a) => {
          const member = members.find((m) => m.session === a.asker);
          const hasQuestions = Array.isArray(a.humanQuestions) && a.humanQuestions.length > 0;
          return (
            <li key={a.id} data-testid={`workspace-ask-${a.id}`} className="flex gap-3 border-b border-[color:var(--fx-border)] p-4 last:border-0">
              <Avatar name={titleOf(a.asker)} colorKey={member?.id ?? a.asker ?? a.id} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="fx-h3">{titleOf(a.asker)} asks</span>
                  {a.urgency && a.urgency !== "routine" ? <Pill tone="warning">{a.urgency}</Pill> : null}
                  {a.at ? <span className="fx-tiny">{timeAgo(a.at)}</span> : null}
                </div>
                <p className="mt-1 text-[14px]">{a.summary}</p>
                <div className="mt-3">
                  {hasQuestions ? (
                    <p className="fx-small">
                      This request has multiple-choice questions. Answer them in <a href="/for-you" className="fx-link">For You</a>.
                    </p>
                  ) : (
                    <ReplyToAgent
                      testId={`workspace-reply-${a.id}`}
                      qitemId={a.id.slice("queue:".length)}
                      actorSession={a.answer!.actorSession}
                      verb={a.answer!.verb === "resolve" ? "resolve" : "answer"}
                      askerLabel={titleOf(a.asker)}
                      compact
                    />
                  )}
                </div>
              </div>
            </li>
          );
        })}
        {waiting.map((m) => (
          <WaitingMember key={m.id} runId={runId} member={m} onOpen={() => onOpenMember(m)} />
        ))}
      </ul>
    </section>
  );
}

function WaitingMember({ runId, member, onOpen }: { runId: string; member: RunMember; onOpen: () => void }) {
  const send = useMessageMember(runId);
  const [text, setText] = useState("");
  return (
    <li data-testid={`workspace-waiting-${member.id}`} className="flex gap-3 border-b border-[color:var(--fx-border)] p-4 last:border-0">
      <Avatar name={member.title} colorKey={member.id} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="fx-h3">{member.title} is waiting at a prompt</span>
          <button type="button" onClick={onOpen} className="fx-link text-[12.5px]">See its screen</button>
        </div>
        <p className="fx-small mt-0.5">It stopped and is waiting for input in its terminal. Type what it should know or do next.</p>
        <div className="mt-3 flex flex-col gap-2">
          <TextArea
            data-testid={`workspace-waiting-text-${member.id}`}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Reply to ${member.title}…`}
            className="min-h-[64px]"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!text.trim() || send.isPending}
              onClick={() => send.mutate({ member: member.id, text }, { onSuccess: () => setText("") })}
            >
              <Send /> {send.isPending ? "Sending…" : "Send reply"}
            </Button>
            {send.isSuccess ? <span className="text-[13px] text-[color:var(--fx-success)]">Sent</span> : null}
            {send.error ? <span className="text-[13px] text-[color:var(--fx-danger)]">{(send.error as Error).message}</span> : null}
          </div>
        </div>
      </div>
    </li>
  );
}
