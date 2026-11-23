// Excel (.xlsx) support for the office tool.
//
//   buildXlsx    copy a template (or start an empty workbook), fill {{placeholders}}, single
//                cells and table rows, keeping the template's styles, merges and formulas.
//   inspectXlsx  what a template looks like: sheets, headers, placeholders, where rows go.
//   readXlsx     a workbook as Markdown tables, so an agent can read a teammate's file.
//   previewXlsx  cell values plus a little styling, for the Workspace preview.

import ExcelJS from "exceljs";

export type CellInput = string | number | boolean | null;

export interface XlsxData {
  /** Values for {{placeholders}} written in template cells. */
  vars?: Record<string, CellInput>;
  /** Single cells: "Sheet name!B2" or "B2" (first sheet). A string starting with "=" is a formula. */
  cells?: Record<string, CellInput>;
  /** Rows written from a start cell down. Each new row copies the style of the start row. */
  tables?: Array<{
    sheet?: string;
    start: string;
    /** Written on the start row; data rows follow below it. */
    header?: string[];
    rows: CellInput[][];
    /** Insert the rows (pushing what's below down) instead of writing over the cells below. */
    insert?: boolean;
  }>;
  /** Whole sheets, created when missing: a styled header row, then the rows. */
  sheets?: Array<{ name: string; columns?: string[]; rows?: CellInput[][]; widths?: number[] }>;
}

export interface XlsxBuildReport {
  sheets: string[];
  filled: string[];
  missing: string[];
  unused: string[];
  rowsWritten: number;
  warnings: string[];
}

export interface XlsxSheetInspection {
  name: string;
  range: string | null;
  rows: number;
  columns: number;
  merges: string[];
  placeholders: string[];
  /** Best guess at the header row: the first row with two or more text cells. */
  header: { row: number; cells: Array<{ address: string; text: string }> } | null;
  /** First empty row under the header: where table rows usually start. */
  firstEmptyRow: number | null;
  /** The first non-empty cells, "B3: text". */
  sample: string[];
}

export interface XlsxPreviewSheet {
  name: string;
  rows: Array<Array<{ v: string; b?: boolean; bg?: string; al?: string } | null>>;
  merges: string[];
  widths: number[];
  truncated: boolean;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

async function openXlsx(buf: Buffer | null): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  if (!buf) return wb;
  try {
    await wb.xlsx.load(buf as never);
  } catch {
    throw new Error("Not an Excel file (.xlsx). Old .xls files must be saved as .xlsx first.");
  }
  return wb;
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as { formula?: string; sharedFormula?: string; result?: unknown; richText?: Array<{ text: string }>; text?: string; hyperlink?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.formula !== undefined || o.sharedFormula !== undefined) {
      if (o.result !== undefined && o.result !== null && typeof o.result !== "object") return String(o.result);
      return `=${o.formula ?? o.sharedFormula}`;
    }
    if (o.text !== undefined) return String(o.text);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  try { return cell.text ?? String(v); } catch { return String(v); }
}

/** A cell covered by a merge (not its top-left cell) repeats the merge's value: skip it. */
function covered(cell: ExcelJS.Cell): boolean {
  return cell.isMerged && cell.master !== undefined && cell.master.address !== cell.address;
}

function toValue(input: CellInput): ExcelJS.CellValue {
  if (input === null || input === undefined) return null;
  if (typeof input === "string" && input.startsWith("=") && input.length > 1) return { formula: input.slice(1) } as ExcelJS.CellFormulaValue;
  return input;
}

function sheetFor(wb: ExcelJS.Workbook, name: string | undefined, warnings: string[]): ExcelJS.Worksheet {
  if (name) {
    const ws = wb.getWorksheet(name);
    if (ws) return ws;
    warnings.push(`Sheet "${name}" didn't exist, so it was created.`);
    return wb.addWorksheet(name.slice(0, 31));
  }
  return wb.worksheets[0] ?? wb.addWorksheet("Sheet1");
}

function splitAddress(ref: string): { sheet?: string; address: string } {
  const bang = ref.lastIndexOf("!");
  if (bang < 0) return { address: ref.trim().toUpperCase() };
  return { sheet: ref.slice(0, bang).replace(/^'(.*)'$/, "$1"), address: ref.slice(bang + 1).trim().toUpperCase() };
}

const ADDRESS = /^([A-Z]{1,3})(\d{1,7})$/;

function decode(address: string): { col: number; row: number } {
  const m = ADDRESS.exec(address);
  if (!m) throw new Error(`"${address}" is not a cell address like B2`);
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

function cloneStyle(style: Partial<ExcelJS.Style>): Partial<ExcelJS.Style> {
  return JSON.parse(JSON.stringify(style ?? {})) as Partial<ExcelJS.Style>;
}

export async function buildXlsx(input: { template?: Buffer | null; data: XlsxData }): Promise<{ buffer: Buffer; report: XlsxBuildReport }> {
  const wb = await openXlsx(input.template ?? null);
  const data = input.data ?? {};
  const warnings: string[] = [];
  const vars = data.vars ?? {};
  const seen = new Set<string>();
  const filled = new Set<string>();
  const missing = new Set<string>();
  let rowsWritten = 0;

  // Whole sheets first, so cells and tables can target them.
  for (const s of data.sheets ?? []) {
    const name = String(s.name ?? "").slice(0, 31) || `Sheet${wb.worksheets.length + 1}`;
    const ws = wb.getWorksheet(name) ?? wb.addWorksheet(name);
    let r = 1;
    if (s.columns?.length) {
      const row = ws.getRow(1);
      s.columns.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        cell.value = c;
        cell.font = { bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F2" } };
        cell.border = { bottom: { style: "thin", color: { argb: "FF8EA9DB" } } };
        cell.alignment = { vertical: "middle", wrapText: true };
      });
      ws.views = [{ state: "frozen", ySplit: 1 }];
      r = 2;
    }
    for (const values of s.rows ?? []) {
      const row = ws.getRow(r++);
      values.forEach((v, i) => {
        const cell = row.getCell(i + 1);
        cell.value = toValue(v);
        cell.alignment = { vertical: "top", wrapText: true };
      });
      rowsWritten++;
    }
    const cols = Math.max(s.columns?.length ?? 0, ...(s.rows ?? []).map((x) => x.length));
    for (let c = 1; c <= cols; c++) {
      const given = s.widths?.[c - 1];
      if (given) { ws.getColumn(c).width = given; continue; }
      let longest = String(s.columns?.[c - 1] ?? "").length;
      for (const values of s.rows ?? []) longest = Math.max(longest, ...String(values[c - 1] ?? "").split("\n").map((l) => l.length));
      ws.getColumn(c).width = Math.min(60, Math.max(10, longest + 2));
    }
    if (s.columns?.length && (s.rows?.length ?? 0) > 0) {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.columns.length } };
    }
  }

  // {{placeholders}} anywhere in the workbook.
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (covered(cell) || typeof cell.value !== "string" || !cell.value.includes("{{")) return;
        const text = cell.value;
        const keys = [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
        keys.forEach((k) => seen.add(k));
        const only = /^\s*\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}\s*$/.exec(text)?.[1];
        if (only && vars[only] !== undefined) {
          cell.value = toValue(vars[only]!);
          filled.add(only);
          return;
        }
        cell.value = text.replace(PLACEHOLDER, (whole, key: string) => {
          if (vars[key] === undefined || vars[key] === null) { missing.add(key); return whole; }
          filled.add(key);
          return String(vars[key]);
        });
      });
    });
  }

  for (const [ref, value] of Object.entries(data.cells ?? {})) {
    const { sheet, address } = splitAddress(ref);
    decode(address);
    sheetFor(wb, sheet, warnings).getCell(address).value = toValue(value);
  }

  for (const t of data.tables ?? []) {
    const ws = sheetFor(wb, t.sheet, warnings);
    const start = decode(String(t.start ?? "A1").toUpperCase());
    let r = start.row;
    if (t.header?.length) {
      t.header.forEach((h, i) => { ws.getCell(r, start.col + i).value = h; });
      r++;
    }
    const rows = t.rows ?? [];
    const width = Math.max(t.header?.length ?? 0, ...rows.map((x) => x.length), 1);
    // The template's first data row is the style every written row copies.
    const styleRow = ws.getRow(r);
    const styles = Array.from({ length: width }, (_, i) => cloneStyle(styleRow.getCell(start.col + i).style));
    const height = styleRow.height;
    if (t.insert && rows.length > 1) ws.spliceRows(r + 1, 0, ...Array.from({ length: rows.length - 1 }, () => [] as ExcelJS.CellValue[]));
    rows.forEach((values, i) => {
      const row = ws.getRow(r + i);
      if (height && i > 0) row.height = height;
      for (let c = 0; c < width; c++) {
        const cell = row.getCell(start.col + c);
        if (i > 0 || t.insert) cell.style = cloneStyle(styles[c]!);
        cell.value = toValue(values[c] ?? null);
      }
      rowsWritten++;
    });
  }

  for (const k of filled) missing.delete(k);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
  return {
    buffer,
    report: {
      sheets: wb.worksheets.map((w) => w.name),
      filled: [...filled].sort(),
      missing: [...missing].sort(),
      unused: Object.keys(vars).filter((k) => !seen.has(k)).sort(),
      rowsWritten,
      warnings,
    },
  };
}

export async function inspectXlsx(buf: Buffer): Promise<{ sheets: XlsxSheetInspection[] }> {
  const wb = await openXlsx(buf);
  return {
    sheets: wb.worksheets.map((ws) => {
      const placeholders = new Set<string>();
      const sample: string[] = [];
      let header: XlsxSheetInspection["header"] = null;
      let lastRow = 0;
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const texts: Array<{ address: string; text: string }> = [];
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (covered(cell)) return;
          const text = cellText(cell);
          if (!text.trim()) return;
          lastRow = rowNumber;
          for (const m of text.matchAll(PLACEHOLDER)) placeholders.add(m[1]!);
          if (sample.length < 60) sample.push(`${cell.address}: ${text.replace(/\s+/g, " ").slice(0, 80)}`);
          if (typeof cell.value === "string" || (cell.value as { richText?: unknown })?.richText) texts.push({ address: cell.address, text: text.trim() });
        });
        if (texts.length >= 3 && (!header || header.cells.length < 3)) header = { row: rowNumber, cells: texts.slice(0, 40) };
        else if (!header && texts.length >= 2) header = { row: rowNumber, cells: texts.slice(0, 40) };
      });
      const h = header as XlsxSheetInspection["header"];
      let firstEmptyRow: number | null = null;
      if (h) {
        for (let r = h.row + 1; r <= Math.max(lastRow + 1, h.row + 1); r++) {
          const row = ws.getRow(r);
          let empty = true;
          row.eachCell({ includeEmpty: false }, (cell) => { if (cellText(cell).trim()) empty = false; });
          if (empty) { firstEmptyRow = r; break; }
        }
      }
      const merges = ((ws.model as { merges?: string[] }).merges ?? []).slice(0, 50);
      return {
        name: ws.name,
        range: ws.dimensions && ws.actualRowCount ? (ws.dimensions as unknown as { range?: string }).range ?? null : null,
        rows: ws.actualRowCount,
        columns: ws.actualColumnCount,
        merges,
        placeholders: [...placeholders].sort(),
        header: h,
        firstEmptyRow,
        sample,
      };
    }),
  };
}

export async function readXlsx(buf: Buffer, opts: { maxRows?: number; maxCols?: number } = {}): Promise<string> {
  const wb = await openXlsx(buf);
  const maxRows = opts.maxRows ?? 300;
  const maxCols = opts.maxCols ?? 30;
  const out: string[] = [];
  for (const ws of wb.worksheets) {
    out.push(`## Sheet: ${ws.name}`);
    const rows: string[][] = [];
    let cols = 0;
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (rows.length >= maxRows) return;
      const values: string[] = [`${n}`];
      for (let c = 1; c <= Math.min(maxCols, ws.columnCount); c++) {
        const cell = row.getCell(c);
        values.push((covered(cell) ? "" : cellText(cell)).replace(/\r?\n/g, " ").replace(/\|/g, "\\|"));
      }
      while (values.length > 1 && values[values.length - 1] === "") values.pop();
      cols = Math.max(cols, values.length);
      rows.push(values);
    });
    if (rows.length === 0) { out.push("(empty)"); continue; }
    const letters = (n: number) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
    const head = ["row", ...Array.from({ length: cols - 1 }, (_, i) => letters(i + 1))];
    const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? "").join(" | ")} |`;
    out.push([line(head), `|${" --- |".repeat(cols)}`, ...rows.map(line)].join("\n"));
    if (ws.actualRowCount > maxRows) out.push(`(${ws.actualRowCount - maxRows} more rows not shown)`);
  }
  return out.join("\n\n") + "\n";
}

export async function previewXlsx(buf: Buffer, opts: { maxRows?: number; maxCols?: number } = {}): Promise<XlsxPreviewSheet[]> {
  const wb = await openXlsx(buf);
  const maxRows = opts.maxRows ?? 500;
  const maxCols = opts.maxCols ?? 40;
  return wb.worksheets.map((ws) => {
    const lastRow = Math.min(ws.rowCount, maxRows);
    const lastCol = Math.min(ws.columnCount, maxCols);
    const rows: XlsxPreviewSheet["rows"] = [];
    for (let r = 1; r <= lastRow; r++) {
      const row = ws.getRow(r);
      const cells: XlsxPreviewSheet["rows"][number] = [];
      for (let c = 1; c <= lastCol; c++) {
        const cell = row.getCell(c);
        const v = covered(cell) ? "" : cellText(cell);
        const fill = cell.fill as { fgColor?: { argb?: string } } | undefined;
        const argb = fill?.fgColor?.argb;
        const entry: { v: string; b?: boolean; bg?: string; al?: string } = { v };
        if (cell.font?.bold) entry.b = true;
        if (argb && /^[0-9A-F]{8}$/i.test(argb) && argb.slice(2).toUpperCase() !== "FFFFFF") entry.bg = `#${argb.slice(2)}`;
        if (cell.alignment?.horizontal) entry.al = cell.alignment.horizontal;
        cells.push(v || entry.bg || entry.b ? entry : null);
      }
      rows.push(cells);
    }
    const widths = Array.from({ length: lastCol }, (_, i) => Math.round((ws.getColumn(i + 1).width ?? 10) * 7));
    return {
      name: ws.name,
      rows,
      merges: ((ws.model as { merges?: string[] }).merges ?? []).slice(0, 500),
      widths,
      truncated: ws.rowCount > maxRows || ws.columnCount > maxCols,
    };
  });
}
