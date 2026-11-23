// Word (.docx) support for the office tool.
//
//   buildDocx   copy a template (or a plain built-in one), fill {{placeholders}} and lay the
//               Markdown content out with the template's own styles (Heading 1, List Bullet,
//               Table Grid, …), so the result follows the person's form.
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
  /** Values for {{placeholders}}. A value with Markdown structure fills a whole paragraph as blocks. */
  vars?: Record<string, string>;
}

export interface DocxBuildReport {
  /** Where the content went: "placeholder" ({{content}}), "appended", or "none" (no content given). */
  content: "placeholder" | "appended" | "none";
  filled: string[];
  /** Placeholders in the template with no value: left as they are. */
  missing: string[];
  /** Values given for placeholders the template doesn't have. */
  unused: string[];
}

export interface DocxInspection {
  placeholders: string[];
  /** Paragraph style names the template defines, e.g. "heading 1", "list bullet". */
  styles: string[];
  /** The template's text, paragraph by paragraph (first 120), with each paragraph's style. */
  outline: Array<{ style: string | null; text: string }>;
  tables: number;
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

function paragraphText(p: XmlElement): string {
  let text = "";
  const walk = (n: XmlNode) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const el = c as XmlElement;
      if (el.namespaceURI === W && el.localName === "t") text += el.textContent ?? "";
      else if (el.namespaceURI === W && el.localName === "tab") text += "\t";
      else if (el.namespaceURI === W && (el.localName === "br" || el.localName === "cr")) text += "\n";
      else if (!(el.namespaceURI === W && (el.localName === "pPr" || el.localName === "rPr" || el.localName === "instrText" || el.localName === "delText"))) walk(el);
    }
  };
  walk(p);
  return text;
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
}

function readStyles(xml: string | null): StyleMap {
  const map: StyleMap = { paragraph: new Map(), table: new Map(), character: new Map(), names: new Map() };
  if (!xml) return map;
  const doc = parseXml(xml);
  for (const s of elements(doc, "style")) {
    const type = attr(s, "type");
    const id = attr(s, "styleId");
    const nameEl = children(s, "name")[0];
    const name = (attr(nameEl, "val") ?? id ?? "").toLowerCase();
    if (!id) continue;
    map.names.set(id, name);
    if (type === "paragraph") map.paragraph.set(name, id);
    else if (type === "table") map.table.set(name, id);
    else if (type === "character") map.character.set(name, id);
  }
  return map;
}

// ── Markdown → WordprocessingML ─────────────────────────────────────────

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
  const vars = input.vars ?? {};
  const seen = new Set<string>();
  const filled = new Set<string>();
  const missing = new Set<string>();
  let contentPlaced = false;
  const markdown = input.markdown?.trim() ? input.markdown : null;
  let docRenderer: Renderer | null = null;

  for (const part of textParts(zip)) {
    const isBody = part === "word/document.xml";
    const doc = parseXml(await zip.file(part)!.async("string"));
    const renderer = new Renderer(styles, isBody);
    if (isBody) docRenderer = renderer;

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
          if (only === "content") contentPlaced = true;
          continue;
        }
      }

      let changed = false;
      const next = text.replace(PLACEHOLDER, (whole, key: string) => {
        const value = key === "content" && vars.content === undefined ? markdown : vars[key];
        if (value === undefined || value === null) { missing.add(key); return whole; }
        changed = true;
        filled.add(key);
        if (key === "content") contentPlaced = true;
        return parseInline(value).map((r) => r.text).join("");
      });
      if (changed) setParagraphText(p, next);
    }

    if (isBody && markdown !== null && !contentPlaced && !seen.has("content")) {
      const body = elements(doc, "body")[0];
      if (body) {
        const sect = children(body, "sectPr")[0];
        for (const n of fragment(doc, renderer.blocks(parseMarkdown(markdown)))) body.insertBefore(n as never, (sect ?? null) as never);
      }
    }
    zip.file(part, serialize(doc));
  }

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
  const contentState: DocxBuildReport["content"] = markdown === null ? "none" : contentPlaced ? "placeholder" : "appended";
  for (const k of filled) missing.delete(k);
  return {
    buffer,
    report: {
      content: contentState,
      filled: [...filled].sort(),
      missing: [...missing].sort(),
      unused: Object.keys(vars).filter((k) => !seen.has(k)).sort(),
    },
  };
}

export async function inspectDocx(buf: Buffer): Promise<DocxInspection> {
  const zip = await openDocx(buf);
  const styles = readStyles(await zip.file("word/styles.xml")?.async("string") ?? null);
  const placeholders = new Set<string>();
  const outline: DocxInspection["outline"] = [];
  let tables = 0;
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
    if (part === "word/document.xml") tables = elements(doc, "tbl").length;
  }
  return { placeholders: [...placeholders].sort(), styles: [...styles.paragraph.keys()].sort(), outline, tables };
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
