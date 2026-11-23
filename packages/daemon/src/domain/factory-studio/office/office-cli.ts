#!/usr/bin/env node
// Factory Studio office tool — how agents write and read Word and Excel documents.
//
//   office inspect <template.docx|xlsx>                     what the form contains
//   office docx --out <file.docx> [--template <t.docx>] [--content <draft.md>] [--vars <vars.json>]
//   office xlsx --out <file.xlsx> [--template <t.xlsx>] --data <data.json>
//   office read <file.docx|xlsx>                            a document as Markdown
//
// Generated agent guidance calls this file with the daemon's own node binary.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildDocx, inspectDocx, readDocx } from "./docx.js";
import { buildXlsx, inspectXlsx, readXlsx, type XlsxData } from "./xlsx.js";

const USAGE = `Factory Studio office tool (rig office <command>)

  read <file.docx|file.xlsx>
      Print a Word or Excel file as Markdown: read a form to understand it, or a teammate's document.

  inspect <form.docx|form.xlsx>
      Show a form's styles, {{placeholders}}, sheets and header rows.

  docx --style <form.docx> --content <draft.md> --out <file.docx> [--vars <vars.json>]
      Write a NEW Word document in the form's look: its styles (headings, lists, tables), page setup,
      header and footer are kept; the body is your Markdown draft. The form's own body text is not kept,
      so put everything the document needs in the draft (title page, history table, sections, …).
      vars.json fills {{placeholders}} left in the header/footer: {"project": "Clinic booking"}.

  docx --template <form.docx> [--content <draft.md>] [--vars <vars.json>] --out <file.docx>
      Fill the form itself: {{placeholders}} get values, the draft replaces a {{content}} paragraph
      (or is added at the end). Only for forms made with {{placeholders}}.

  docx --content <draft.md> --out <file.docx>
      A Word document in a clean default look.

  xlsx --style <form.xlsx> --data <data.json> --out <file.xlsx>
      A NEW workbook whose sheets you design ("sheets" below), with the form's header and cell look.

  xlsx --template <form.xlsx> --data <data.json> --out <file.xlsx>
      Fill the form itself: vars, cells and table rows written into its sheets.

  data.json:
    { "sheets": [ { "name": "Test cases", "columns": ["ID", "Title", "Steps", "Expected"], "rows": [["TC-01", "Log in", "…", "…"]] } ],
      "vars":   { "project": "Clinic" },                 // {{placeholders}} in cells (--template)
      "cells":  { "Summary!B2": "v1.0", "B3": 42 },      // single cells; "=SUM(A1:A3)" is a formula
      "tables": [ { "sheet": "Test cases", "start": "A5", "rows": [["TC-01", "Login", "Pass"]] } ] }
    Table rows copy the style of the start row. Add "insert": true to push rows below down.
`;

function fail(message: string): never {
  process.stderr.write(`office: ${message}\n`);
  process.exit(1);
}

function args(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      const v = inline ?? argv[++i];
      if (v === undefined) fail(`--${k} needs a value`);
      flags[k] = v;
    } else positional.push(a);
  }
  return { positional, flags };
}

function readFile(p: string, what: string): Buffer {
  try {
    return fs.readFileSync(path.resolve(p));
  } catch {
    fail(`can't read ${what} ${p}`);
  }
}

function readJson(p: string, what: string): unknown {
  try {
    return JSON.parse(readFile(p, what).toString("utf8"));
  } catch (err) {
    fail(`${what} ${p} is not valid JSON: ${(err as Error).message}`);
  }
}

function writeOut(out: string, buf: Buffer): string {
  const abs = path.resolve(out);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, abs);
  return abs;
}

function kind(file: string): "docx" | "xlsx" {
  if (/\.docx$/i.test(file)) return "docx";
  if (/\.xlsx$/i.test(file)) return "xlsx";
  fail(`${file}: only .docx and .xlsx files are supported`);
}

function list(label: string, items: string[]): string {
  return items.length ? `${label}: ${items.join(", ")}` : "";
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  try {
    await run(command, rest);
  } catch (err) {
    fail((err as Error).message);
  }
}

async function run(command: string | undefined, rest: string[]): Promise<void> {
  const { positional, flags } = args(rest);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  if (command === "inspect") {
    const file = positional[0] ?? fail("inspect needs a file");
    const buf = readFile(file, "form");
    if (kind(file) === "docx") {
      const info = await inspectDocx(buf);
      const lines = [
        `Word form: ${file}`,
        `Placeholders: ${info.placeholders.length ? info.placeholders.map((p) => `{{${p}}}`).join(", ") : "none (content is added at the end)"}`,
        info.placeholders.includes("content") ? "The Markdown draft (--content) replaces the {{content}} paragraph." : "",
        info.fields.length ? `Front-page fields (fill with --vars, key = text inside < >): ${info.fields.map((f) => `<${f}>`).join(", ")}` : "",
        ...info.frontTables.map((h) => `Front-page table: ${h.join(" | ")}  (rows: --vars {"row:${h[0] ?? ""}": [["…", "…"]]})`),
        info.headings.length ? `Body headings (with --style the body is replaced by your draft; if the form numbers its headings, numbers you type are dropped):\n${info.headings.map((h) => `  ${"  ".repeat(h.level - 1)}${h.text}`).join("\n")}` : "",
        `Styles: ${info.styles.join(", ")}`,
        `Tables: ${info.tables}`,
        "",
        "Text of the form:",
        ...info.outline.map((o) => `  [${o.style ?? "normal"}] ${o.text}`),
      ];
      process.stdout.write(lines.filter((l) => l !== "").join("\n") + "\n");
    } else {
      const info = await inspectXlsx(buf);
      const lines = [`Excel form: ${file}`];
      for (const s of info.sheets) {
        lines.push("", `Sheet "${s.name}" (${s.rows} rows × ${s.columns} columns${s.range ? `, ${s.range}` : ""})`);
        if (s.placeholders.length) lines.push(`  Placeholders: ${s.placeholders.map((p) => `{{${p}}}`).join(", ")}`);
        if (s.header) lines.push(`  Header row ${s.header.row}: ${s.header.cells.map((c) => `${c.address}=${c.text}`).join(", ")}`);
        if (s.firstEmptyRow) lines.push(`  Rows usually start at row ${s.firstEmptyRow} (first empty row under the header)`);
        if (s.merges.length) lines.push(`  Merged: ${s.merges.join(", ")}`);
        if (s.sample.length) lines.push("  Cells:", ...s.sample.map((c) => `    ${c}`));
      }
      process.stdout.write(lines.join("\n") + "\n");
    }
    return;
  }

  if (command === "read") {
    const file = positional[0] ?? fail("read needs a file");
    const buf = readFile(file, "document");
    process.stdout.write(kind(file) === "docx" ? await readDocx(buf) : await readXlsx(buf));
    return;
  }

  if (command === "docx") {
    const out = flags.out ?? fail("docx needs --out <file.docx>");
    if (kind(out) !== "docx") fail("--out must end in .docx");
    if (flags.style && flags.template) fail("use --style (new document in the form's look) or --template (fill the form), not both");
    const template = flags.style ? readFile(flags.style, "form") : flags.template ? readFile(flags.template, "template") : null;
    const markdown = flags.content ? readFile(flags.content, "content").toString("utf8") : null;
    const rawVars = flags.vars ? readJson(flags.vars, "vars") : {};
    if (!rawVars || typeof rawVars !== "object" || Array.isArray(rawVars)) fail("--vars must be a JSON object");
    const vars = Object.fromEntries(Object.entries(rawVars as Record<string, unknown>).map(([k, v]) => [k,
      Array.isArray(v) ? v as Array<string | number | null> : v === null || v === undefined ? "" : String(v)]));
    const { buffer, report } = await buildDocx({ template, markdown, vars, mode: flags.style ? "style" : "fill" });
    if (report.changes === 0) {
      fail("nothing was written: the output would be the form unchanged. Pass --content <draft.md> with the document's text"
        + (flags.template ? ", or use --style <form.docx> to write a new document in the form's look" : ""));
    }
    const abs = writeOut(out, buffer);
    process.stdout.write([
      `Wrote ${abs}`,
      report.content === "body" ? (report.frontMatter ? "Kept the form's front pages (cover, change log, sign-off, table of contents); the body is your draft. Word refreshes the table of contents when the file opens." : "New body written in the form's look.") : report.content === "placeholder" ? "Content placed at {{content}}." : report.content === "appended" ? "Content added at the end of the form (the form's own text is still above it; use --style for a new document)." : "",
      list("Filled", report.filled.map((k) => (k.startsWith("<") || k.startsWith("row:") ? k : `{{${k}}}`))),
      list("Still empty (no value given)", report.missing.map((k) => (k.startsWith("<") || k.startsWith("row:") ? k : `{{${k}}}`))),
      list("Not in the form (ignored)", report.unused),
    ].filter(Boolean).join("\n") + "\n");
    return;
  }

  if (command === "xlsx") {
    const out = flags.out ?? fail("xlsx needs --out <file.xlsx>");
    if (kind(out) !== "xlsx") fail("--out must end in .xlsx");
    if (flags.style && flags.template) fail("use --style (new workbook in the form's look) or --template (fill the form), not both");
    const template = flags.template ? readFile(flags.template, "template") : null;
    const style = flags.style ? readFile(flags.style, "form") : null;
    const data = flags.data ? readJson(flags.data, "data") : {};
    if (!data || typeof data !== "object" || Array.isArray(data)) fail("--data must be a JSON object");
    const { buffer, report } = await buildXlsx({ template, style, data: data as XlsxData });
    if (report.rowsWritten === 0 && report.filled.length === 0 && Object.keys((data as XlsxData).cells ?? {}).length === 0) {
      fail("nothing was written: add \"sheets\" (or \"tables\"/\"cells\") with the workbook's data to --data");
    }
    const abs = writeOut(out, buffer);
    process.stdout.write([
      `Wrote ${abs} (sheets: ${report.sheets.join(", ")}; ${report.rowsWritten} rows)`,
      list("Filled", report.filled.map((k) => `{{${k}}}`)),
      list("Still empty (no value given)", report.missing.map((k) => `{{${k}}}`)),
      list("Not in the form (ignored)", report.unused),
      ...report.warnings,
    ].filter(Boolean).join("\n") + "\n");
    return;
  }

  fail(`unknown command "${command}"\n\n${USAGE}`);
}

function isEntryPoint(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((err) => fail((err as Error).message));
}
