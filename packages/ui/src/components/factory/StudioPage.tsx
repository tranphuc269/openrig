// Factory Studio — team list (/studio).
import { Link } from "@tanstack/react-router";
import { ArrowRight, FileText, LayoutTemplate, Plus, Sparkles, Users, Workflow } from "lucide-react";
import { TEAM_TEMPLATES } from "./presets.js";
import { useFactoryTeams } from "../../hooks/useFactory.js";
import { Alert, Avatar, EmptyState, Page, PageHeader, Pill } from "./fields.js";
import { ReadinessBanner } from "../setup/SetupPage.js";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function StudioPage() {
  const { data: teams = [], isLoading, error } = useFactoryTeams();

  return (
    <Page testId="factory-studio-page">
      <PageHeader
        eyebrow="Factory Studio"
        title="Build a team"
        subtitle="Build a team of AI agents. Give each member skills and the documents it should deliver, like a system design, an API spec or a test plan."
        actions={
          <Link to="/studio/new" data-testid="factory-new-team" className="fx-btn fx-btn-primary">
            <Plus /> New team
          </Link>
        }
      />

      <ReadinessBanner />

      <section className="mb-8" data-testid="factory-templates">
        <h2 className="fx-h2 mb-1 inline-flex items-center gap-2"><LayoutTemplate className="h-4 w-4" /> Start from a template</h2>
        <p className="fx-small mb-3">Ready-made teams with roles and documents filled in. Pick one, then change anything.</p>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TEAM_TEMPLATES.map((t) => (
            <li key={t.id}>
              <Link
                to="/studio/new"
                search={{ template: t.id }}
                data-testid={`factory-template-${t.id}`}
                className="fx-card fx-card-hover flex h-full flex-col gap-2.5 p-4"
              >
                <div className="flex items-center gap-2.5">
                  <Avatar name={t.title} colorKey={t.id} />
                  <div className="min-w-0">
                    <div className="fx-h3 truncate">{t.title}</div>
                    <div className="fx-tiny truncate">{t.bestFor}</div>
                  </div>
                </div>
                <p className="fx-small line-clamp-2">{t.summary}</p>
                <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
                  {t.members.map((m, i) => (
                    <span key={m.id} className="inline-flex items-center gap-1 text-[12px]">
                      {i > 0 ? <span className="text-[color:var(--fx-subtle)]">{t.workflow === "sequential" ? "→" : "+"}</span> : null}
                      <Avatar name={m.title} colorKey={m.id} size="sm" />
                    </span>
                  ))}
                  <span className="fx-tiny ml-auto">{t.members.reduce((n, m) => n + m.docs.length, 0)} docs</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <h2 className="fx-h2 mb-3">Your teams</h2>

      {error ? (
        <Alert tone="danger" title="Could not load teams">
          {(error as Error).message}. Is the daemon running a build that includes Factory Studio?
        </Alert>
      ) : isLoading ? (
        <p className="fx-small">Loading teams…</p>
      ) : teams.length === 0 ? (
        <div data-testid="factory-empty">
          <EmptyState
            icon={<Sparkles />}
            title="Create your first team"
            action={<Link to="/studio/new" className="fx-btn fx-btn-primary"><Plus /> New team</Link>}
          >
            Start with a classic flow such as Analyst → Architect → Backend → QA. Each member writes one document and hands off to the next.
          </EmptyState>
        </div>
      ) : (
        <ul data-testid="factory-team-list" className="grid gap-4 md:grid-cols-2">
          {teams.map((t) => (
            <li key={t.name}>
              <Link
                to="/studio/teams/$teamName"
                params={{ teamName: t.name }}
                data-testid={`factory-team-${t.name}`}
                className="fx-card fx-card-hover group flex h-full flex-col gap-4 p-5"
              >
                <div className="flex items-start gap-3">
                  <Avatar name={t.title} colorKey={t.name} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="fx-h2 truncate">{t.title}</div>
                    <div className="fx-tiny fx-mono">{t.name}</div>
                  </div>
                  <Pill tone={t.workflow === "sequential" ? "primary" : "info"}>
                    <Workflow className="h-3.5 w-3.5" /> {t.workflow === "sequential" ? "In order" : "Parallel"}
                  </Pill>
                </div>

                {t.summary ? <p className="fx-small line-clamp-2">{t.summary}</p> : null}

                <div className="flex flex-wrap items-center gap-1.5">
                  {t.members.map((m, i) => (
                    <span key={m.id} className="inline-flex items-center gap-1.5">
                      {i > 0 && t.workflow === "sequential" ? <ArrowRight className="h-3.5 w-3.5 text-[color:var(--fx-subtle)]" /> : null}
                      <span className="fx-inset inline-flex items-center gap-1.5 py-1 pl-1 pr-2.5 text-[12.5px] font-medium">
                        <Avatar name={m.title} colorKey={m.id} size="sm" />
                        {m.title}
                      </span>
                    </span>
                  ))}
                </div>

                <div className="fx-divider mt-auto flex items-center gap-4 pt-3 fx-small">
                  <span className="inline-flex items-center gap-1.5"><Users className="h-4 w-4" /> {t.memberCount} members</span>
                  <span className="inline-flex items-center gap-1.5"><FileText className="h-4 w-4" /> {t.deliverableCount} documents</span>
                  <span className="ml-auto fx-tiny">Updated {formatDate(t.updatedAt)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
