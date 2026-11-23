// Factory Studio — team builder (/studio/new and /studio/teams/$teamName).
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Briefcase,
  CheckCircle2,
  Copy,
  Eye,
  FileCode2,
  FileText,
  Plus,
  Save,
  Sparkles,
  Terminal,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import {
  FactoryApiError,
  toSlug,
  useDeleteTeam,
  useDeliverableTemplates,
  useFactoryTeam,
  usePreviewTeam,
  useSaveTeam,
  type FactoryMember,
  type FactoryPreview,
  type FactoryTeamInput,
} from "../../hooks/useFactory.js";
import { cn } from "../../lib/utils.js";
import { Alert, Avatar, Button, Field, Page, PageHeader, Panel, Pill, TextArea, TextInput } from "./fields.js";
import { MemberEditor } from "./MemberEditor.js";
import { MEMBER_PRESETS, TEAM_TEMPLATES, emptyTeam, memberFromPreset, teamFromTemplate } from "./presets.js";

function stripTimestamps(t: FactoryTeamInput & { createdAt?: string; updatedAt?: string }): FactoryTeamInput {
  const { name, title, summary, workflow, members } = t;
  return { name, title, summary, workflow, members };
}

export function TeamBuilder({ teamName, templateId }: { teamName?: string; templateId?: string }) {
  const isNew = !teamName;
  const navigate = useNavigate();
  const existing = useFactoryTeam(teamName ?? null);
  const { data: templates = [] } = useDeliverableTemplates();
  const save = useSaveTeam();
  const remove = useDeleteTeam();
  const preview = usePreviewTeam();

  const [team, setTeam] = useState<FactoryTeamInput>(emptyTeam);
  const [nameTouched, setNameTouched] = useState(false);
  const [selected, setSelected] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewData, setPreviewData] = useState<FactoryPreview | null>(null);
  const [previewFile, setPreviewFile] = useState("rig.yaml");

  useEffect(() => {
    if (existing.data && !dirty) {
      setTeam(stripTimestamps(existing.data.team));
      setNameTouched(true);
    }
  }, [existing.data, dirty]);

  // Starting from a gallery template: fill the team once the document templates are loaded.
  const [templateApplied, setTemplateApplied] = useState(false);
  useEffect(() => {
    if (!isNew || templateApplied || !templateId || templates.length === 0) return;
    const t = TEAM_TEMPLATES.find((x) => x.id === templateId);
    if (t) {
      setTeam(teamFromTemplate(t, templates));
      setDirty(true);
      setSelected(0);
    }
    setTemplateApplied(true);
  }, [isNew, templateApplied, templateId, templates]);

  /** Functional update, so rapid successive edits never read a stale team. */
  const edit = (fn: (prev: FactoryTeamInput) => FactoryTeamInput) => {
    setTeam(fn);
    setDirty(true);
    setNotice(null);
  };
  const update = (next: Partial<FactoryTeamInput>) => edit((prev) => ({ ...prev, ...next }));

  const setMember = (i: number, m: FactoryMember) =>
    edit((prev) => ({ ...prev, members: prev.members.map((x, k) => (k === i ? m : x)) }));

  const addMember = (presetId: string | null) => {
    const preset = MEMBER_PRESETS.find((p) => p.id === presetId) ?? null;
    edit((prev) => {
      const m = memberFromPreset(preset, templates, prev.members.map((x) => x.id));
      setSelected(prev.members.length);
      return { ...prev, members: [...prev.members, m] };
    });
  };

  const moveMember = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= team.members.length) return;
    edit((prev) => {
      const members = [...prev.members];
      [members[i], members[j]] = [members[j]!, members[i]!];
      return { ...prev, members };
    });
    setSelected(j);
  };

  const removeMember = (i: number) => {
    edit((prev) => ({ ...prev, members: prev.members.filter((_, k) => k !== i) }));
    setSelected((s) => Math.max(0, Math.min(s, team.members.length - 2)));
  };

  const duplicateMember = (i: number) => {
    edit((prev) => {
      const src = prev.members[i]!;
      const copy = memberFromPreset(null, templates, prev.members.map((x) => x.id));
      const m: FactoryMember = {
        ...structuredClone(src),
        id: copy.id,
        title: `${src.title} (copy)`,
        deliverables: src.deliverables.map((d) => ({ ...d, path: d.path.replace(/(\.[a-z0-9]+)?$/i, `-copy$1`) })),
      };
      const members = [...prev.members];
      members.splice(i + 1, 0, m);
      return { ...prev, members };
    });
    setSelected(i + 1);
  };

  const pathsByMember = useMemo(
    () => team.members.map((m, i) => team.members.flatMap((o, j) => (j === i ? [] : o.deliverables.map((d) => d.path)))),
    [team.members],
  );

  const handleError = (err: unknown) => {
    if (err instanceof FactoryApiError) setErrors(err.errors.length ? err.errors : [err.message]);
    else setErrors([err instanceof Error ? err.message : String(err)]);
  };

  const onSave = () => {
    setErrors([]);
    save.mutate(
      { team, isNew },
      {
        onSuccess: () => {
          setDirty(false);
          setNotice("Team saved.");
          if (isNew) void navigate({ to: "/studio/teams/$teamName", params: { teamName: team.name } });
        },
        onError: handleError,
      },
    );
  };

  const onPreview = () => {
    setShowPreview(true);
    preview.mutate(team, {
      onSuccess: (p) => {
        setPreviewData(p);
        setErrors(p.errors);
        if (!(previewFile in p.files)) setPreviewFile("rig.yaml");
      },
      onError: handleError,
    });
  };

  const onDelete = () => {
    if (!teamName) return;
    if (!window.confirm(`Delete the team "${teamName}" and its generated specs? A running rig of this team is not stopped.`)) return;
    remove.mutate(teamName, { onSuccess: () => void navigate({ to: "/studio" }), onError: handleError });
  };

  if (!isNew && existing.isLoading) {
    return <Page><p className="fx-small">Loading team…</p></Page>;
  }
  if (!isNew && existing.error) {
    return (
      <Page>
        <Alert tone="danger" icon={<AlertCircle />} title="Could not load this team">
          {(existing.error as Error).message} · <Link to="/studio" className="underline">Back to teams</Link>
        </Alert>
      </Page>
    );
  }

  const member = team.members[selected];
  const canSave = team.title.trim() && team.name && team.members.length > 0 && !save.isPending;
  const docCount = team.members.reduce((n, m) => n + m.deliverables.length, 0);

  return (
    <Page testId="factory-team-builder" width={1320}>
      <PageHeader
        back={
          <Link to="/studio" className="fx-btn fx-btn-ghost fx-btn-sm -ml-2.5">
            <ArrowLeft /> All teams
          </Link>
        }
        eyebrow={isNew ? "New team" : "Factory Studio"}
        title={
          <span className="inline-flex flex-wrap items-center gap-3">
            {team.title || (isNew ? "Untitled team" : teamName)}
            {dirty ? <Pill tone="warning" dot>Unsaved changes</Pill> : null}
          </span>
        }
        subtitle={
          !isNew && existing.data ? (
            <span className="inline-flex flex-wrap items-center gap-2" data-testid="factory-launch-hint">
              <Terminal className="h-4 w-4" /> Launch from a terminal: <code>rig up {existing.data.team.name} --cwd &lt;project&gt;</code>
            </span>
          ) : (
            "Name the team, add members, then give each one its skills and the documents it should write."
          )
        }
        actions={
          <>
            {!isNew ? (
              <Button variant="danger" onClick={onDelete} disabled={remove.isPending} data-testid="factory-delete-team">
                <Trash2 /> Delete
              </Button>
            ) : null}
            <Button onClick={onPreview} disabled={preview.isPending || team.members.length === 0} data-testid="factory-preview">
              <Eye /> {preview.isPending ? "Checking…" : "Preview"}
            </Button>
            {!isNew && !dirty ? (
              <Link to="/workspace/new" search={{ team: teamName }} data-testid="factory-give-task" className="fx-btn fx-btn-secondary">
                <Briefcase /> Give a task
              </Link>
            ) : null}
            <Button variant="primary" onClick={onSave} disabled={!canSave} data-testid="factory-save">
              <Save /> {save.isPending ? "Saving…" : "Save team"}
            </Button>
          </>
        }
      />

      <div className="mb-5 flex flex-col gap-3 empty:hidden">
        {errors.length ? (
          <Alert tone="danger" icon={<AlertCircle />} title="Please fix these before saving" testId="factory-errors">
            <ul className="list-disc pl-4">
              {errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          </Alert>
        ) : null}
        {notice ? (
          <Alert tone="success" icon={<CheckCircle2 />} title={notice} testId="factory-notice" />
        ) : null}
      </div>

      <Panel title="About this team" className="mb-5">
        <div className="grid gap-4 md:grid-cols-[2fr_1fr_auto]">
          <Field label="Team name">
            <TextInput
              data-testid="factory-team-title"
              value={team.title}
              placeholder="e.g. Product Docs Team"
              onChange={(e) => {
                const title = e.target.value;
                update(isNew && !nameTouched ? { title, name: toSlug(title) } : { title });
              }}
            />
          </Field>
          <Field label="Short name" hint={isNew ? "Used by the rig command. Can't change later." : "Fixed after the first save."}>
            <TextInput
              data-testid="factory-team-name"
              value={team.name}
              disabled={!isNew}
              placeholder="product-docs"
              className="fx-mono"
              onChange={(e) => {
                setNameTouched(true);
                update({ name: toSlug(e.target.value) });
              }}
            />
          </Field>
          <Field label="How members work">
            <div className="fx-segment">
              {(["sequential", "parallel"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  data-testid={`factory-workflow-${mode}`}
                  aria-pressed={team.workflow === mode}
                  onClick={() => update({ workflow: mode })}
                >
                  {mode === "sequential" ? "One after another" : "All at once"}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Description" className="md:col-span-3">
            <TextArea
              value={team.summary}
              onChange={(e) => update({ summary: e.target.value.replace(/\n/g, " ") })}
              className="min-h-[64px]"
              placeholder="Turns a product idea into requirements, a system design, an API spec and a test plan."
            />
          </Field>
        </div>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <Panel
          title={
            <span className="inline-flex items-center gap-2">
              Members <span className="fx-count">{team.members.length}</span>
            </span>
          }
          testId="factory-members"
          actions={
            <Button size="sm" variant="ghost" onClick={() => addMember(null)} data-testid="factory-add-member-blank">
              <Plus /> Blank
            </Button>
          }
          bodyClassName="p-3"
        >
          {team.members.length === 0 ? (
            <p className="fx-small mb-3 px-1">Add members from a role below. Each role comes with its usual document, which you can change.</p>
          ) : (
            <ol className="mb-3 flex flex-col gap-1">
              {team.members.map((m, i) => (
                <li key={i} className="flex flex-col">
                  {i > 0 && team.workflow === "sequential" ? (
                    <span className="ml-[26px] h-2 border-l-2 border-dashed border-[color:var(--fx-border-strong)]" aria-hidden="true" />
                  ) : null}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-selected={i === selected}
                    data-testid={`factory-member-row-${i}`}
                    onClick={() => setSelected(i)}
                    onKeyDown={(e) => e.key === "Enter" && setSelected(i)}
                    className="fx-row group cursor-pointer"
                  >
                    <Avatar name={m.title || m.id} colorKey={m.id} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold">{m.title || m.id}</span>
                      <span className="fx-tiny block truncate">
                        {m.runtime === "codex" ? "Codex" : "Claude Code"} · {m.skills.length + m.customSkills.length} skills · {m.deliverables.length} docs
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col opacity-0 transition-opacity group-hover:opacity-100 group-aria-selected:opacity-100">
                      <button type="button" aria-label="Move up" onClick={(e) => { e.stopPropagation(); moveMember(i, -1); }} disabled={i === 0} className="rounded p-0.5 hover:bg-[color:var(--fx-surface-3)] disabled:opacity-30">
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" aria-label="Move down" onClick={(e) => { e.stopPropagation(); moveMember(i, 1); }} disabled={i === team.members.length - 1} className="rounded p-0.5 hover:bg-[color:var(--fx-surface-3)] disabled:opacity-30">
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <div className="fx-divider px-1 pt-3">
            <p className="fx-small mb-2 inline-flex items-center gap-1.5 font-medium">
              <UserPlus className="h-4 w-4" /> Add a role
            </p>
            <div className="flex flex-wrap gap-1.5">
              {MEMBER_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addMember(p.id)}
                  data-testid={`factory-add-member-${p.id}`}
                  className="fx-btn fx-btn-secondary fx-btn-sm"
                >
                  <Plus /> {p.title}
                </button>
              ))}
            </div>
          </div>
        </Panel>

        <Panel
          title={
            member ? (
              <span className="flex min-w-0 items-center gap-3">
                <Avatar name={member.title || member.id} colorKey={member.id} />
                <span className="min-w-0">
                  <span className="block truncate">{member.title || member.id}</span>
                  <span className="fx-tiny fx-mono block font-normal">{team.name ? `team-${member.id}@${team.name}` : `team-${member.id}`}</span>
                </span>
              </span>
            ) : (
              "Member"
            )
          }
          actions={
            member ? (
              <>
                <Button size="icon" variant="ghost" aria-label="Duplicate member" title="Duplicate" onClick={() => duplicateMember(selected)}>
                  <Copy />
                </Button>
                <Button size="icon" variant="ghost" aria-label="Remove member" title="Remove" onClick={() => removeMember(selected)} data-testid="factory-remove-member">
                  <Trash2 />
                </Button>
              </>
            ) : null
          }
          bodyClassName="pt-2"
        >
          {member ? (
            <MemberEditor
              key={selected}
              member={member}
              otherIds={team.members.filter((_, k) => k !== selected).map((m) => m.id)}
              takenPaths={pathsByMember[selected] ?? []}
              templates={templates}
              onChange={(m) => setMember(selected, m)}
            />
          ) : (
            <div className="fx-empty my-4">
              <span className="fx-empty-icon"><Sparkles /></span>
              <div className="fx-h3">No members yet</div>
              <div className="fx-small">Pick a role on the left to add your first member.</div>
            </div>
          )}
        </Panel>
      </div>

      {team.members.length ? (
        <p className="fx-tiny mt-3 inline-flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" /> {team.members.length} members will write {docCount} documents.
        </p>
      ) : null}

      {showPreview ? (
        <Panel
          title={
            <span className="inline-flex items-center gap-2">
              <FileCode2 className="h-4 w-4" /> Generated files
              {previewData ? (
                <Pill tone={previewData.valid ? "success" : "danger"} dot>{previewData.valid ? "Valid" : "Has errors"}</Pill>
              ) : null}
            </span>
          }
          className="mt-5"
          testId="factory-preview-panel"
          actions={<Button size="icon" variant="ghost" aria-label="Close preview" onClick={() => setShowPreview(false)}><X /></Button>}
        >
          {preview.isPending && !previewData ? (
            <p className="fx-small">Generating…</p>
          ) : previewData ? (
            <div className="grid gap-4 md:grid-cols-[260px_1fr]">
              <ul className="flex flex-col gap-0.5">
                {Object.keys(previewData.files).sort().map((f) => (
                  <li key={f}>
                    <button
                      type="button"
                      aria-selected={f === previewFile}
                      onClick={() => setPreviewFile(f)}
                      className="fx-row fx-mono truncate py-1.5 text-[12px]"
                    >
                      {f}
                    </button>
                  </li>
                ))}
              </ul>
              <pre className={cn("fx-pre max-h-[480px] overflow-auto")}>{previewData.files[previewFile] ?? ""}</pre>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </Page>
  );
}
