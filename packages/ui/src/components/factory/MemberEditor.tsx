// Factory Studio — editor for one team member: basics, skills, documents.
import { useMemo, useState } from "react";
import { BookOpen, Check, FileText, Plus, Search, Settings2, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useLibrarySkills } from "../../hooks/useLibrarySkills.js";
import {
  toSlug,
  type DeliverableTemplate,
  type FactoryCustomSkill,
  type FactoryDeliverable,
  type FactoryMember,
} from "../../hooks/useFactory.js";
import { Button, EmptyState, Field, Pill, Select, TextArea, TextInput } from "./fields.js";
import { EFFORT_LEVELS, deliverableFromTemplate, uniqueId } from "./presets.js";

type Tab = "basics" | "skills" | "deliverables";

interface Props {
  member: FactoryMember;
  otherIds: string[];
  takenPaths: string[];
  templates: DeliverableTemplate[];
  onChange: (next: FactoryMember) => void;
}

export function MemberEditor({ member, otherIds, takenPaths, templates, onChange }: Props) {
  const [tab, setTab] = useState<Tab>("basics");
  const set = <K extends keyof FactoryMember>(key: K, value: FactoryMember[K]) => onChange({ ...member, [key]: value });
  const skillCount = member.skills.length + member.customSkills.length;

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode; count?: number }> = [
    { id: "basics", label: "Basics", icon: <Settings2 /> },
    { id: "skills", label: "Skills", icon: <Sparkles />, count: skillCount },
    { id: "deliverables", label: "Documents", icon: <FileText />, count: member.deliverables.length },
  ];

  return (
    <div data-testid="factory-member-editor" className="flex flex-col">
      <div role="tablist" className="fx-tabs -mx-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`factory-member-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className="fx-tab"
          >
            {t.icon}
            {t.label}
            {t.count !== undefined ? <span className="fx-count">{t.count}</span> : null}
          </button>
        ))}
      </div>
      <div className="pt-5">
        {tab === "basics" ? <Basics member={member} otherIds={otherIds} set={set} /> : null}
        {tab === "skills" ? <Skills member={member} set={set} /> : null}
        {tab === "deliverables" ? <Deliverables member={member} takenPaths={takenPaths} templates={templates} set={set} /> : null}
      </div>
    </div>
  );
}

type Setter = <K extends keyof FactoryMember>(key: K, value: FactoryMember[K]) => void;

function Basics({ member, otherIds, set }: { member: FactoryMember; otherIds: string[]; set: Setter }) {
  const idClash = otherIds.includes(member.id);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="Name">
        <TextInput data-testid="factory-member-title" value={member.title} onChange={(e) => set("title", e.target.value)} placeholder="Solution Architect" />
      </Field>
      <Field
        label="Member id"
        hint={idClash ? <span className="text-[color:var(--fx-danger)]">Another member already uses this id.</span> : "Used in the agent's address, e.g. team-architect@your-team."}
      >
        <TextInput data-testid="factory-member-id" value={member.id} className="fx-mono" onChange={(e) => set("id", toSlug(e.target.value))} />
      </Field>
      <Field label="Role" hint="A short label, like architect, backend or qa.">
        <TextInput value={member.role} className="fx-mono" onChange={(e) => set("role", toSlug(e.target.value))} placeholder={member.id} />
      </Field>
      <Field label="Thinking effort">
        <Select value={member.effort ?? ""} onChange={(e) => set("effort", e.target.value || undefined)}>
          <option value="">Default</option>
          {EFFORT_LEVELS["claude-code"].map((l) => (
            <option key={l} value={l}>{l[0]!.toUpperCase() + l.slice(1)}</option>
          ))}
        </Select>
      </Field>
      <Field label="What this member does" className="md:col-span-2" hint="The agent reads this when it starts. Describe the job like you would to a new colleague.">
        <TextArea
          data-testid="factory-member-instructions"
          value={member.instructions}
          onChange={(e) => set("instructions", e.target.value)}
          placeholder="Design the system that satisfies the requirements…"
          className="min-h-[140px]"
        />
      </Field>
    </div>
  );
}

function Skills({ member, set }: { member: FactoryMember; set: Setter }) {
  const { data: library = [], isLoading } = useLibrarySkills();
  const [query, setQuery] = useState("");
  const selected = new Set(member.skills);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...library]
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
      .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, query]);

  const toggle = (id: string) =>
    set("skills", selected.has(id) ? member.skills.filter((s) => s !== id) : [...member.skills, id]);

  const updateCustom = (i: number, next: FactoryCustomSkill | null) => {
    const list = [...member.customSkills];
    if (next) list[i] = next;
    else list.splice(i, 1);
    set("customSkills", list);
  };

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="fx-h3 inline-flex items-center gap-2"><BookOpen className="h-4 w-4" /> Skill library</span>
          <Pill tone={member.skills.length ? "primary" : "neutral"}>{member.skills.length} selected</Pill>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--fx-subtle)]" />
          <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills" className="pl-9" />
        </div>
        <ul data-testid="factory-skill-library" className="fx-inset flex max-h-[380px] flex-col gap-0.5 overflow-y-auto p-1.5">
          {isLoading ? <li className="fx-small p-2">Loading…</li> : null}
          {!isLoading && filtered.length === 0 ? <li className="fx-small p-2">No skills match.</li> : null}
          {filtered.map((s) => {
            const on = selected.has(s.id);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => toggle(s.id)}
                  data-testid={`factory-skill-${s.name}`}
                  aria-pressed={on}
                  className="fx-row py-1.5"
                >
                  <span className="fx-check" data-on={on}>{on ? <Check /> : null}</span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">{s.name}</span>
                  <span className="fx-tiny">{s.source === "workspace" ? "Workspace" : "Built-in"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="fx-h3 inline-flex items-center gap-2"><Wand2 className="h-4 w-4" /> Your own skills</span>
          <Button
            size="sm"
            data-testid="factory-add-custom-skill"
            onClick={() =>
              set("customSkills", [
                ...member.customSkills,
                { name: uniqueId("custom-skill", member.customSkills.map((c) => c.name)), description: "", content: "" },
              ])
            }
          >
            <Plus /> Write a skill
          </Button>
        </div>
        {member.customSkills.length === 0 ? (
          <EmptyState icon={<Wand2 />} title="No custom skills">
            Write instructions just for this member, like your team's API conventions or a review checklist.
          </EmptyState>
        ) : null}
        {member.customSkills.map((c, i) => (
          <div key={i} className="fx-card flex flex-col gap-3 p-4">
            <div className="flex items-end gap-2">
              <Field label="Skill name" className="flex-1">
                <TextInput value={c.name} className="fx-mono" onChange={(e) => updateCustom(i, { ...c, name: toSlug(e.target.value) })} />
              </Field>
              <Button size="icon" variant="ghost" aria-label="Remove custom skill" onClick={() => updateCustom(i, null)}>
                <Trash2 />
              </Button>
            </div>
            <Field label="When should the agent use it?">
              <TextInput value={c.description} onChange={(e) => updateCustom(i, { ...c, description: e.target.value })} placeholder="Use when writing OpenAPI specs…" />
            </Field>
            <Field label="Instructions" hint="Markdown is fine.">
              <TextArea value={c.content} onChange={(e) => updateCustom(i, { ...c, content: e.target.value })} className="min-h-[120px]" />
            </Field>
          </div>
        ))}
      </div>
    </div>
  );
}

function Deliverables({ member, takenPaths, templates, set }: {
  member: FactoryMember;
  takenPaths: string[];
  templates: DeliverableTemplate[];
  set: Setter;
}) {
  const [templateId, setTemplateId] = useState("");
  const update = (i: number, next: FactoryDeliverable | null) => {
    const list = [...member.deliverables];
    if (next) list[i] = next;
    else list.splice(i, 1);
    set("deliverables", list);
  };
  const add = (d: FactoryDeliverable) => {
    const id = uniqueId(d.id, member.deliverables.map((x) => x.id));
    set("deliverables", [...member.deliverables, { ...d, id }]);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="fx-inset flex flex-wrap items-end gap-2 p-3">
        <Field label="Add a document from a template" className="min-w-[240px] flex-1">
          <Select data-testid="factory-deliverable-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Choose a document type…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </Select>
        </Field>
        <Button
          variant="primary"
          data-testid="factory-add-deliverable-template"
          disabled={!templateId}
          onClick={() => {
            const t = templates.find((x) => x.id === templateId);
            if (t) add(deliverableFromTemplate(t));
            setTemplateId("");
          }}
        >
          <Plus /> Add
        </Button>
        <Button
          data-testid="factory-add-deliverable-blank"
          onClick={() => add({ id: "document", title: "New document", path: `docs/${member.id}/document.md`, outline: "", acceptance: "" })}
        >
          Blank document
        </Button>
      </div>

      {member.deliverables.length === 0 ? (
        <EmptyState icon={<FileText />} title="No documents yet">
          Add what this member should write, like a system design, an API spec or a test plan.
        </EmptyState>
      ) : null}

      {member.deliverables.map((d, i) => {
        const pathClash = takenPaths.includes(d.path) || member.deliverables.some((o, j) => j !== i && o.path === d.path);
        return (
          <div key={i} data-testid={`factory-deliverable-${i}`} className="fx-card flex flex-col gap-4 p-4">
            <div className="flex items-start gap-3">
              <span className="fx-empty-icon h-10 w-10 shrink-0 rounded-[10px]"><FileText className="!h-5 !w-5" /></span>
              <div className="grid flex-1 gap-3 md:grid-cols-2">
                <Field label="Document">
                  <TextInput value={d.title} onChange={(e) => update(i, { ...d, title: e.target.value })} />
                </Field>
                <Field
                  label="Saved to (in the project)"
                  hint={pathClash ? <span className="text-[color:var(--fx-danger)]">Another document already uses this path.</span> : undefined}
                >
                  <TextInput value={d.path} className="fx-mono" onChange={(e) => update(i, { ...d, path: e.target.value.trim() })} placeholder="docs/design/system-design.md" />
                </Field>
              </div>
              <Button size="icon" variant="ghost" aria-label="Remove document" className="mt-6" onClick={() => update(i, null)}>
                <Trash2 />
              </Button>
            </div>
            <Field label="Outline to follow">
              <TextArea value={d.outline} onChange={(e) => update(i, { ...d, outline: e.target.value })} className="fx-mono min-h-[150px] text-[12.5px]" />
            </Field>
            <Field label="Done when">
              <TextInput value={d.acceptance} onChange={(e) => update(i, { ...d, acceptance: e.target.value })} placeholder="Every requirement maps to a test case" />
            </Field>
          </div>
        );
      })}
    </div>
  );
}
