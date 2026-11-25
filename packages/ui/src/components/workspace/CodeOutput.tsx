// Agent Workspace — a source-code output: its build/test check, and its files.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, Play, Search, Wrench } from "lucide-react";
import { useCodeFile, useCodeTree, useRunCheck, type CodeCheck, type RunDeliverable, type RunMember } from "../../hooks/useWorkspaceRuns.js";
import { Button, Pill, TextInput, type Tone } from "../factory/fields.js";
import { timeAgo } from "./status.js";

const CHECK: Record<CodeCheck["status"] | "none", { label: string; tone: Tone }> = {
  none: { label: "Not checked yet", tone: "neutral" },
  running: { label: "Checking…", tone: "info" },
  passed: { label: "Build and tests passed", tone: "success" },
  failed: { label: "Check failed", tone: "danger" },
  error: { label: "Couldn't check", tone: "warning" },
};

function duration(ms?: number): string {
  if (ms === undefined) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The last lines of a failed check, for the "ask to fix" message. */
export function failureSummary(check: CodeCheck): string {
  const lines = check.output.trim().split("\n").slice(-40).join("\n");
  return `The check \`${check.command}\` ${check.status === "error" ? "couldn't run" : `failed (exit ${check.exitCode ?? "-"})`}. Fix it so it passes. Last output:\n\n${lines}`;
}

function CheckPanel({ runId, member, deliverable, onAskFix }: { runId: string; member: RunMember; deliverable: RunDeliverable; onAskFix?: (text: string) => void }) {
  const run = useRunCheck(runId);
  const check = deliverable.check ?? null;
  const state = CHECK[check?.status ?? "none"];
  const [open, setOpen] = useState(false);
  const stale = !!check && check.status !== "running" && !!deliverable.modifiedAt && check.sourceVersion !== deliverable.modifiedAt;
  useEffect(() => { setOpen(check?.status === "failed" || check?.status === "error"); }, [check?.status, check?.startedAt]);

  return (
    <div className="fx-inset mb-4 flex flex-col gap-2.5 p-3.5" data-testid="workspace-code-check">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={state.tone} dot pulse={check?.status === "running"} testId="workspace-check-status">{state.label}</Pill>
        {check?.finishedAt ? <span className="fx-tiny">{duration(check.durationMs)} · {timeAgo(check.finishedAt)} · {check.trigger === "auto" ? "ran on hand-off" : "run by you"}</span> : null}
        {stale ? <span className="fx-tiny text-[color:var(--fx-warning)]">Code changed since this check</span> : null}
        <span className="ml-auto flex items-center gap-2">
          {onAskFix && check && (check.status === "failed" || check.status === "error") ? (
            <Button size="sm" onClick={() => onAskFix(failureSummary(check))} data-testid="workspace-ask-fix"><Wrench /> Ask to fix</Button>
          ) : null}
          <Button
            size="sm"
            variant={check ? "secondary" : "primary"}
            data-testid="workspace-run-check"
            disabled={run.isPending || check?.status === "running" || !deliverable.exists}
            onClick={() => run.mutate({ member: member.id, deliverable: deliverable.id })}
          >
            <Play /> {check?.status === "running" ? "Running…" : check ? "Run again" : "Run check"}
          </Button>
        </span>
      </div>
      <div className="fx-tiny">
        Check: <code className="fx-mono">{check?.command || deliverable.checkCommand || "none found: set one in Factory Studio, or have the member add factory-check.sh"}</code>
        {check?.source === "factory-check.sh" ? " (the member's factory-check.sh)" : check?.source === "detected" ? " (detected)" : ""}
      </div>
      {run.error ? <p className="text-[13px] text-[color:var(--fx-danger)]">{(run.error as Error).message}</p> : null}
      {check?.output ? (
        <div>
          <button type="button" className="fx-tiny inline-flex items-center gap-1" onClick={() => setOpen((v) => !v)} data-testid="workspace-check-output-toggle">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Output
          </button>
          {open ? (
            <pre data-testid="workspace-check-output" className="fx-terminal mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap text-[12px]">{check.output.slice(-60_000)}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FileView({ runId, member, deliverable, file, version }: { runId: string; member: RunMember; deliverable: RunDeliverable; file: string | null; version: string | null }) {
  const q = useCodeFile(runId, member.id, deliverable.id, file, version);
  if (!file) return <p className="fx-small p-4">Pick a file.</p>;
  if (q.isLoading) return <p className="fx-small p-4">Loading…</p>;
  if (q.error) return <p className="p-4 text-[13px] text-[color:var(--fx-danger)]">{(q.error as Error).message}</p>;
  const lines = (q.data?.content ?? "").split("\n");
  return (
    <div className="min-w-0 overflow-auto" data-testid="workspace-code-file">
      <div className="fx-tiny sticky top-0 border-b border-[color:var(--fx-border)] bg-[color:var(--fx-surface)] px-3 py-1.5 fx-mono">{file}</div>
      <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i}>
              <td className="select-none pr-3 pl-3 text-right align-top text-[color:var(--fx-subtle)]">{i + 1}</td>
              <td className="whitespace-pre pr-4 text-[color:var(--fx-text)]">{line}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CodeOutput({ runId, member, deliverable, onAskFix }: { runId: string; member: RunMember; deliverable: RunDeliverable; onAskFix?: (text: string) => void }) {
  const version = deliverable.exists ? deliverable.modifiedAt : null;
  const tree = useCodeTree(runId, member.id, deliverable.id, version);
  const [filter, setFilter] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const files = useMemo(() => {
    const all = tree.data?.files ?? [];
    const f = filter.trim().toLowerCase();
    return f ? all.filter((x) => x.path.toLowerCase().includes(f)) : all;
  }, [tree.data, filter]);

  useEffect(() => { setFile(null); setFilter(""); }, [member.id, deliverable.id]);
  useEffect(() => {
    if (file || !tree.data?.files.length) return;
    const readme = tree.data.files.find((f) => /^readme(\.md)?$/i.test(f.path));
    setFile((readme ?? tree.data.files[0]!).path);
  }, [tree.data, file]);

  return (
    <div data-testid="workspace-code-output">
      <CheckPanel runId={runId} member={member} deliverable={deliverable} onAskFix={onAskFix} />
      <div className="grid h-[560px] grid-cols-1 overflow-hidden rounded-[12px] border border-[color:var(--fx-border)] bg-[color:var(--fx-surface)] md:grid-cols-[260px_1fr]">
        <div className="flex min-h-0 flex-col border-b border-[color:var(--fx-border)] md:border-b-0 md:border-r">
          <div className="relative p-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--fx-subtle)]" />
            <TextInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a file" className="pl-9 text-[12.5px]" />
          </div>
          <ul className="min-h-0 flex-1 overflow-auto px-1 pb-2" data-testid="workspace-code-tree">
            {tree.isLoading ? <li className="fx-small px-2">Loading…</li> : null}
            {tree.error ? <li className="px-2 text-[13px] text-[color:var(--fx-danger)]">{(tree.error as Error).message}</li> : null}
            {files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  aria-selected={file === f.path}
                  onClick={() => setFile(f.path)}
                  className="fx-row w-full gap-1.5 py-1 pl-2 text-left"
                  title={f.path}
                >
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[color:var(--fx-subtle)]" />
                  <span className="min-w-0 truncate fx-mono text-[12px]">{f.path}</span>
                </button>
              </li>
            ))}
            {tree.data?.truncated ? <li className="fx-tiny px-2 pt-1">Only the first 3000 files are listed.</li> : null}
          </ul>
          <div className="fx-tiny border-t border-[color:var(--fx-border)] px-3 py-1.5">
            {tree.data ? `${tree.data.files.length} files` : ""}{deliverable.modifiedAt ? ` · changed ${timeAgo(deliverable.modifiedAt)}` : ""}
          </div>
        </div>
        <FileView runId={runId} member={member} deliverable={deliverable} file={file} version={version} />
      </div>
      <p className="fx-tiny mt-2">Dependencies and build output (node_modules, dist, .git, …) aren't shown.</p>
    </div>
  );
}
