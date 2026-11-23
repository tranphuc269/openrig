// Word/Excel forms — client for /api/factory/office-templates.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type OfficeFormat = "docx" | "xlsx";

export interface OfficeTemplate {
  id: string;
  name: string;
  format: OfficeFormat;
  size: number;
  uploadedAt: string;
}

export interface OfficeTemplateInspection {
  format: OfficeFormat;
  docx?: { placeholders: string[]; styles: string[]; outline: Array<{ style: string | null; text: string }>; tables: number };
  xlsx?: {
    sheets: Array<{
      name: string;
      rows: number;
      columns: number;
      placeholders: string[];
      header: { row: number; cells: Array<{ address: string; text: string }> } | null;
      firstEmptyRow: number | null;
    }>;
  };
}

const KEY = ["office-templates"];
const BASE = "/api/factory/office-templates";

async function check<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  return body;
}

export function deliverableFormat(path: string): "markdown" | OfficeFormat | "other" {
  if (/\.docx$/i.test(path)) return "docx";
  if (/\.xlsx$/i.test(path)) return "xlsx";
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  return "other";
}

/** The same path with the extension of the chosen format. */
export function pathWithFormat(path: string, format: "markdown" | OfficeFormat): string {
  const ext = format === "markdown" ? "md" : format;
  const base = path.replace(/\.(md|markdown|docx|xlsx|txt)$/i, "");
  return `${base || "docs/document"}.${ext}`;
}

export function templateFileUrl(id: string): string {
  return `${BASE}/${encodeURIComponent(id)}`;
}

export function useOfficeTemplates() {
  return useQuery({ queryKey: KEY, queryFn: () => fetch(BASE).then((r) => check<OfficeTemplate[]>(r)) });
}

export function useOfficeTemplateInspection(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, "inspect", id],
    enabled: !!id,
    staleTime: 60_000,
    retry: false,
    queryFn: () => fetch(`${BASE}/${encodeURIComponent(id!)}/inspect`).then((r) => check<OfficeTemplateInspection>(r)),
  });
}

export function useUploadOfficeTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const res = await fetch(BASE, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
        body: file,
      });
      return check<OfficeTemplate>(res);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteOfficeTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetch(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => check<{ ok: true }>(r)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
