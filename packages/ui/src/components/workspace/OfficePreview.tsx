// Agent Workspace — review a Word or Excel document in the browser.
import { useMemo, useState } from "react";
import type { OfficePreview as Preview, XlsxPreviewSheet } from "../../hooks/useWorkspaceRuns.js";

// The Word HTML comes from the agent's file: render it in a frame that can run nothing and load
// nothing but inline images.
const FRAME_HEAD = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
  html { background: #eef0f3; }
  body { margin: 24px auto; max-width: 794px; min-height: 900px; background: #fff; color: #1f2328; padding: 64px 72px; box-sizing: border-box;
         box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.06); font: 11pt/1.5 Calibri, "Segoe UI", Arial, sans-serif; }
  h1 { font-size: 20pt; color: #1F3864; margin: 0 0 12pt; } h2 { font-size: 15pt; color: #2F5496; margin: 18pt 0 6pt; }
  h3 { font-size: 12.5pt; color: #2F5496; margin: 14pt 0 6pt; } h4, h5, h6 { font-size: 11pt; margin: 12pt 0 4pt; }
  p { margin: 0 0 6pt; } ul, ol { margin: 0 0 6pt; padding-left: 24pt; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; } td, th { border: 1px solid #a6a6a6; padding: 4px 7px; vertical-align: top; }
  th { background: #dce6f2; font-weight: 600; text-align: left; } img { max-width: 100%; } a { color: #0563C1; }
</style>`;

function WordPreview({ html }: { html: string }) {
  return (
    <iframe
      title="Word document preview"
      data-testid="workspace-docx-preview"
      sandbox=""
      srcDoc={`<!doctype html><html><head>${FRAME_HEAD}</head><body>${html || "<p><i>The document is empty.</i></p>"}</body></html>`}
      className="block h-[640px] w-full rounded-[12px] border border-[color:var(--fx-border)] bg-[#eef0f3]"
    />
  );
}

function colName(n: number): string {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function decode(address: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(address.replace(/\$/g, ""));
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), col };
}

function Sheet({ sheet }: { sheet: XlsxPreviewSheet }) {
  const { spans, covered } = useMemo(() => {
    const spans = new Map<string, { rowSpan: number; colSpan: number }>();
    const covered = new Set<string>();
    for (const range of sheet.merges) {
      const [a, b] = range.split(":");
      const from = a ? decode(a) : null;
      const to = b ? decode(b) : null;
      if (!from || !to) continue;
      spans.set(`${from.row}:${from.col}`, { rowSpan: to.row - from.row + 1, colSpan: to.col - from.col + 1 });
      for (let r = from.row; r <= to.row; r++) for (let c = from.col; c <= to.col; c++) if (r !== from.row || c !== from.col) covered.add(`${r}:${c}`);
    }
    return { spans, covered };
  }, [sheet.merges]);

  const cols = Math.max(sheet.widths.length, ...sheet.rows.map((r) => r.length), 1);
  if (sheet.rows.length === 0) return <p className="fx-small p-4">This sheet is empty.</p>;
  return (
    <div className="max-h-[600px] overflow-auto rounded-[10px] border border-[color:var(--fx-border)] bg-white">
      <table className="border-collapse text-[12.5px] text-[#1f2328]" style={{ tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: 44 }} />
          {Array.from({ length: cols }, (_, i) => <col key={i} style={{ width: Math.min(420, Math.max(56, sheet.widths[i] ?? 72)) }} />)}
        </colgroup>
        <thead>
          <tr>
            <th className="sticky top-0 z-10 border border-[#d0d7de] bg-[#f3f4f6] px-1 text-[11px] font-medium text-[#57606a]" />
            {Array.from({ length: cols }, (_, i) => (
              <th key={i} className="sticky top-0 z-10 border border-[#d0d7de] bg-[#f3f4f6] px-1 text-[11px] font-medium text-[#57606a]">{colName(i + 1)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, r) => (
            <tr key={r}>
              <td className="border border-[#d0d7de] bg-[#f3f4f6] px-1 text-center text-[11px] text-[#57606a]">{r + 1}</td>
              {Array.from({ length: cols }, (_, c) => {
                const key = `${r + 1}:${c + 1}`;
                if (covered.has(key)) return null;
                const cell = row[c] ?? null;
                const span = spans.get(key);
                return (
                  <td
                    key={c}
                    rowSpan={span?.rowSpan}
                    colSpan={span?.colSpan}
                    className="whitespace-pre-wrap break-words border border-[#e1e4e8] px-1.5 py-1 align-top"
                    style={{
                      background: cell?.bg,
                      fontWeight: cell?.b ? 600 : undefined,
                      textAlign: (cell?.al === "center" || cell?.al === "right" ? cell.al : undefined) as "center" | "right" | undefined,
                    }}
                  >
                    {cell?.v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExcelPreview({ sheets }: { sheets: XlsxPreviewSheet[] }) {
  const [active, setActive] = useState(0);
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  if (!sheet) return <p className="fx-small">The workbook has no sheets.</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="workspace-xlsx-preview">
      {sheets.length > 1 ? (
        <div className="fx-segment self-start" role="tablist" aria-label="Sheets">
          {sheets.map((s, i) => (
            <button key={s.name} type="button" role="tab" aria-pressed={i === active} aria-selected={i === active} onClick={() => setActive(i)}>{s.name}</button>
          ))}
        </div>
      ) : <span className="fx-tiny">Sheet: {sheet.name}</span>}
      <Sheet sheet={sheet} />
      {sheet.truncated ? <p className="fx-tiny">Only the first 500 rows and 40 columns are shown. Download the file to see everything.</p> : null}
    </div>
  );
}

export function OfficePreview({ preview }: { preview: Preview }) {
  return preview.kind === "docx" ? <WordPreview html={preview.html} /> : <ExcelPreview sheets={preview.sheets} />;
}
