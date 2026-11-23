// Project folder field: type a path, pick a recent project, or browse this computer's folders.
// Browsers can't hand a web page a real folder path, so browsing goes through the local daemon
// (GET /api/factory/fs/folders), which lists folder names only.
import { useEffect, useState } from "react";
import { ArrowUp, CheckCircle2, Clock, Folder, FolderGit2, FolderOpen, FolderPlus, Home, X, XCircle } from "lucide-react";
import { useCreateFolder, useFolderCheck, useFolders } from "../../hooks/useReadiness.js";
import { cn } from "../../lib/utils.js";
import { Button, Pill, TextInput } from "../factory/fields.js";

export function ProjectFolderField({ value, onChange, recent }: { value: string; onChange: (v: string) => void; recent: string[] }) {
  const [browsing, setBrowsing] = useState(false);
  const check = useFolderCheck(value);
  const c = check.data;
  const show = value.trim().length > 1 && c && c.path.replace(/\/$/, "") === value.trim().replace(/\/$/, "");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <FolderOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--fx-subtle)]" />
          <TextInput
            data-testid="workspace-project-dir"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="/Users/you/projects/clinic-booking"
            className="fx-mono pl-9"
          />
        </div>
        <Button onClick={() => setBrowsing(true)} data-testid="workspace-browse">
          <Folder /> Browse
        </Button>
      </div>

      {show ? (
        <div data-testid="workspace-folder-check" className="flex flex-wrap items-center gap-2 text-[13px]">
          {c.valid ? (
            <>
              <CheckCircle2 className="h-4 w-4" style={{ color: "var(--fx-success)" }} />
              <span style={{ color: "var(--fx-success)" }}>Looks good</span>
              {c.isGitRepo ? <Pill tone="info"><FolderGit2 className="h-3.5 w-3.5" /> Git repo</Pill> : null}
              {c.hasDocs ? <Pill>Has a docs folder</Pill> : null}
            </>
          ) : (
            <>
              <XCircle className="h-4 w-4" style={{ color: "var(--fx-danger)" }} />
              <span style={{ color: "var(--fx-danger)" }}>{c.reason}</span>
            </>
          )}
        </div>
      ) : null}

      {recent.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="fx-tiny inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> Recent:</span>
          {recent.slice(0, 5).map((p) => (
            <button
              key={p}
              type="button"
              title={p}
              onClick={() => onChange(p)}
              className={cn("fx-pill max-w-[260px] truncate hover:bg-[color:var(--fx-primary-soft)]", value === p && "fx-tone-primary")}
            >
              {p.split("/").filter(Boolean).slice(-2).join("/")}
            </button>
          ))}
        </div>
      ) : null}

      {browsing ? (
        <FolderBrowser
          start={value.trim().startsWith("/") ? value.trim() : null}
          onClose={() => setBrowsing(false)}
          onChoose={(p) => { onChange(p); setBrowsing(false); }}
        />
      ) : null}
    </div>
  );
}

function FolderBrowser({ start, onClose, onChoose }: { start: string | null; onClose: () => void; onChoose: (path: string) => void }) {
  const [path, setPath] = useState<string | null>(start);
  const listing = useFolders(path, true);
  const create = useCreateFolder();
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const data = listing.data;

  // A typed path that doesn't exist yet: fall back to home.
  useEffect(() => {
    if (listing.error && path !== null) setPath(null);
  }, [listing.error, path]);

  const crumbs = data ? data.path.split("/").filter(Boolean) : [];

  return (
    <div className="fx fixed inset-0 z-[1500] flex items-center justify-center p-4" style={{ background: "rgba(15, 18, 32, 0.35)" }} onClick={onClose}>
      <div
        role="dialog"
        aria-label="Choose a project folder"
        data-testid="folder-browser"
        className="fx-card flex max-h-[80vh] w-full max-w-[620px] flex-col overflow-hidden"
        style={{ boxShadow: "var(--fx-shadow-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="fx-card-head">
          <h2 className="fx-h2">Choose a project folder</h2>
          <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}><X /></Button>
        </header>

        <div className="flex items-center gap-1 border-b border-[color:var(--fx-border)] px-4 py-2">
          <Button size="icon" variant="ghost" aria-label="Home folder" onClick={() => setPath(null)}><Home /></Button>
          <Button size="icon" variant="ghost" aria-label="Up one folder" disabled={!data?.parent} onClick={() => data?.parent && setPath(data.parent)}><ArrowUp /></Button>
          <div className="fx-mono min-w-0 flex-1 truncate text-[12.5px]">
            {crumbs.map((c, i) => (
              <span key={i}>
                <span className="text-[color:var(--fx-subtle)]">/</span>
                <button type="button" className="hover:underline" onClick={() => setPath("/" + crumbs.slice(0, i + 1).join("/"))}>{c}</button>
              </span>
            ))}
          </div>
        </div>

        <ul className="min-h-[240px] flex-1 overflow-y-auto p-2" data-testid="folder-browser-list">
          {listing.isLoading ? <li className="fx-small p-3">Loading…</li> : null}
          {data && data.entries.length === 0 ? <li className="fx-small p-3">No folders here.</li> : null}
          {data?.entries.map((e) => (
            <li key={e.path}>
              <button type="button" className="fx-row" onClick={() => setPath(e.path)} onDoubleClick={() => onChoose(e.path)}>
                {e.isGitRepo ? <FolderGit2 className="h-4 w-4 shrink-0 text-[color:var(--fx-primary-text)]" /> : <Folder className="h-4 w-4 shrink-0 text-[color:var(--fx-subtle)]" />}
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{e.name}</span>
                {e.isGitRepo ? <span className="fx-tiny">git</span> : null}
              </button>
            </li>
          ))}
        </ul>

        {creating ? (
          <div className="flex items-center gap-2 border-t border-[color:var(--fx-border)] px-4 py-3">
            <TextInput autoFocus value={newName} onChange={(e) => setNewName(e.target.value.replace(/[/\\]/g, ""))} placeholder="new-project" className="fx-mono" />
            <Button
              size="sm"
              variant="primary"
              disabled={!newName.trim() || !data || create.isPending}
              onClick={() => data && create.mutate(`${data.path}/${newName.trim()}`, { onSuccess: (r) => onChoose(r.path) })}
            >
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        ) : null}
        {create.error ? <p className="px-4 pb-2 text-[13px] text-[color:var(--fx-danger)]">{(create.error as Error).message}</p> : null}

        <footer className="flex items-center gap-2 border-t border-[color:var(--fx-border)] px-4 py-3">
          {!creating ? (
            <Button size="sm" variant="ghost" onClick={() => setCreating(true)}><FolderPlus /> New folder</Button>
          ) : null}
          <span className="fx-tiny ml-auto hidden truncate sm:inline">{data?.path}</span>
          <Button variant="primary" disabled={!data} onClick={() => data && onChoose(data.path)} data-testid="folder-browser-choose">
            Use this folder
          </Button>
        </footer>
      </div>
    </div>
  );
}
