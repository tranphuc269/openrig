// Word (.docx) support for the office tool.
//
//   buildDocx   lay Markdown content out with a form's own styles (Heading 1, List Bullet, Table
//               Grid, …), page setup, header and footer. mode "style" writes a new body in the
//               form's look; mode "fill" keeps the form's text and fills {{placeholders}}.
//   inspectDocx what a template offers: its placeholders, styles and current text.
//   readDocx    a document as Markdown, so an agent can read a teammate's Word file.

import JSZip from "jszip";
import { DOMParser, XMLSerializer, type Document as XmlDocument, type Element as XmlElement, type Node as XmlNode } from "@xmldom/xmldom";
import { looksLikeBlocks, parseInline, parseMarkdown, type Block, type Inline } from "./markdown.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const HYPERLINK_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export interface DocxBuildInput {
  /** The form to follow. Without one, a plain document is built. */
  template?: Buffer | null;
  /** Main content as Markdown: replaces a paragraph holding only {{content}}, else is appended. */
  markdown?: string | null;
  /** Values for {{placeholders}} and <Field> placeholders (key: the text inside the brackets). A value with
   *  Markdown structure fills a whole {{placeholder}} paragraph as blocks. "row:<header cell>": rows (string[][])
   *  written into the empty rows of the table with that header, e.g. a change log. */
  vars?: Record<string, string | Array<string | number | null> | Array<Array<string | number | null>>>;
  /** "fill": keep the form's text and fill it. "style": keep only the form's look (styles, page setup,
   *  header, footer) and make the body the Markdown content. */
  mode?: "fill" | "style";
}

export interface DocxBuildReport {
  /** Where the content went: "placeholder" ({{content}}), "appended", "body" (--style: the whole body), or "none". */
  content: "placeholder" | "appended" | "body" | "none";
  filled: string[];
  /** Placeholders in the template with no value: left as they are. */
  missing: string[];
  /** Values given for placeholders the template doesn't have. */
  unused: string[];
  /** How many places in the document changed. */
  changes: number;
  /** --style: how many top-level parts of the form's front pages were kept (cover, change log, TOC, …). */
  frontMatter: number;
  /** What still looks wrong in the result: unfilled <fields>/{{placeholders}}, hint text, a heading twice. */
  problems: string[];
}

export interface DocxInspection {
  placeholders: string[];
  /** Paragraph style names the template defines, e.g. "heading 1", "list bullet". */
  styles: string[];
  /** The template's text, paragraph by paragraph (first 120), with each paragraph's style. */
  outline: Array<{ style: string | null; text: string }>;
  tables: number;
  /** <Field> placeholders on the form's front pages and in headers/footers. */
  fields: string[];
  /** Header rows of the tables on the front pages (before the first heading), e.g. a change log. */
  frontTables: string[][];
  /** Headings of the form's body, in order, with their level. */
  headings: Array<{ level: number; text: string }>;
}

// ── XML helpers ──────────────────────────────────────────────────────────

function parseXml(xml: string): XmlDocument {
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as XmlDocument;
}

function serialize(doc: XmlDocument): string {
  return new XMLSerializer().serializeToString(doc as never);
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    // Characters XML 1.0 forbids would make Word refuse the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function elements(node: XmlNode | XmlDocument, localName: string): XmlElement[] {
  const list = (node as XmlElement).getElementsByTagNameNS(W, localName);
  const out: XmlElement[] = [];
  for (let i = 0; i < list.length; i++) out.push(list.item(i)!);
  return out;
}

function children(node: XmlNode, localName?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && (!localName || ((c as XmlElement).namespaceURI === W && (c as XmlElement).localName === localName))) out.push(c as XmlElement);
  }
  return out;
}

/** Paragraphs that contain no other paragraph (text boxes nest paragraphs inside runs). */
function innermostParagraphs(doc: XmlDocument): XmlElement[] {
  return elements(doc, "p").filter((p) => elements(p, "p").length === 0);
}

interface Segment { node: XmlElement; editable: boolean; text: string }

/** The text pieces of a paragraph in order: w:t nodes (editable), tabs and breaks. */
function segments(p: XmlElement): Segment[] {
  const out: Segment[] = [];
  const walk = (n: XmlNode) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const el = c as XmlElement;
      if (el.namespaceURI === W && el.localName === "t") out.push({ node: el, editable: true, text: el.textContent ?? "" });
      else if (el.namespaceURI === W && el.localName === "tab") out.push({ node: el, editable: false, text: "\t" });
      else if (el.namespaceURI === W && (el.localName === "br" || el.localName === "cr")) out.push({ node: el, editable: false, text: "\n" });
      else if (!(el.namespaceURI === W && (el.localName === "pPr" || el.localName === "rPr" || el.localName === "instrText" || el.localName === "delText" || el.localName === "p"))) walk(el);
    }
  };
  walk(p);
  return out;
}

function paragraphText(p: XmlElement): string {
  return segments(p).map((s) => s.text).join("");
}

function setT(t: XmlElement, text: string): void {
  while (t.firstChild) t.removeChild(t.firstChild);
  t.appendChild(t.ownerDocument!.createTextNode(text));
  t.setAttribute("xml:space", "preserve");
}

/** Replace characters [start, end) of a paragraph's text in place, keeping every run's formatting. */
function replaceRange(p: XmlElement, start: number, end: number, text: string): boolean {
  const segs = segments(p);
  let pos = 0;
  let placed = false;
  let lastBefore: Segment | null = null;
  for (const seg of segs) {
    const a = pos;
    const b = pos + seg.text.length;
    pos = b;
    if (b <= start) { if (seg.editable) lastBefore = seg; continue; }
    if (a >= end) break;
    const from = Math.max(0, start - a);
    const to = Math.min(seg.text.length, end - a);
    if (seg.editable) {
      setT(seg.node, seg.text.slice(0, from) + (placed ? "" : text) + seg.text.slice(to));
      placed = true;
    } else if (from === 0 && to === seg.text.length) {
      seg.node.parentNode?.removeChild(seg.node);
    }
  }
  if (!placed) {
    if (!lastBefore) return false;
    setT(lastBefore.node, (lastBefore.node.textContent ?? "") + text);
  }
  return true;
}

function attr(el: XmlElement | undefined, name: string): string | null {
  return el ? el.getAttributeNS(W, name) || el.getAttribute(`w:${name}`) || null : null;
}

// ── Styles ───────────────────────────────────────────────────────────────

interface StyleMap {
  /** lower-case style name → style id, per type. */
  paragraph: Map<string, string>;
  table: Map<string, string>;
  character: Map<string, string>;
  /** style id → lower-case name. */
  names: Map<string, string>;
  /** Paragraph style ids that number themselves (a numPr in the style or a style it is based on). */
  numbered: Set<string>;
}

function readStyles(xml: string | null): StyleMap {
  const map: StyleMap = { paragraph: new Map(), table: new Map(), character: new Map(), names: new Map(), numbered: new Set() };
  if (!xml) return map;
  const doc = parseXml(xml);
  const basedOn = new Map<string, string>();
  const ownNumbering = new Map<string, boolean>();
  for (const s of elements(doc, "style")) {
    const type = attr(s, "type");
    const id = attr(s, "styleId");
    const nameEl = children(s, "name")[0];
    const name = (attr(nameEl, "val") ?? id ?? "").toLowerCase();
    if (!id) continue;
    map.names.set(id, name);
    if (type === "paragraph") {
      map.paragraph.set(name, id);
      const base = attr(children(s, "basedOn")[0], "val");
      if (base) basedOn.set(id, base);
      const numPr = children(children(s, "pPr")[0] ?? s, "numPr")[0];
      if (numPr) ownNumbering.set(id, attr(children(numPr, "numId")[0], "val") !== "0");
    }
    else if (type === "table") map.table.set(name, id);
    else if (type === "character") map.character.set(name, id);
  }
  for (const id of map.names.keys()) {
    let cur: string | undefined = id;
    for (let depth = 0; cur && depth < 10; depth++) {
      const own = ownNumbering.get(cur);
      if (own !== undefined) { if (own) map.numbered.add(id); break; }
      cur = basedOn.get(cur);
    }
  }
  return map;
}

// ── Markdown → WordprocessingML ─────────────────────────────────────────

const TYPED_NUMBER = /^\s*(?:(?:\d+\.)*\d+\.?|[IVXLC]+\.|[A-Z]\.)\s+/;

function stripNumbering(inlines: Inline[]): Inline[] {
  const [first, ...rest] = inlines;
  if (!first || !TYPED_NUMBER.test(first.text)) return inlines;
  const text = first.text.replace(TYPED_NUMBER, "");
  return text ? [{ ...first, text }, ...rest] : rest;
}

class Renderer {
  private relCounter = 0;
  readonly newRels: Array<{ id: string; target: string }> = [];

  constructor(private readonly styles: StyleMap, private readonly allowLinks: boolean) {}

  private pStyle(...names: string[]): string | null {
    for (const n of names) {
      const id = this.styles.paragraph.get(n);
      if (id) return id;
    }
    return null;
  }

  private runs(inlines: Inline[], extra: { bold?: boolean; size?: number; color?: string } = {}): string {
    return inlines.map((r) => {
      const props: string[] = [];
      const linkStyle = r.link ? this.styles.character.get("hyperlink") : undefined;
      if (linkStyle) props.push(`<w:rStyle w:val="${esc(linkStyle)}"/>`);
      if (r.code) props.push(`<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>`);
      if (r.bold || extra.bold) props.push("<w:b/>");
      if (r.italic) props.push("<w:i/>");
      // WordprocessingML wants rPr children in schema order: color, sz, szCs, u, shd.
      if (r.link && !linkStyle) props.push(`<w:color w:val="0563C1"/>`);
      else if (extra.color) props.push(`<w:color w:val="${extra.color}"/>`);
      if (extra.size) props.push(`<w:sz w:val="${extra.size}"/><w:szCs w:val="${extra.size}"/>`);
      if (r.link && !linkStyle) props.push(`<w:u w:val="single"/>`);
      if (r.code) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>`);
      const rPr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
      const parts = r.text.split("\n").map((t) => `<w:t xml:space="preserve">${esc(t)}</w:t>`).join("<w:br/>");
      const run = `<w:r>${rPr}${parts}</w:r>`;
      if (r.link && this.allowLinks && /^(https?:|mailto:)/i.test(r.link)) {
        const id = `rIdFactoryLink${++this.relCounter}`;
        this.newRels.push({ id, target: r.link });
        return `<w:hyperlink r:id="${id}" w:history="1">${run}</w:hyperlink>`;
      }
      return run;
    }).join("");
  }

  private paragraph(inlines: Inline[], opts: { style?: string | null; pPr?: string; bold?: boolean; size?: number; color?: string } = {}): string {
    const pPr = (opts.style ? `<w:pStyle w:val="${esc(opts.style)}"/>` : "") + (opts.pPr ?? "");
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${this.runs(inlines, opts)}</w:p>`;
  }

  block(b: Block): string {
    switch (b.kind) {
      case "heading": {
        const style = this.pStyle(`heading ${b.level}`);
        // The form numbers its headings itself ("1", "1.1"): drop numbers typed in the draft.
        if (style && this.styles.numbered.has(style)) return this.paragraph(stripNumbering(b.inlines), { style });
        if (style) return this.paragraph(b.inlines, { style });
        const size = [36, 30, 26, 24, 22, 22][b.level - 1];
        return this.paragraph(b.inlines, { bold: true, size, pPr: `<w:keepNext/><w:spacing w:before="240" w:after="120"/>` });
      }
      case "paragraph":
        return this.paragraph(b.inlines);
      case "quote": {
        const style = this.pStyle("quote", "intense quote");
        return style ? this.paragraph(b.inlines, { style })
          : this.paragraph(b.inlines.map((r) => ({ ...r, italic: true })), {
            pPr: `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="A5A5A5"/></w:pBdr><w:ind w:left="360"/>`,
          });
      }
      case "code": {
        const text = b.lines.join("\n");
        return this.paragraph([{ text, code: true }], { pPr: `<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="120"/>` });
      }
      case "rule":
        return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>`;
      case "pagebreak":
        return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
      case "list": {
        const counters = [0, 0, 0];
        return b.items.map((item) => {
          counters[item.level]!++;
          for (let l = item.level + 1; l < counters.length; l++) counters[l] = 0;
          if (!b.ordered) {
            const style = this.pStyle(item.level === 0 ? "list bullet" : `list bullet ${item.level + 1}`);
            if (style) return this.paragraph(item.inlines, { style });
          }
          const marker = b.ordered ? `${counters[item.level]}.` : ["•", "◦", "▪"][item.level];
          const left = 360 * (item.level + 1) + 360;
          return this.paragraph([{ text: `${marker}\t` }, ...item.inlines], {
            style: this.pStyle("list paragraph"),
            pPr: `<w:tabs><w:tab w:val="left" w:pos="${left}"/></w:tabs><w:ind w:left="${left}" w:hanging="360"/><w:contextualSpacing/>`,
          });
        }).join("");
      }
      case "table": {
        const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
        const width = Math.floor(9360 / cols);
        const style = this.styles.table.get("table grid");
        const border = `w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"`;
        const cell = (inlines: Inline[] | undefined, header: boolean) =>
          `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? `<w:shd w:val="clear" w:color="auto" w:fill="DCE6F2"/>` : ""}</w:tcPr>`
          + `${this.paragraph(inlines ?? [], { bold: header, pPr: `<w:spacing w:before="40" w:after="40"/>` })}</w:tc>`;
        const row = (cells: Inline[][], header: boolean) =>
          `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${Array.from({ length: cols }, (_, i) => cell(cells[i], header)).join("")}</w:tr>`;
        return `<w:tbl><w:tblPr>${style ? `<w:tblStyle w:val="${esc(style)}"/>` : ""}<w:tblW w:w="5000" w:type="pct"/>`
          + `<w:tblBorders><w:top ${border}/><w:left ${border}/><w:bottom ${border}/><w:right ${border}/><w:insideH ${border}/><w:insideV ${border}/></w:tblBorders>`
          + `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`
          + `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>`
          + row(b.header, true) + b.rows.map((r) => row(r, false)).join("")
          + `</w:tbl><w:p/>`;
      }
    }
  }

  blocks(blocks: Block[]): string {
    return blocks.map((b) => this.block(b)).join("");
  }
}

function fragment(doc: XmlDocument, xml: string): XmlNode[] {
  const wrapper = parseXml(`<x:root xmlns:x="urn:factory" xmlns:w="${W}" xmlns:r="${R}">${xml}</x:root>`);
  const root = wrapper.documentElement!;
  const out: XmlNode[] = [];
  for (let c = root.firstChild; c; c = c.nextSibling) out.push(doc.importNode(c as never, true) as unknown as XmlNode);
  return out;
}

/** Replace the text of a paragraph, keeping the formatting of its first text run. */
function setParagraphText(p: XmlElement, text: string): void {
  const doc = p.ownerDocument!;
  const runs = elements(p, "r").filter((r) => elements(r, "t").length > 0);
  if (runs.length === 0) return;
  const first = runs[0]!;
  for (const t of elements(first, "t")) t.parentNode!.removeChild(t);
  for (const br of [...elements(first, "br"), ...elements(first, "tab")]) br.parentNode!.removeChild(br);
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (i > 0) first.appendChild(doc.createElementNS(W, "w:br"));
    const t = doc.createElementNS(W, "w:t");
    t.setAttribute("xml:space", "preserve");
    t.appendChild(doc.createTextNode(line));
    first.appendChild(t);
  });
  for (const r of runs.slice(1)) {
    const meaningful = children(r).filter((c) => !(c.localName === "rPr" || c.localName === "t" || c.localName === "tab" || c.localName === "br"));
    if (meaningful.length === 0) r.parentNode!.removeChild(r);
    else for (const t of elements(r, "t")) t.parentNode!.removeChild(t);
  }
}

function insertBlocks(p: XmlElement, nodes: XmlNode[]): void {
  const parent = p.parentNode!;
  for (const n of nodes) parent.insertBefore(n as never, p as never);
  parent.removeChild(p as never);
  // A table cell must end with a paragraph.
  if ((parent as XmlElement).localName === "tc") {
    const last = children(parent).pop();
    if (!last || last.localName !== "p") parent.appendChild(parent.ownerDocument!.createElementNS(W, "w:p"));
  }
}

// ── Style mode: the form's front pages, a new body ─────────────────────────

function styleNameOf(p: XmlElement, styles: StyleMap): string {
  const pPr = children(p, "pPr")[0];
  const id = attr(pPr ? children(pPr, "pStyle")[0] : undefined, "val");
  return id ? styles.names.get(id) ?? id.toLowerCase() : "";
}

function isHeading(el: XmlElement, styles: StyleMap): boolean {
  return el.localName === "p" && /^heading [1-9]$/.test(styleNameOf(el, styles));
}

function headingKey(text: string): string {
  return normKey(text.replace(TYPED_NUMBER, ""));
}

/**
 * Keeps the form's front pages (cover, change log, sign-off page, table of contents) and drops the rest of
 * its body, which the new content replaces. Where the body starts, in order of preference:
 *   1. the form's first paragraph in a Heading style;
 *   2. the first paragraph (outside the table of contents) whose text is the draft's first heading;
 *   3. right after the table of contents.
 * Notes for the writer between the table of contents and the body are dropped too.
 * Returns how many top-level elements were kept (0: no body start found, only the page setup is kept).
 */
function keepFrontMatter(doc: XmlDocument, styles: StyleMap, draftHeading: string | null): number {
  const body = elements(doc, "body")[0];
  if (!body) return 0;
  const all = children(body).filter((el) => el.localName !== "sectPr");
  const isToc = (el: XmlElement) => el.localName === "p" && styleNameOf(el, styles).startsWith("toc");
  let lastToc = -1;
  all.forEach((el, i) => { if (isToc(el)) lastToc = i; });
  let first = all.findIndex((el) => isHeading(el, styles));
  if (first < 0 && draftHeading) {
    const want = headingKey(draftHeading);
    first = all.findIndex((el, i) => i > lastToc && el.localName === "p" && headingKey(paragraphText(el)) === want);
  }
  if (first < 0 && lastToc >= 0) first = lastToc + 1;
  const front = first < 0 ? [] : all.slice(0, first);
  for (const el of first < 0 ? all : all.slice(first)) body.removeChild(el);
  const tocInFront = front.reduce((acc, el, i) => (isToc(el) ? i : acc), -1);
  if (tocInFront >= 0) {
    for (const el of front.slice(tocInFront + 1)) {
      if (el.localName === "p" && paragraphText(el).trim() && !elements(el, "fldChar").length) body.removeChild(el);
    }
  }
  return front.length;
}

/** What still looks wrong in a built document: things left from the model, or the same heading twice. */
function selfCheck(doc: XmlDocument, styles: StyleMap, partName: string): string[] {
  const problems: string[] = [];
  const where = partName === "word/document.xml" ? "" : ` (${partName.replace("word/", "").replace(".xml", "")})`;
  for (const p of innermostParagraphs(doc)) {
    if (styleNameOf(p, styles).startsWith("toc")) continue;
    const text = paragraphText(p).trim();
    if (!text) continue;
    for (const m of text.matchAll(ANGLE)) problems.push(`unfilled field <${m[1]!.trim()}>${where}`);
    for (const m of text.matchAll(PLACEHOLDER)) problems.push(`unfilled placeholder {{${m[1]}}}${where}`);
    if (/^\[[^\]]{12,}/.test(text) || /^\[.*\]$/s.test(text) && text.length > 12) problems.push(`hint text from the model: "${text.slice(0, 70)}"`);
  }
  if (partName === "word/document.xml") {
    const seen = new Map<string, number>();
    for (const p of elements(doc, "p")) {
      if (!/^heading 1$/.test(styleNameOf(p, styles))) continue;
      const k = headingKey(paragraphText(p));
      if (!k) continue;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const [k, n] of seen) if (n > 1) problems.push(`heading "${k}" appears ${n} times (model text left in, or a section written twice)`);
  }
  return [...new Set(problems)];
}

function hasTocField(doc: XmlDocument): boolean {
  return elements(doc, "instrText").some((t) => /\bTOC\b/.test(t.textContent ?? ""))
    || elements(doc, "fldSimple").some((f) => /\bTOC\b/.test(f.getAttribute("w:instr") ?? ""));
}

/** Ask Word to refresh fields (the table of contents) when the document opens. */
async function requestFieldUpdate(zip: JSZip): Promise<void> {
  const file = zip.file("word/settings.xml");
  if (!file) return;
  const doc = parseXml(await file.async("string"));
  const root = doc.documentElement!;
  if (elements(doc, "updateFields").length) return;
  const el = doc.createElementNS(W, "w:updateFields");
  el.setAttribute("w:val", "true");
  const after = ["hdrShapeDefaults", "footnotePr", "endnotePr", "compat", "docVars", "rsids", "mathPr", "attachedSchema", "themeFontLang",
    "clrSchemeMapping", "doNotIncludeSubdocsInStats", "doNotAutoCompressPictures", "forceUpgrade", "captions", "readModeInkLockDown",
    "smartTagType", "schemaLibrary", "shapeDefaults", "doNotEmbedSmartTags", "decimalSymbol", "listSeparator"];
  const before = children(root).find((c) => after.includes(c.localName ?? ""));
  root.insertBefore(el, (before ?? null) as never);
  zip.file("word/settings.xml", serialize(doc));
}

// ── <Field> placeholders and table rows on a form's own pages ─────────────

const ANGLE = /<\s*([^<>\n]{1,80}?)\s*>/g;

function normKey(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

function cellText(tc: XmlElement): string {
  return children(tc, "p").map((p) => paragraphText(p)).join(" ").replace(/\s+/g, " ").trim();
}

function setCellText(tc: XmlElement, value: string): void {
  const doc = tc.ownerDocument!;
  const paras = children(tc, "p");
  let p = paras[0];
  if (!p) { p = doc.createElementNS(W, "w:p"); tc.appendChild(p); }
  for (const extra of paras.slice(1)) tc.removeChild(extra);
  if (elements(p, "t").length) { setParagraphText(p, value); return; }
  const r = doc.createElementNS(W, "w:r");
  const markProps = children(children(p, "pPr")[0] ?? p, "rPr")[0];
  if (markProps) r.appendChild(markProps.cloneNode(true) as never);
  value.split("\n").forEach((line, i) => {
    if (i > 0) r.appendChild(doc.createElementNS(W, "w:br"));
    const t = doc.createElementNS(W, "w:t");
    t.setAttribute("xml:space", "preserve");
    t.appendChild(doc.createTextNode(line));
    r.appendChild(t);
  });
  p.appendChild(r);
}

/** "row:<header cell text>" → fill the first empty rows of the table with that header. Returns rows written. */
function fillRows(doc: XmlDocument, header: string, rows: string[][]): number {
  const key = normKey(header);
  for (const tbl of elements(doc, "tbl")) {
    const trs = children(tbl, "tr");
    const headIdx = trs.slice(0, 3).findIndex((tr) => children(tr, "tc").some((tc) => normKey(cellText(tc)) === key || normKey(cellText(tc)).startsWith(key)));
    if (headIdx < 0) continue;
    const empty = trs.slice(headIdx + 1).filter((tr) => children(tr, "tc").every((tc) => !cellText(tc)));
    let written = 0;
    for (const values of rows) {
      let tr = empty[written];
      if (!tr) {
        const model = empty[0] ?? trs[trs.length - 1];
        if (!model) break;
        tr = model.cloneNode(true) as unknown as XmlElement;
        tbl.appendChild(tr as never);
      }
      children(tr, "tc").forEach((tc, i) => setCellText(tc, values[i] === undefined || values[i] === null ? "" : String(values[i])));
      written++;
    }
    return written;
  }
  return 0;
}

// ── Default template ─────────────────────────────────────────────────────

const DEFAULT_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
${[1, 2, 3, 4].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${[360, 280, 240, 200][n - 1]}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${["1F3864", "2F5496", "2F5496", "404040"][n - 1]}"/><w:sz w:val="${[34, 28, 24, 22][n - 1]}"/><w:szCs w:val="${[34, 28, 24, 22][n - 1]}"/></w:rPr></w:style>`).join("\n")}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="A5A5A5"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

function defaultDocx(): JSZip {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file("word/styles.xml", DEFAULT_STYLES);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1273" w:bottom="1440" w:left="1273" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip;
}

// ── Public API ───────────────────────────────────────────────────────────

async function openDocx(buf: Buffer): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error("Not a Word file (.docx). Old .doc files must be saved as .docx first.");
  }
  if (!zip.file("word/document.xml")) throw new Error("Not a Word document: word/document.xml is missing.");
  return zip;
}

function textParts(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((n) => n === "word/document.xml" || /^word\/(header|footer)\d*\.xml$/.test(n));
}

export async function buildDocx(input: DocxBuildInput): Promise<{ buffer: Buffer; report: DocxBuildReport }> {
  const zip = input.template ? await openDocx(input.template) : defaultDocx();
  const styles = readStyles(await zip.file("word/styles.xml")?.async("string") ?? null);
  const allVars = input.vars ?? {};
  const vars: Record<string, string> = {};
  const rowVars: Array<[string, string[][]]> = [];
  for (const [k, v] of Object.entries(allVars)) {
    if (k.startsWith("row:")) {
      const rows = Array.isArray(v) ? (Array.isArray(v[0]) ? v : [v]) as unknown[][] : [];
      rowVars.push([k.slice(4), rows.map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))))]);
    } else if (typeof v === "string" || typeof v === "number") vars[k] = String(v);
  }
  const angleVars = new Map<string, string | string[]>(Object.entries(vars).map(([k, v]) => [normKey(k.replace(/^<|>$/g, "")), v]));
  // A list fills repeated fields in order: {"Chức danh": ["Trưởng nhóm BA", "Trưởng dự án", "", "Giám đốc"]}.
  for (const [k, v] of Object.entries(allVars)) {
    if (!k.startsWith("row:") && Array.isArray(v) && v.every((x) => !Array.isArray(x))) {
      angleVars.set(normKey(k.replace(/^<|>$/g, "")), (v as unknown[]).map((x) => (x === null || x === undefined ? "" : String(x))));
    }
  }
  const angleSeen = new Map<string, number>();
  const usedAngle = new Set<string>();
  const seen = new Set<string>();
  const filled = new Set<string>();
  const missing = new Set<string>();
  let contentPlaced = false;
  let changes = 0;
  const markdown = input.markdown?.trim() ? input.markdown : null;
  // Content into a form without a {{content}} spot replaces the form's body: never pile it under the
  // form's own sample text, whichever flag the agent used.
  let hasContentSpot = false;
  if (input.template && markdown !== null && input.mode !== "style") {
    const xml = await zip.file("word/document.xml")!.async("string");
    hasContentSpot = innermostParagraphs(parseXml(xml)).some((p) => /\{\{\s*content\s*\}\}/.test(paragraphText(p)));
  }
  const styleOnly = !!input.template && markdown !== null && (input.mode === "style" || !hasContentSpot);
  if (input.mode === "style" && !!input.template && markdown === null) throw new Error("--style needs the document's content: pass --content <draft.md>");
  const draftHeading = (() => {
    if (markdown === null) return null;
    const h = parseMarkdown(markdown).find((b) => b.kind === "heading") as Extract<Block, { kind: "heading" }> | undefined;
    return h ? h.inlines.map((r) => r.text).join("") : null;
  })();
  const problems: string[] = [];
  let frontMatter = 0;
  let tocKept = false;
  let docRenderer: Renderer | null = null;

  for (const part of textParts(zip)) {
    const isBody = part === "word/document.xml";
    const doc = parseXml(await zip.file(part)!.async("string"));
    const renderer = new Renderer(styles, isBody);
    if (isBody) docRenderer = renderer;
    if (isBody && styleOnly) {
      const kept = keepFrontMatter(doc, styles, draftHeading);
      frontMatter = kept;
      if (kept > 0 && hasTocField(doc)) tocKept = true;
    }

    // <Field> placeholders on the form's own pages (and in headers/footers): "<Tên dự án>", "<Ngày>".
    if (!isBody || styleOnly || input.mode === "fill") {
      for (const p of innermostParagraphs(doc)) {
        const text = paragraphText(p);
        if (!text.includes("<") || styleNameOf(p, styles).startsWith("toc")) continue;
        const matches = [...text.matchAll(ANGLE)].map((m) => {
          const key = normKey(m[1]!);
          const n = angleSeen.get(key) ?? 0;
          angleSeen.set(key, n + 1);
          return { m, key, n };
        });
        for (const { m, key, n } of matches.reverse()) {
          const given = angleVars.get(key);
          const value = Array.isArray(given) ? given[n] : given;
          if (value === undefined) { if (styleOnly || !isBody) missing.add(`<${m[1]!.trim()}>`); continue; }
          if (replaceRange(p, m.index!, m.index! + m[0].length, value)) { usedAngle.add(key); filled.add(`<${m[1]!.trim()}>`); changes++; }
        }
      }
    }
    if (isBody) {
      for (const [header, rows] of rowVars) {
        const n = fillRows(doc, header, rows);
        if (n > 0) { filled.add(`row:${header} (${n})`); changes++; } else missing.add(`row:${header} (no table with that header)`);
      }
    }

    for (const p of innermostParagraphs(doc)) {
      const text = paragraphText(p);
      if (!text.includes("{{")) continue;
      const keys = [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
      if (keys.length === 0) continue;
      keys.forEach((k) => seen.add(k));

      const only = /^\s*\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}\s*$/.exec(text)?.[1];
      if (only && isBody) {
        const value = only === "content" && markdown !== null && vars.content === undefined ? markdown : vars[only];
        if (value !== undefined && (only === "content" || looksLikeBlocks(value))) {
          insertBlocks(p, fragment(doc, renderer.blocks(parseMarkdown(value))));
          filled.add(only);
          changes++;
          if (only === "content") contentPlaced = true;
          continue;
        }
      }

      for (const m of [...text.matchAll(PLACEHOLDER)].reverse()) {
        const key = m[1]!;
        const value = key === "content" && vars.content === undefined ? markdown : vars[key];
        if (value === undefined || value === null) { missing.add(key); continue; }
        if (replaceRange(p, m.index!, m.index! + m[0].length, parseInline(value).map((r) => r.text).join(""))) {
          filled.add(key);
          changes++;
          if (key === "content") contentPlaced = true;
        }
      }
    }

    if (isBody && markdown !== null && !contentPlaced && !seen.has("content")) {
      const body = elements(doc, "body")[0];
      if (body) {
        const sect = children(body, "sectPr")[0];
        for (const n of fragment(doc, renderer.blocks(parseMarkdown(markdown)))) body.insertBefore(n as never, (sect ?? null) as never);
        changes++;
      }
    }
    if (input.template) problems.push(...selfCheck(doc, styles, part));
    zip.file(part, serialize(doc));
  }

  if (tocKept) await requestFieldUpdate(zip);

  if (docRenderer && docRenderer.newRels.length) {
    const relsPath = "word/_rels/document.xml.rels";
    const rels = parseXml(await zip.file(relsPath)?.async("string") ?? `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL}"/>`);
    const root = rels.documentElement!;
    for (const rel of docRenderer.newRels) {
      const el = rels.createElementNS(PKG_REL, "Relationship");
      el.setAttribute("Id", rel.id);
      el.setAttribute("Type", HYPERLINK_REL);
      el.setAttribute("Target", rel.target);
      el.setAttribute("TargetMode", "External");
      root.appendChild(el);
    }
    zip.file(relsPath, serialize(rels));
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const contentState: DocxBuildReport["content"] = markdown === null ? "none" : styleOnly ? "body" : contentPlaced ? "placeholder" : "appended";
  for (const k of filled) missing.delete(k);
  return {
    buffer,
    report: {
      content: contentState,
      filled: [...filled].sort(),
      missing: [...missing].sort(),
      unused: Object.keys(allVars).filter((k) => !k.startsWith("row:") && !seen.has(k) && !usedAngle.has(normKey(k.replace(/^<|>$/g, "")))).sort(),
      frontMatter,
      problems: problems.slice(0, 30),
      changes,
    },
  };
}

export async function inspectDocx(buf: Buffer): Promise<DocxInspection> {
  const zip = await openDocx(buf);
  const styles = readStyles(await zip.file("word/styles.xml")?.async("string") ?? null);
  const placeholders = new Set<string>();
  const outline: DocxInspection["outline"] = [];
  let tables = 0;
  const fields = new Set<string>();
  const frontTables: string[][] = [];
  const headings: Array<{ level: number; text: string }> = [];
  for (const part of textParts(zip)) {
    const doc = parseXml(await zip.file(part)!.async("string"));
    for (const p of innermostParagraphs(doc)) {
      const text = paragraphText(p);
      for (const m of text.matchAll(PLACEHOLDER)) placeholders.add(m[1]!);
      if (part === "word/document.xml" && text.trim() && outline.length < 120) {
        const styleId = attr(children(children(p, "pPr")[0] ?? p, "pStyle")[0], "val");
        outline.push({ style: styleId ? styles.names.get(styleId) ?? styleId : null, text: text.trim().slice(0, 200) });
      }
    }
    const body = elements(doc, "body")[0];
    const top = body ? children(body) : [];
    const firstHeading = top.findIndex((el) => isHeading(el, styles));
    const frontEls = part === "word/document.xml" ? (firstHeading < 0 ? [] : top.slice(0, firstHeading)) : [doc.documentElement!];
    for (const el of frontEls) {
      for (const p of el.localName === "p" ? [el] : elements(el, "p")) {
        if (styleNameOf(p, styles).startsWith("toc")) continue;
        for (const m of paragraphText(p).matchAll(ANGLE)) fields.add(m[1]!.trim());
      }
      if (part === "word/document.xml") {
        for (const tbl of el.localName === "tbl" ? [el] : elements(el, "tbl")) {
          const head = children(tbl, "tr")[0];
          if (head) frontTables.push(children(head, "tc").map(cellText));
        }
      }
    }
    if (part === "word/document.xml") {
      tables = elements(doc, "tbl").length;
      for (const el of top) {
        if (!isHeading(el, styles)) continue;
        headings.push({ level: Number(/(\d)$/.exec(styleNameOf(el, styles))![1]), text: paragraphText(el).trim() });
      }
    }
  }
  return { placeholders: [...placeholders].sort(), styles: [...styles.paragraph.keys()].sort(), outline, tables, fields: [...fields], frontTables, headings };
}

/** The document as Markdown: headings, lists, tables and paragraphs. */
export async function readDocx(buf: Buffer): Promise<string> {
  const zip = await openDocx(buf);
  const styles = readStyles(await zip.file("word/styles.xml")?.async("string") ?? null);
  const doc = parseXml(await zip.file("word/document.xml")!.async("string"));
  const body = elements(doc, "body")[0];
  if (!body) return "";
  const out: string[] = [];
  const para = (p: XmlElement): string => {
    const text = paragraphText(p).trim();
    if (!text) return "";
    const pPr = children(p, "pPr")[0];
    const styleId = attr(pPr ? children(pPr, "pStyle")[0] : undefined, "val");
    const name = styleId ? styles.names.get(styleId) ?? styleId.toLowerCase() : "";
    const h = /^heading (\d)$/.exec(name);
    if (h) return `${"#".repeat(Number(h[1]))} ${text}`;
    if (name === "title") return `# ${text}`;
    const manual = /^(?:([•◦▪])|(\d+)\.)\t(.*)$/s.exec(text);
    if (manual) {
      const ind = attr(pPr ? children(pPr, "ind")[0] : undefined, "left");
      const depth = ind ? Math.max(0, Math.round((Number(ind) - 720) / 360)) : 0;
      return `${"  ".repeat(depth)}${manual[2] ? `${manual[2]}.` : "-"} ${manual[3]}`;
    }
    if (pPr && children(pPr, "numPr").length || name.startsWith("list")) return `- ${text}`;
    return text;
  };
  for (const el of children(body)) {
    if (el.localName === "p") {
      const line = para(el);
      // Consecutive list items stay together.
      if (line && /^\s*(-|\d+\.) /.test(line) && out.length && /^\s*(-|\d+\.) /.test(out[out.length - 1]!.split("\n").pop()!)) out[out.length - 1] += `\n${line}`;
      else if (line) out.push(line);
    } else if (el.localName === "tbl") {
      const rows = children(el, "tr").map((tr) => children(tr, "tc").map((tc) =>
        children(tc, "p").map((p) => paragraphText(p).trim()).filter(Boolean).join(" ").replace(/\|/g, "\\|")));
      if (rows.length) {
        const cols = Math.max(...rows.map((r) => r.length));
        const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? "").join(" | ")} |`;
        out.push([line(rows[0]!), `|${" --- |".repeat(cols)}`, ...rows.slice(1).map(line)].join("\n"));
      }
    } else if (el.localName === "sdt") {
      for (const p of elements(el, "p")) { const line = para(p); if (line) out.push(line); }
    }
  }
  return out.join("\n\n") + "\n";
}
