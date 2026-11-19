// Agent Workspace — task list (/workspace) and new task (/workspace/new).
import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, ArrowRight, Briefcase, Check, FileText, FolderOpen, Play, Plus, Rocket } from "lucide-react";
import { useFactoryTeams } from "../../hooks/useFactory.js";
import { useRuns, useStartRun, type FactoryRun } from "../../hooks/useWorkspaceRuns.js";
import { Alert, Avatar, Button, EmptyState, Field, Page, PageHeader, Pill, TextArea, TextInput, type Tone } from "../factory/fields.js";
import { timeAgo } from "./status.js";

const STATUS: Record<FactoryRun["status"], { label: string; tone: Tone }> = {
  launching: { label: "Starting", tone: "info" },
  running: { label: "Active", tone: "primary" },
  failed: { label: "Failed", tone: "danger" },
  stopped: { label: "Stopped", tone: "neutral" },
};

function reviewSummary(run: FactoryRun): string {
  const rs = Object.values(run.reviews);
  const approved = rs.filter((r) => r.status === "approved").length;
  const rework = rs.filter((r) => r.status === "rework").length;
  return [approved ? `${approved} approved` : "", rework ? `${rework} with changes asked` : ""].filter(Boolean).join(" · ");
}

export function WorkspacePage() {
  const { data: runs = [], isLoading, error } = useRuns();

  return (
    <Page testId="agent-workspace-page">
      <PageHeader
        eyebrow="Agent Workspace"
        title="Tasks"
        subtitle="Give a task to one of your teams, follow along while they work, then review the documents they write."
        actions={
          <Link to="/workspace/new" data-testid="workspace-new-task" className="fx-btn fx-btn-primary">
            <Plus /> New task
          </Link>
        }
      />

      {error ? (
        <Alert tone="danger" icon={<AlertCircle />} title="Could not load tasks">{(error as Error).message}</Alert>
      ) : isLoading ? (
        <p className="fx-small">Loading tasks…</p>
      ) : runs.length === 0 ? (
        <EmptyState
          icon={<Briefcase />}
          title="No tasks yet"
          action={<Link to="/workspace/new" className="fx-btn fx-btn-primary"><Plus /> Give a team its first task</Link>}
        >
          Pick a team, describe what you need, and the team writes the documents for you.
        </EmptyState>
      ) : (
        <ul data-testid="workspace-run-list" className="flex flex-col gap-3">
          {runs.map((run) => {
            const status = STATUS[run.status];
            const summary = reviewSummary(run);
            return (
              <li key={run.id}>
                <Link
                  to="/workspace/runs/$runId"
                  params={{ runId: run.id }}
                  data-testid={`workspace-run-${run.id}`}
                  className="fx-card fx-card-hover group flex items-start gap-4 p-4"
                >
                  <Avatar name={run.teamTitle} colorKey={run.team} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="fx-h3">{run.teamTitle}</span>
                      <Pill tone={status.tone} dot pulse={run.status === "launching"}>{status.label}</Pill>
                      {summary ? <span className="fx-tiny">{summary}</span> : null}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[13.5px] text-[color:var(--fx-text)]">{run.task}</p>
                    <p className="fx-tiny mt-1.5 inline-flex min-w-0 max-w-full items-center gap-1.5">
                      <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate fx-mono">{run.projectDir}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <span className="fx-tiny">{timeAgo(run.createdAt)}</span>
                    <ArrowRight className="h-4 w-4 text-[color:var(--fx-subtle)] transition-transform group-hover:translate-x-0.5" />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}

export function NewTaskPage() {
  const search = useSearch({ strict: false }) as { team?: string };
  const navigate = useNavigate();
  const { data: teams = [], isLoading } = useFactoryTeams();
  const start = useStartRun();
  const [team, setTeam] = useState<string>(search.team ?? "");
  const [task, setTask] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [error, setError] = useState<string | null>(null);

  const selected = teams.find((t) => t.name === team);
  const canStart = !!selected && task.trim().length > 0 && projectDir.trim().startsWith("/") && !start.isPending;

  const onStart = () => {
    setError(null);
    start.mutate(
      { team, task, projectDir: projectDir.trim() },
      {
        onSuccess: (run) => void navigate({ to: "/workspace/runs/$runId", params: { runId: run.id } }),
        onError: (err) => setError(err instanceof Error ? err.message : String(err)),
      },
    );
  };

  const Step = ({ n, title, done }: { n: number; title: string; done: boolean }) => (
    <div className="mb-3 flex items-center gap-2.5">
      <span
        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[13px] font-semibold"
        style={done
          ? { background: "var(--fx-success)", color: "#fff" }
          : { background: "var(--fx-primary-soft)", color: "var(--fx-primary-text)" }}
      >
        {done ? <Check className="h-4 w-4" /> : n}
      </span>
      <span className="fx-h2">{title}</span>
    </div>
  );

  return (
    <Page testId="workspace-new-page" width={960}>
      <PageHeader
        back={<Link to="/workspace" className="fx-btn fx-btn-ghost fx-btn-sm -ml-2.5"><ArrowLeft /> All tasks</Link>}
        eyebrow="Agent Workspace"
        title="New task"
        subtitle="Three quick steps and your team gets to work."
      />

      <section className="fx-card mb-4 p-5">
        <Step n={1} title="Choose a team" done={!!selected} />
        {isLoading ? (
          <p className="fx-small">Loading teams…</p>
        ) : teams.length === 0 ? (
          <EmptyState icon={<Briefcase />} title="No teams yet" action={<Link to="/studio/new" className="fx-btn fx-btn-primary"><Plus /> Build a team</Link>}>
            Build a team in Factory Studio first.
          </EmptyState>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {teams.map((t) => (
              <button
                key={t.name}
                type="button"
                data-testid={`workspace-team-${t.name}`}
                aria-pressed={team === t.name}
                onClick={() => setTeam(t.name)}
                className="fx-row items-start gap-3 border-[color:var(--fx-border)] p-3.5"
              >
                <Avatar name={t.title} colorKey={t.name} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="fx-h3 truncate">{t.title}</span>
                    {team === t.name ? <Check className="h-4 w-4 shrink-0 text-[color:var(--fx-primary-text)]" /> : null}
                  </span>
                  <span className="fx-small mt-1 flex flex-wrap items-center gap-1">
                    {t.members.map((m, i) => (
                      <span key={m.id} className="inline-flex items-center gap-1">
                        {i > 0 ? <span className="text-[color:var(--fx-subtle)]">{t.workflow === "sequential" ? "→" : "·"}</span> : null}
                        {m.title}
                      </span>
                    ))}
                  </span>
                  <span className="fx-tiny mt-1.5 inline-flex items-center gap-1"><FileText className="h-3.5 w-3.5" /> {t.deliverableCount} documents</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="fx-card mb-4 p-5">
        <Step n={2} title="Describe what you need" done={task.trim().length > 0} />
        <Field label="Task" hint="The more context, the better: the product, who uses it, constraints, what matters most.">
          <TextArea
            data-testid="workspace-task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            className="min-h-[170px]"
            placeholder="Build a booking app for a small clinic. Patients book, reschedule and cancel appointments; staff manage doctors' schedules…"
          />
        </Field>
      </section>

      <section className="fx-card mb-5 p-5">
        <Step n={3} title="Where should the team work?" done={projectDir.trim().startsWith("/")} />
        <Field label="Project folder" hint="A full path on this computer. The documents are saved here, for example docs/design/system-design.md.">
          <div className="relative">
            <FolderOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--fx-subtle)]" />
            <TextInput
              data-testid="workspace-project-dir"
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              placeholder="/Users/you/projects/clinic-booking"
              className="fx-mono pl-9"
            />
          </div>
        </Field>
      </section>

      {error ? (
        <div className="mb-4">
          <Alert tone="danger" icon={<AlertCircle />} title="Could not start the task" testId="workspace-start-error">{error}</Alert>
        </div>
      ) : null}

      <div className="fx-card flex flex-wrap items-center gap-4 p-4">
        <span className="fx-empty-icon h-10 w-10 rounded-[10px]"><Rocket className="!h-5 !w-5" /></span>
        <span className="fx-small min-w-0 flex-1">
          {selected
            ? <>Starts the {selected.memberCount} agents of <b className="text-[color:var(--fx-text)]">{selected.title}</b>{selected.workflow === "sequential" ? `. ${selected.members[0]?.title} gets the task first and hands off when done.` : ". Every member gets the task."}</>
            : "Choose a team to see what happens next."}
        </span>
        <Button variant="primary" disabled={!canStart} onClick={onStart} data-testid="workspace-start">
          <Play /> {start.isPending ? "Starting…" : "Start task"}
        </Button>
      </div>
    </Page>
  );
}
