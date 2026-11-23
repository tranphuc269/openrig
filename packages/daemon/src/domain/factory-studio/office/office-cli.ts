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

  inspect <form.docx|form.xlsx>
      Show what a form contains: its {{placeholders}}, styles, sheets and header rows.

  docx --out <file.docx> [--template <form.docx>] [--content <draft.md>] [--vars <vars.json>]
      Build a Word document. The Markdown draft is laid out with the form's own styles
      (headings, lists, tables). It replaces a paragraph holding only {{content}}, or is
      added at the end. vars.json fills other {{placeholders}}: {"project": "Clinic booking"}.

  xlsx --out <file.xlsx> [--template <form.xlsx>] --data <data.json>
      Build an Excel workbook from the form. data.json:
        { "vars":   { "project": "Clinic" },                 // {{placeholders}} in cells
          "cells":  { "Summary!B2": "v1.0", "B3": 42 },      // single cells; "=SUM(A1:A3)" is a formula
          "tables": [ { "sheet": "Test cases", "start": "A5", "rows": [["TC-01", "Login", "Pass"]] } ],
          "sheets": [ { "name": "Bugs", "columns": ["ID", "Title"], "rows": [["B-1", "Crash"]] } ] }
      Table rows copy the style of the start row. Add "insert": true to push rows below down.

  read <file.docx|file.xlsx>
      Print a document as Markdown, to read a teammate's Word or Excel file.
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
    const template = flags.template ? readFile(flags.template, "template") : null;
    const markdown = flags.content ? readFile(flags.content, "content").toString("utf8") : null;
    const rawVars = flags.vars ? readJson(flags.vars, "vars") : {};
    if (!rawVars || typeof rawVars !== "object" || Array.isArray(rawVars)) fail("--vars must be a JSON object");
    const vars = Object.fromEntries(Object.entries(rawVars as Record<string, unknown>).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)]));
    const { buffer, report } = await buildDocx({ template, markdown, vars });
    const abs = writeOut(out, buffer);
    process.stdout.write([
      `Wrote ${abs}`,
      report.content === "placeholder" ? "Content placed at {{content}}." : report.content === "appended" ? "Content added at the end of the document." : "",
      list("Filled", report.filled.map((k) => `{{${k}}}`)),
      list("Still empty (no value given)", report.missing.map((k) => `{{${k}}}`)),
      list("Not in the form (ignored)", report.unused),
    ].filter(Boolean).join("\n") + "\n");
    return;
  }

  if (command === "xlsx") {
    const out = flags.out ?? fail("xlsx needs --out <file.xlsx>");
    if (kind(out) !== "xlsx") fail("--out must end in .xlsx");
    const template = flags.template ? readFile(flags.template, "template") : null;
    const data = flags.data ? readJson(flags.data, "data") : {};
    if (!data || typeof data !== "object" || Array.isArray(data)) fail("--data must be a JSON object");
    const { buffer, report } = await buildXlsx({ template, data: data as XlsxData });
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
