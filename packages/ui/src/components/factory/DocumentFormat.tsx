// Factory Studio — a document's file format (Markdown / Word / Excel) and the form it follows.
import { useRef, type ReactNode } from "react";
import { Download, FileSpreadsheet, FileText, FileType2, Upload } from "lucide-react";
import type { FactoryDeliverable } from "../../hooks/useFactory.js";
import {
  deliverableFormat, pathWithFormat, templateFileUrl, useOfficeTemplateInspection, useOfficeTemplates, useUploadOfficeTemplate,
  type OfficeFormat,
} from "../../hooks/useOfficeTemplates.js";
import { Button, Field, Select } from "./fields.js";

const FORMATS: Array<{ id: "markdown" | OfficeFormat; label: string; icon: ReactNode }> = [
  { id: "markdown", label: "Markdown", icon: <FileText className="h-3.5 w-3.5" /> },
  { id: "docx", label: "Word", icon: <FileType2 className="h-3.5 w-3.5" /> },
  { id: "xlsx", label: "Excel", icon: <FileSpreadsheet className="h-3.5 w-3.5" /> },
];

export function outlineLabel(path: string): { label: string; placeholder: string } {
  const f = deliverableFormat(path);
  if (f === "xlsx") return { label: "What goes in the workbook", placeholder: "Sheet \"Test cases\": one row per test from row 5 — ID, description, steps, expected result, status.\nSheet \"Summary\": B2 = project name, B3 = number of tests." };
  if (f === "docx") return { label: "Content outline", placeholder: "# Overview\n## Scope\n## Requirements\n## Risks" };
  return { label: "Outline to follow", placeholder: "# Overview\n## Scope\n## Requirements" };
}

function FormSummary({ id }: { id: string }) {
  const { data, isLoading, error } = useOfficeTemplateInspection(id);
  if (isLoading) return <p className="fx-tiny">Reading the form…</p>;
  if (error) return <p className="fx-tiny text-[color:var(--fx-danger)]">{(error as Error).message}</p>;
  if (!data) return null;
  if (data.docx) {
    const d = data.docx;
    const headings = d.styles.filter((s) => /^heading \d$/.test(s)).length;
    return (
      <div className="fx-tiny flex flex-col gap-1" data-testid="factory-form-summary">
        <span>
          {d.outline.filter((o) => /^heading \d$/.test(o.style ?? "")).slice(0, 8).map((o) => o.text).join(" · ") || "No headings found; agents follow its text layout."}
        </span>
        <span>{`${headings} heading styles, ${d.tables} table${d.tables === 1 ? "" : "s"}.`}</span>
      </div>
    );
  }
  if (data.xlsx) {
    return (
      <ul className="fx-tiny flex flex-col gap-1" data-testid="factory-form-summary">
        {data.xlsx.sheets.map((s) => (
          <li key={s.name}>
            <b className="text-[color:var(--fx-text)]">{s.name}</b>
            {s.header ? <> · header row {s.header.row}: {s.header.cells.slice(0, 6).map((c) => c.text).join(", ")}{s.header.cells.length > 6 ? "…" : ""}</> : " · no header row found"}
            {s.firstEmptyRow ? <> · rows start at {s.firstEmptyRow}</> : null}
            {s.placeholders.length ? <> · fields {s.placeholders.map((p) => `{{${p}}}`).join(" ")}</> : null}
          </li>
        ))}
      </ul>
    );
  }
  return null;
}

export function DocumentFormat({ d, onChange }: { d: FactoryDeliverable; onChange: (next: FactoryDeliverable) => void }) {
  const format = deliverableFormat(d.path);
  const forms = useOfficeTemplates();
  const upload = useUploadOfficeTemplate();
  const fileInput = useRef<HTMLInputElement>(null);
  const office = format === "docx" || format === "xlsx";
  const matching = (forms.data ?? []).filter((t) => t.format === format);
  const current = d.template ? (forms.data ?? []).find((t) => t.id === d.template) : undefined;
  const missing = !!d.template && forms.isSuccess && !current;

  const setFormat = (next: "markdown" | OfficeFormat) => {
    if (next === format) return;
    const { template: _drop, ...rest } = d;
    onChange({ ...rest, path: pathWithFormat(d.path, next) });
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    upload.mutate(file, {
      onSuccess: (t) => {
        const { template: _drop, ...rest } = d;
        onChange({ ...rest, path: t.format === format ? d.path : pathWithFormat(d.path, t.format), template: t.id });
      },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="fx-label">File type</span>
        <div className="fx-segment" role="group" aria-label="File type" data-testid="factory-document-format">
          {FORMATS.map((f) => (
            <button key={f.id} type="button" aria-pressed={format === f.id} onClick={() => setFormat(f.id)} className="inline-flex items-center gap-1.5">
              {f.icon} {f.label}
            </button>
          ))}
        </div>
      </div>

      {office ? (
        <div className="fx-inset flex flex-col gap-2.5 p-3">
          <Field
            label={format === "docx" ? "Word sample to model on" : "Excel sample to model on"}
            hint={missing
              ? <span className="text-[color:var(--fx-danger)]">This form was deleted. Pick or upload another.</span>
              : current ? undefined : "Without a sample, agents use a clean default layout."}
          >
            <div className="flex flex-wrap gap-2">
              <Select
                data-testid="factory-document-form"
                className="min-w-[220px] flex-1"
                value={current ? current.id : ""}
                onChange={(e) => {
                  const { template: _drop, ...rest } = d;
                  onChange(e.target.value ? { ...rest, template: e.target.value } : rest);
                }}
              >
                <option value="">No sample (default layout)</option>
                {matching.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                accept={format === "docx" ? ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" : ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
                data-testid="factory-document-form-file"
                onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }}
              />
              <Button onClick={() => fileInput.current?.click()} disabled={upload.isPending} data-testid="factory-document-form-upload">
                <Upload /> {upload.isPending ? "Uploading…" : "Upload sample"}
              </Button>
              {current ? (
                <a className="fx-btn fx-btn-ghost" href={templateFileUrl(current.id)} title="Download the form">
                  <Download />
                </a>
              ) : null}
            </div>
          </Field>
          {upload.error ? <p className="fx-tiny text-[color:var(--fx-danger)]">{(upload.error as Error).message}</p> : null}
          {current ? <FormSummary id={current.id} /> : null}
          <p className="fx-tiny">
            Agents read the sample, then write a new {format === "docx" ? "document" : "workbook"} for the task in the same kind of structure
            and in its look ({format === "docx" ? "heading, list and table styles, page setup, header and footer" : "header and cell styles"}).
            They may add, drop or improve sections; the sample's own example text is never handed back.
          </p>
        </div>
      ) : null}
    </div>
  );
}
