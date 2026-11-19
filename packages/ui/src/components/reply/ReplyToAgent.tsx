// Reply to an agent's request in your own words — the web twin of the TUI's `reply`.
//
// A request addressed to a person is answered with verb "answer"; a task parked on a person
// is resolved with verb "resolve". Either way the text goes back to the asking agent through
// POST /api/mission-control/action, recorded as the primary user (authority "primary-user"),
// exactly as the TUI records it.
import { useState } from "react";
import { Send } from "lucide-react";
import { useMissionControlAction, type MissionControlActionResult } from "../mission-control/hooks/useMissionControlAction.js";
import { cn } from "../../lib/utils.js";

export type ReplyVerb = "answer" | "resolve";

export function replyOutcomeText(result: MissionControlActionResult, verb: ReplyVerb): string {
  if (result.answer?.message) return result.answer.message;
  if (result.answer?.outcome === "recorded") {
    return `Recorded. Still to answer: ${result.answer.unanswered.join("; ") || "the remaining questions"}.`;
  }
  return verb === "resolve"
    ? "Sent. The task is unblocked and its owner has your decision."
    : "Sent. Your answer went back to the agent and the request is closed.";
}

export function ReplyToAgent({
  qitemId,
  actorSession,
  verb,
  hostId,
  askerLabel,
  placeholder,
  compact,
  onDone,
  testId = "reply-to-agent",
}: {
  qitemId: string;
  actorSession: string;
  verb: ReplyVerb;
  hostId?: string;
  askerLabel?: string;
  placeholder?: string;
  compact?: boolean;
  onDone?: (message: string) => void;
  testId?: string;
}) {
  const action = useMissionControlAction();
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string | null>(null);

  const submit = () => {
    const decision = text.trim();
    if (!decision) return;
    action.mutate(
      {
        verb,
        qitemId,
        actorSession,
        decision,
        authority: "primary-user",
        ...(hostId && hostId !== "local" ? { hostId } : {}),
      },
      {
        onSuccess: (result) => {
          const message = replyOutcomeText(result, verb);
          setSent(message);
          setText("");
          onDone?.(message);
        },
      },
    );
  };

  if (sent) {
    return (
      <p data-testid={`${testId}-sent`} className="rounded-lg bg-success/10 px-3 py-2 text-[13px] text-success">
        {sent}
      </p>
    );
  }

  return (
    <div data-testid={testId} className="flex w-full flex-col gap-2">
      <textarea
        data-testid={`${testId}-text`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        rows={compact ? 2 : 3}
        placeholder={placeholder ?? (askerLabel ? `Reply to ${askerLabel} in your own words…` : "Reply in your own words…")}
        className="w-full rounded-lg border border-outline bg-surface-lowest px-3 py-2 text-[13.5px] text-on-surface placeholder:text-on-surface-variant/70 focus:border-secondary focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={`${testId}-send`}
          onClick={submit}
          disabled={!text.trim() || action.isPending}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-[13px] font-medium text-white shadow-sm hover:opacity-90 disabled:opacity-50",
          )}
        >
          <Send className="h-3.5 w-3.5" /> {action.isPending ? "Sending…" : verb === "resolve" ? "Send decision" : "Send reply"}
        </button>
        <span className="text-[12px] text-on-surface-variant">⌘/Ctrl + Enter</span>
        {action.error ? (
          <span data-testid={`${testId}-error`} className="text-[13px] text-error">
            {(action.error as Error).message}
          </span>
        ) : null}
      </div>
    </div>
  );
}
