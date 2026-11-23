import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { buildDocx, inspectDocx, readDocx } from "../src/domain/factory-studio/office/docx.js";
import { buildXlsx, inspectXlsx, readXlsx, previewXlsx } from "../src/domain/factory-studio/office/xlsx.js";
import { parseMarkdown } from "../src/domain/factory-studio/office/markdown.js";
import { previewOffice } from "../src/domain/factory-studio/office/preview.js";
import { OfficeTemplateStore } from "../src/domain/factory-studio/office/office-templates.js";
import { generateTeamFiles } from "../src/domain/factory-studio/generator.js";
import { parseFactoryTeamInput, type FactoryTeam } from "../src/domain/factory-studio/team.js";
import { factoryRoutes } from "../src/routes/factory.js";

const SHARED_AGENT_DIR = resolve(import.meta.dirname, "..", "specs", "agents", "shared");

async function wordForm(): Promise<Buffer> {
  // A form whose placeholder is split across runs, as Word often saves it.
  const zip = await JSZip.loadAsync((await buildDocx({ markdown: "# Report {{project}}\n\nAuthor: {{author}}\n\n{{content}}\n\nSigned: ____" })).buffer);
  let xml = await zip.file("word/document.xml")!.async("string");
  xml = xml.replace("Author: {{author}}", 'Author: {{au</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">thor}}');
  zip.file("word/document.xml", xml);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function excelForm(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet("Summary");
  summary.getCell("A1").value = "Project";
  summary.getCell("B1").value = "{{project}}";
  summary.getCell("B2").value = { formula: "COUNTA('Test cases'!A5:A100)" } as ExcelJS.CellFormulaValue;
  const t = wb.addWorksheet("Test cases");
  t.mergeCells("A1:C1");
  t.getCell("A1").value = "TEST CASES – {{project}}";
  ["ID", "Description", "Result"].forEach((h, i) => { t.getRow(4).getCell(i + 1).value = h; });
  for (let c = 1; c <= 3; c++) t.getRow(5).getCell(c).border = { left: { style: "thin" }, right: { style: "thin" } };
  t.getCell("A9").value = "Approved by:";
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}

describe("markdown parser", () => {
  it("parses headings, nested lists, tables, quotes and code", () => {
    const blocks = parseMarkdown("# Title\n\nSome **bold** text.\n\n- a\n  - b\n1. one\n\n| A | B |\n|---|---|\n| 1 | x \\| y |\n\n> note\n\n```\ncode\n```\n---");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "list", "table", "quote", "code", "rule"]);
    const list = blocks[2] as Extract<typeof blocks[number], { kind: "list" }>;
    expect(list.items.map((i) => i.level)).toEqual([0, 1]);
    const table = blocks[4] as Extract<typeof blocks[number], { kind: "table" }>;
    expect(table.rows[0]![1]!.map((r) => r.text).join("")).toBe("x | y");
  });
});

describe("Word documents", () => {
  it("fills a form: split placeholders, {{content}} with the form's styles, missing values reported", async () => {
    const form = await wordForm();
    const info = await inspectDocx(form);
    expect(info.placeholders).toEqual(["author", "content", "project"]);
    expect(info.styles).toContain("heading 2");

    const { buffer, report } = await buildDocx({
      template: form,
      markdown: "## Scope\n\nBooking for a **clinic**.\n\n- Patients\n  - Cancel\n\n| ID | Result |\n|---|---|\n| TC-1 | Pass |",
      vars: { author: "Lan", extra: "x" },
    });
    expect(report.content).toBe("placeholder");
    expect(report.filled).toEqual(["author", "content"]);
    expect(report.missing).toEqual(["project"]);
    expect(report.unused).toEqual(["extra"]);

    const text = await readDocx(buffer);
    expect(text).toContain("# Report {{project}}");
    expect(text).toContain("Author: Lan");
    expect(text).toContain("## Scope");
    expect(text).toContain("- Patients\n  - Cancel");
    expect(text).toContain("| TC-1 | Pass |");
    expect(text.indexOf("## Scope")).toBeLessThan(text.indexOf("Signed: ____"));

    const xml = await (await JSZip.loadAsync(buffer)).file("word/document.xml")!.async("string");
    expect(xml).toContain('<w:pStyle w:val="Heading2"/>');
    expect(xml).not.toContain("{{content}}");
  });

  it("appends content when the form has no {{content}}, and builds without a form", async () => {
    const { buffer, report } = await buildDocx({ markdown: "# Hello\n\nWorld [link](https://example.com)" });
    expect(report.content).toBe("appended");
    expect(await readDocx(buffer)).toContain("# Hello\n\nWorld link");
    const rels = await (await JSZip.loadAsync(buffer)).file("word/_rels/document.xml.rels")!.async("string");
    expect(rels).toContain('Target="https://example.com"');
  });

  it("rejects files that aren't Word documents", async () => {
    await expect(buildDocx({ template: Buffer.from("not a zip") })).rejects.toThrow(/Not a Word file/);
  });

  it("previews as HTML", async () => {
    const { buffer } = await buildDocx({ markdown: "# Title\n\n| A |\n|---|\n| 1 |" });
    const preview = await previewOffice("x.docx", buffer);
    expect(preview.kind).toBe("docx");
    expect(preview.kind === "docx" && preview.html).toContain("<table>");
  });
});

describe("Excel workbooks", () => {
  it("fills a form: placeholders, cells, rows with the start row's style, merges and formulas kept", async () => {
    const form = await excelForm();
    const info = await inspectXlsx(form);
    const sheet = info.sheets.find((s) => s.name === "Test cases")!;
    expect(sheet.header?.row).toBe(4);
    expect(sheet.firstEmptyRow).toBe(5);
    expect(sheet.merges).toEqual(["A1:C1"]);

    const { buffer, report } = await buildXlsx({
      template: form,
      data: {
        vars: { project: "Clinic" },
        cells: { "Summary!C1": "v1", "Summary!D1": 3, "Summary!E1": "=1+1" },
        tables: [{ sheet: "Test cases", start: "A5", rows: [["TC-1", "Log in", "Pass"], ["TC-2", "Book", "Fail"]] }],
        sheets: [{ name: "Bugs", columns: ["ID", "Title"], rows: [["B-1", "Crash"]] }],
      },
    });
    expect(report.filled).toEqual(["project"]);
    expect(report.rowsWritten).toBe(3);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const t = wb.getWorksheet("Test cases")!;
    expect(t.getCell("A1").value).toBe("TEST CASES – Clinic");
    expect(t.getCell("B6").value).toBe("Book");
    expect(t.getCell("B6").border?.left?.style).toBe("thin");
    expect(t.getCell("A9").value).toBe("Approved by:");
    expect((t.model as { merges?: string[] }).merges).toContain("A1:C1");
    const s = wb.getWorksheet("Summary")!;
    expect(s.getCell("B1").value).toBe("Clinic");
    expect(s.getCell("D1").value).toBe(3);
    expect((s.getCell("E1").value as { formula?: string }).formula).toBe("1+1");
    expect((s.getCell("B2").value as { formula?: string }).formula).toContain("COUNTA");
    expect(wb.getWorksheet("Bugs")!.getCell("B2").value).toBe("Crash");

    const text = await readXlsx(buffer);
    expect(text).toContain("## Sheet: Test cases");
    expect(text).toContain("| 6 | TC-2 | Book | Fail |");
    expect(text).not.toContain("TEST CASES – Clinic | TEST CASES");

    const preview = await previewXlsx(buffer);
    expect(preview.map((p) => p.name)).toEqual(["Summary", "Test cases", "Bugs"]);
    expect(preview[2]!.rows[0]![0]).toMatchObject({ v: "ID", b: true });
  });

  it("inserts rows above existing content when asked", async () => {
    const { buffer } = await buildXlsx({
      template: await excelForm(),
      data: { tables: [{ sheet: "Test cases", start: "A5", insert: true, rows: [["1"], ["2"], ["3"], ["4"], ["5"], ["6"]] }] },
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    expect(wb.getWorksheet("Test cases")!.getCell("A14").value).toBe("Approved by:");
  });
});

describe("form library", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "office-forms-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("stores Word/Excel forms and refuses anything else", async () => {
    const store = new OfficeTemplateStore(tmp);
    const meta = await store.save("Mẫu báo cáo.docx", await wordForm());
    expect(meta).toMatchObject({ format: "docx", name: "Mẫu báo cáo.docx" });
    expect(meta.id).toMatch(/^mau-bao-cao-[0-9a-f]{6}$/);
    expect(store.list().map((t) => t.id)).toEqual([meta.id]);
    expect(readFileSync(store.filePath(meta.id)!).length).toBe(meta.size);

    await expect(store.save("x.pdf", Buffer.from("%PDF"))).rejects.toThrow(/\.docx/);
    await expect(store.save("fake.xlsx", await wordForm())).rejects.toThrow(/valid Excel/);
    await expect(store.save("broken.docx", Buffer.from("hello"))).rejects.toThrow(/valid Word/);
    store.remove(meta.id);
    expect(store.list()).toEqual([]);
  });
});

describe("agents get office instructions", () => {
  const team = (template?: string): FactoryTeam => ({
    name: "office-team",
    title: "Office Team",
    summary: "",
    workflow: "sequential",
    createdAt: "",
    updatedAt: "",
    members: [
      {
        id: "qa", title: "QA", role: "qa", runtime: "claude-code", instructions: "", skills: [], customSkills: [],
        deliverables: [{ id: "cases", title: "Test cases", path: "docs/test-cases.xlsx", outline: "Sheet Test cases", acceptance: "", ...(template ? { template } : {}) }],
      },
      { id: "dev", title: "Dev", role: "dev", runtime: "claude-code", instructions: "", skills: [], customSkills: [], deliverables: [{ id: "notes", title: "Notes", path: "docs/notes.md", outline: "", acceptance: "" }] },
    ],
  });
  const base = { sharedAgentDir: SHARED_AGENT_DIR, sharedSkillIds: new Set<string>(), resolveSkill: () => null };
  const office = {
    command: "rig office",
    resolveTemplate: (id: string) => (id === "cases-form-abc123" ? { path: "/forms/cases.xlsx", format: "xlsx" as const, name: "Cases.xlsx" } : null),
  };

  it("names the form, the draft and the exact rig office commands, and adds the office-docs skill to every member", () => {
    const { files, errors } = generateTeamFiles(team("cases-form-abc123"), { ...base, office });
    expect(errors).toEqual([]);
    const guide = (files.get("agents/qa/guidance/deliverables.md") as { content: string }).content;
    expect(guide).toContain("Excel (.xlsx)");
    expect(guide).toContain("Cases.xlsx at `/forms/cases.xlsx`");
    expect(guide).toContain("rig office inspect '/forms/cases.xlsx'");
    expect(guide).toContain("rig office xlsx --template '/forms/cases.xlsx' --data .factory/drafts/qa/cases.json --out 'docs/test-cases.xlsx'");
    expect(guide).toContain("What goes in the workbook:");
    expect(files.has("agents/qa/skills/office-docs/SKILL.md")).toBe(true);
    expect(files.has("agents/dev/skills/office-docs/SKILL.md")).toBe(true);
    expect((files.get("CULTURE.md") as { content: string }).content).toContain("rig office read <path>");
    expect((files.get("agents/dev/agent.yaml") as { content: string }).content).toContain("office-docs");
  });

  it("reports a deleted form instead of generating", () => {
    const { errors } = generateTeamFiles(team("gone-form-000000"), { ...base, office });
    expect(errors.join("\n")).toMatch(/no longer exists/);
  });

  it("validates the form field", () => {
    const input = (path: string, template: string) => ({
      name: "t", title: "T", workflow: "sequential",
      members: [{ id: "a", title: "A", deliverables: [{ id: "d", title: "D", path, template }] }],
    });
    expect(parseFactoryTeamInput(input("docs/a.md", "form-abc123")).ok).toBe(false);
    const ok = parseFactoryTeamInput(input("docs/a.docx", "form-abc123"));
    expect(ok.ok && ok.team.members[0]!.deliverables[0]!.template).toBe("form-abc123");
  });
});

describe("form routes", () => {
  let tmp: string;
  let app: Hono;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "office-routes-"));
    app = new Hono();
    app.route("/api/factory", factoryRoutes({ teamsRoot: () => join(tmp, "teams"), sharedAgentDir: SHARED_AGENT_DIR, officeTemplatesDir: join(tmp, "forms"), agentApiHome: tmp }));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("uploads, lists, inspects, downloads and deletes a form", async () => {
    const body = await excelForm();
    const up = await app.request("/api/factory/office-templates", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("Test cases.xlsx") },
      body,
    });
    expect(up.status).toBe(201);
    const meta = await up.json() as { id: string; format: string };
    expect(meta.format).toBe("xlsx");

    const list = await (await app.request("/api/factory/office-templates")).json() as Array<{ id: string }>;
    expect(list.map((t) => t.id)).toEqual([meta.id]);

    const inspect = await (await app.request(`/api/factory/office-templates/${meta.id}/inspect`)).json() as { xlsx: { sheets: Array<{ name: string }> } };
    expect(inspect.xlsx.sheets.map((s) => s.name)).toEqual(["Summary", "Test cases"]);

    const file = await app.request(`/api/factory/office-templates/${meta.id}`);
    expect(file.headers.get("content-type")).toContain("spreadsheetml");
    expect(Buffer.from(await file.arrayBuffer()).equals(body)).toBe(true);

    const bad = await app.request("/api/factory/office-templates", { method: "POST", headers: { "x-file-name": "x.txt" }, body: "hi" });
    expect(bad.status).toBe(400);

    expect((await app.request(`/api/factory/office-templates/${meta.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/api/factory/office-templates/${meta.id}/inspect`)).status).toBe(404);
  });

  it("saves a team whose document follows an uploaded form", async () => {
    const up = await app.request("/api/factory/office-templates", { method: "POST", headers: { "x-file-name": "form.docx" }, body: await wordForm() });
    const { id } = await up.json() as { id: string };
    const save = await app.request("/api/factory/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "word-team", title: "Word Team", workflow: "sequential",
        members: [{ id: "writer", title: "Writer", instructions: "", skills: [], customSkills: [], deliverables: [{ id: "report", title: "Report", path: "docs/report.docx", outline: "", acceptance: "", template: id }] }],
      }),
    });
    expect(save.status).toBe(201);
    const guide = readFileSync(join(tmp, "teams", "word-team", "agents", "writer", "guidance", "deliverables.md"), "utf8");
    expect(guide).toContain(`rig office docx --template '${join(tmp, "forms", `${id}.docx`)}'`);

    const del = await app.request(`/api/factory/office-templates/${id}`, { method: "DELETE" });
    expect(del.status).toBe(409);
  });
});
