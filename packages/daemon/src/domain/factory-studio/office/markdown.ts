// A small Markdown block parser for the office tool: enough to turn an agent's draft into a
// Word document (headings, paragraphs, lists, tables, quotes, code, rules) with inline
// bold / italic / code / links. It is deliberately forgiving: anything it does not
// recognise becomes a paragraph.

export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

export type Block =
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Array<{ level: number; inlines: Inline[] }> }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "code"; lines: string[] }
  | { kind: "rule" }
  | { kind: "pagebreak" };

/** Splits inline Markdown into styled runs. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const push = (text: string, style: Omit<Inline, "text"> = {}) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && !last.bold === !style.bold && !last.italic === !style.italic && !last.code === !style.code && last.link === style.link) {
      last.text += text;
    } else {
      out.push({ text, ...style });
    }
  };
  const walk = (s: string, style: Omit<Inline, "text">) => {
    let i = 0;
    let buf = "";
    const flush = () => { push(buf, style); buf = ""; };
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "\\" && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!|~]/.test(s[i + 1]!)) {
        buf += s[i + 1];
        i += 2;
        continue;
      }
      if (ch === "`") {
        const end = s.indexOf("`", i + 1);
        if (end > i) {
          flush();
          push(s.slice(i + 1, end), { ...style, code: true });
          i = end + 1;
          continue;
        }
      }
      if (ch === "[") {
        const m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(s.slice(i));
        if (m) {
          flush();
          walk(m[1]!, { ...style, link: m[2] });
          i += m[0].length;
          continue;
        }
      }
      if ((ch === "*" || ch === "_") && s[i + 1] === ch) {
        const end = s.indexOf(ch + ch, i + 2);
        if (end > i + 2) {
          flush();
          walk(s.slice(i + 2, end), { ...style, bold: true });
          i = end + 2;
          continue;
        }
      }
      if ((ch === "*" || ch === "_") && s[i + 1] !== " " && s[i + 1] !== undefined) {
        // `_` inside a word (snake_case) is not emphasis.
        const wordBefore = ch === "_" && i > 0 && /\w/.test(s[i - 1]!);
        const end = s.indexOf(ch, i + 1);
        if (!wordBefore && end > i + 1 && s[end - 1] !== " " && !(ch === "_" && /\w/.test(s[end + 1] ?? ""))) {
          flush();
          walk(s.slice(i + 1, end), { ...style, italic: true });
          i = end + 1;
          continue;
        }
      }
      if (ch === "~" && s[i + 1] === "~") {
        const end = s.indexOf("~~", i + 2);
        if (end > i + 2) { flush(); walk(s.slice(i + 2, end), style); i = end + 2; continue; }
      }
      if (ch === "<") {
        const br = /^<br\s*\/?>/i.exec(s.slice(i));
        if (br) { buf += "\n"; i += br[0].length; continue; }
      }
      buf += ch;
      i++;
    }
    flush();
  };
  walk(src, {});
  return out;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "paragraph", inlines: parseInline(para.join(" ")) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed) { flushPara(); continue; }

    const fence = /^(```|~~~)/.exec(trimmed);
    if (fence) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) code.push(lines[i++]!);
      blocks.push({ kind: "code", lines: code });
      continue;
    }

    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(trimmed);
    if (h) {
      flushPara();
      blocks.push({ kind: "heading", level: h[1]!.length, inlines: parseInline(h[2]!) });
      continue;
    }

    if (/^(<!--\s*pagebreak\s*-->|\\pagebreak|\\newpage)$/i.test(trimmed)) {
      flushPara();
      blocks.push({ kind: "pagebreak" });
      continue;
    }

    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      flushPara();
      blocks.push({ kind: "rule" });
      continue;
    }

    if (trimmed.includes("|") && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]!) && !SEPARATOR.test(line)) {
      flushPara();
      const header = splitRow(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
        rows.push(splitRow(lines[i]!).map(parseInline));
        i++;
      }
      i--;
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) {
        quote.push(lines[i]!.trim().replace(/^>\s?/, ""));
        i++;
      }
      i--;
      blocks.push({ kind: "quote", inlines: parseInline(quote.join(" ")) });
      continue;
    }

    const li = LIST.exec(line);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[2]!);
      const items: Array<{ level: number; inlines: Inline[] }> = [];
      const baseIndent = li[1]!.length;
      while (i < lines.length) {
        const m = LIST.exec(lines[i]!);
        if (m) {
          if (m[1]!.length === baseIndent && /\d/.test(m[2]!) !== ordered) break;
          const level = Math.min(2, Math.max(0, Math.floor((m[1]!.length - baseIndent) / 2)));
          items.push({ level, inlines: parseInline(m[3]!.replace(/^\[[ xX]\]\s+/, (box) => (box.includes(" ]") ? "☐ " : "☑ "))) });
          i++;
          continue;
        }
        // A wrapped continuation line belongs to the previous item.
        const next = lines[i]!;
        if (next.trim() && /^\s{2,}/.test(next) && items.length) {
          items[items.length - 1]!.inlines.push(...parseInline(" " + next.trim()));
          i++;
          continue;
        }
        break;
      }
      i--;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    para.push(trimmed);
  }
  flushPara();
  return blocks;
}

/** True when a value should be laid out as blocks (it has Markdown structure), not inline text. */
export function looksLikeBlocks(value: string): boolean {
  return /\n/.test(value.trim()) || /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>)/.test(value.trim());
}
