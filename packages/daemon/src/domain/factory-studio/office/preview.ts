// Workspace preview of Word and Excel documents.

import mammoth from "mammoth";
import { previewXlsx, type XlsxPreviewSheet } from "./xlsx.js";

export type OfficePreview =
  | { kind: "docx"; html: string; messages: string[] }
  | { kind: "xlsx"; sheets: XlsxPreviewSheet[] };

/** Word → HTML (rendered by the UI in a sandboxed frame), Excel → cells. */
export async function previewOffice(fileName: string, content: Buffer): Promise<OfficePreview> {
  if (/\.docx$/i.test(fileName)) {
    try {
      const result = await mammoth.convertToHtml({ buffer: content }, {
        styleMap: ["p[style-name='Title'] => h1.title:fresh"],
      });
      return { kind: "docx", html: result.value, messages: result.messages.filter((m) => m.type === "error").map((m) => m.message).slice(0, 5) };
    } catch {
      throw new Error("This Word file can't be opened. It may still be being written, or it isn't a valid .docx.");
    }
  }
  if (/\.xlsx$/i.test(fileName)) {
    return { kind: "xlsx", sheets: await previewXlsx(content) };
  }
  throw new Error("Only .docx and .xlsx files have a preview");
}
