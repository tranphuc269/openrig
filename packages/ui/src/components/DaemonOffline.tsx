// Shown over the app when the daemon doesn't answer /healthz: a calm explanation and the command to start it,
// instead of empty pages and error toasts. It keeps checking and disappears by itself once the daemon is back.
import { useEffect, useState } from "react";
import { Copy, Loader2, PlugZap } from "lucide-react";

const START = "rig daemon start";

export function DaemonOffline({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const [copied, setCopied] = useState(false);
  const [seconds, setSeconds] = useState(10);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => (s <= 1 ? 10 : s - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      data-testid="daemon-offline"
      role="alertdialog"
      aria-labelledby="daemon-offline-title"
      className="fx fixed inset-0 z-[2000] flex items-center justify-center p-6"
      style={{ background: "color-mix(in srgb, var(--fx-bg) 88%, transparent)", backdropFilter: "blur(6px)" }}
    >
      <div className="fx-card w-full max-w-[460px] p-7 text-center" style={{ boxShadow: "var(--fx-shadow-lg)" }}>
        <span className="fx-empty-icon mx-auto h-14 w-14 rounded-2xl"><PlugZap className="!h-7 !w-7" /></span>
        <h1 id="daemon-offline-title" className="fx-h1 mt-4 !text-[22px]">OpenRig isn't running</h1>
        <p className="fx-sub mt-2">
          This page talks to the OpenRig daemon on your computer, and it isn't answering. Start it in a terminal:
        </p>
        <div className="fx-inset mt-4 flex items-center gap-2 py-2 pl-3 pr-2 text-left">
          <code className="fx-mono min-w-0 flex-1 !bg-transparent !p-0 text-[13px]">{START}</code>
          <button
            type="button"
            className="fx-btn fx-btn-ghost fx-btn-sm"
            onClick={() => void navigator.clipboard?.writeText(START).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
          >
            <Copy /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="fx-tiny mt-3">
          Running from a source checkout? Use <code>node packages/cli/dist/bin-wrapper.js daemon start</code>.
          If it was running a moment ago, it may be restarting.
        </p>
        <div className="mt-5 flex items-center justify-center gap-3">
          <button type="button" className="fx-btn fx-btn-primary" onClick={onRetry} disabled={retrying}>
            {retrying ? <Loader2 className="animate-spin" /> : null} {retrying ? "Checking…" : "Try again"}
          </button>
          <span className="fx-tiny">Checking again in {seconds}s</span>
        </div>
      </div>
    </div>
  );
}
