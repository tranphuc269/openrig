// Office form library — the Word and Excel forms people upload for documents to follow.
//
// Stored under $OPENRIG_HOME/factory/office-templates/:
//   <id>.docx | <id>.xlsx   the form itself
//   <id>.json               { id, name, format, size, uploadedAt }
// A team's document refers to a form by id; agents get its absolute path.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import JSZip from "jszip";
import { getOpenRigHome } from "../../../openrig-compat.js";

export type OfficeFormat = "docx" | "xlsx";

export interface OfficeTemplate {
  id: string;
  name: string;
  format: OfficeFormat;
  size: number;
  uploadedAt: string;
}

export class OfficeTemplateError extends Error {
  constructor(readonly status: 400 | 404 | 413, readonly code: string, message: string) {
    super(message);
  }
}

export const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{2,80}$/;

export function officeTemplatesDir(home = getOpenRigHome()): string {
  return path.join(home, "factory", "office-templates");
}

export function officeFormatOf(fileName: string): OfficeFormat | null {
  if (/\.docx$/i.test(fileName)) return "docx";
  if (/\.xlsx$/i.test(fileName)) return "xlsx";
  return null;
}

function slugify(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d")
    .replace(/\.(docx|xlsx)$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "form";
}

export class OfficeTemplateStore {
  constructor(private readonly dir = officeTemplatesDir()) {}

  list(): OfficeTemplate[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.filter((n) => n.endsWith(".json"))
      .map((n) => this.meta(n.slice(0, -5)))
      .filter((t): t is OfficeTemplate => !!t)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private meta(id: string): OfficeTemplate | null {
    if (!ID.test(id)) return null;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8")) as OfficeTemplate;
      if (m.id !== id || (m.format !== "docx" && m.format !== "xlsx")) return null;
      return fs.existsSync(path.join(this.dir, `${id}.${m.format}`)) ? m : null;
    } catch { return null; }
  }

  get(id: string): OfficeTemplate | null {
    return this.meta(id);
  }

  /** Absolute path of the form file, or null when it doesn't exist. */
  filePath(id: string): string | null {
    const m = this.meta(id);
    return m ? path.join(this.dir, `${id}.${m.format}`) : null;
  }

  read(id: string): { meta: OfficeTemplate; content: Buffer } {
    const meta = this.meta(id);
    if (!meta) throw new OfficeTemplateError(404, "template_not_found", `No form "${id}"`);
    return { meta, content: fs.readFileSync(path.join(this.dir, `${id}.${meta.format}`)) };
  }

  async save(fileName: string, content: Buffer): Promise<OfficeTemplate> {
    const name = path.basename(fileName || "").trim();
    const format = officeFormatOf(name);
    if (!format) throw new OfficeTemplateError(400, "unsupported_format", "Upload a .docx (Word) or .xlsx (Excel) file. Save older .doc/.xls files in the new format first.");
    if (content.length === 0) throw new OfficeTemplateError(400, "empty_file", "The file is empty");
    if (content.length > MAX_TEMPLATE_BYTES) throw new OfficeTemplateError(413, "too_large", "Forms can be at most 10 MB");
    let zip: JSZip;
    try { zip = await JSZip.loadAsync(content); } catch { throw new OfficeTemplateError(400, "not_office", `${name} isn't a valid ${format === "docx" ? "Word" : "Excel"} file`); }
    const marker = format === "docx" ? "word/document.xml" : "xl/workbook.xml";
    if (!zip.file(marker)) throw new OfficeTemplateError(400, "not_office", `${name} isn't a valid ${format === "docx" ? "Word" : "Excel"} file`);

    fs.mkdirSync(this.dir, { recursive: true });
    const id = `${slugify(name)}-${randomBytes(3).toString("hex")}`;
    const meta: OfficeTemplate = { id, name, format, size: content.length, uploadedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(this.dir, `${id}.${format}`), content);
    fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(meta, null, 2) + "\n");
    return meta;
  }

  remove(id: string): void {
    const meta = this.meta(id);
    if (!meta) throw new OfficeTemplateError(404, "template_not_found", `No form "${id}"`);
    fs.rmSync(path.join(this.dir, `${id}.${meta.format}`), { force: true });
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
  }
}
