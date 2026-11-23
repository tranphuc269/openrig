// Get ready (/setup) — everything a team needs to run on this machine, with quick fixes.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle, ArrowRight, CheckCircle2, CircleDashed, Copy, Power, RefreshCw, Rocket, TriangleAlert, UserPlus, XCircle } from "lucide-react";
import { useEnableUsageWindows } from "../../hooks/useUsageCost.js";
import { useCheckSignIn, useReadiness, useRegisterPerson, type ReadinessCheck } from "../../hooks/useReadiness.js";
import { toSlug } from "../../hooks/useFactory.js";
import { Alert, Button, Field, Page, PageHeader, Pill, TextInput } from "../factory/fields.js";

const ICON = {
  ok: <CheckCircle2 className="h-5 w-5" style={{ color: "var(--fx-success)" }} />,
  warn: <TriangleAlert className="h-5 w-5" style={{ color: "var(--fx-warning)" }} />,
  fail: <XCircle className="h-5 w-5" style={{ color: "var(--fx-danger)" }} />,
  unknown: <CircleDashed className="h-5 w-5" style={{ color: "var(--fx-subtle)" }} />,
};

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fx-inset flex items-center gap-2 py-1.5 pl-3 pr-1.5">
      <code className="fx-mono min-w-0 flex-1 truncate !bg-transparent !p-0 text-[12.5px]">{command}</code>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void navigator.clipboard?.writeText(command.replace(/\s+#.*$/, "")).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <Copy /> {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function RegisterPerson() {
  const register = useRegisterPerson();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  return (
    <div className="mt-3 flex flex-col gap-3" data-testid="setup-register-person">
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <Field label="Your name">
          <TextInput
            value={name}
            placeholder="Linh Nguyen"
            onChange={(e) => {
              setName(e.target.value);
              if (!idTouched) setId(toSlug(e.target.value.split(" ").pop() ?? "").slice(0, 32));
            }}
          />
        </Field>
        <Field label="Short id" hint="Agents address you as id@external.">
          <TextInput value={id} className="fx-mono" onChange={(e) => { setIdTouched(true); setId(toSlug(e.target.value).slice(0, 32)); }} placeholder="linh" />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" disabled={!name.trim() || !id || register.isPending} onClick={() => register.mutate({ entityId: id, displayName: name })}>
          <UserPlus /> {register.isPending ? "Registering…" : "Register me"}
        </Button>
        {register.error ? <span className="text-[13px] text-[color:var(--fx-danger)]">{(register.error as Error).message}</span> : null}
      </div>
    </div>
  );
}

function CheckRow({ check }: { check: ReadinessCheck }) {
  const enable = useEnableUsageWindows();
  const signIn = useCheckSignIn();
  const [open, setOpen] = useState(false);
  const needsFix = check.state !== "ok";
  return (
    <li data-testid={`setup-check-${check.id}`} className="flex gap-3 border-b border-[color:var(--fx-border)] px-5 py-4 last:border-0">
      <span className="mt-0.5 shrink-0">{ICON[check.state]}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="fx-h3">{check.title}</span>
          {check.required ? <Pill tone={check.state === "ok" ? "neutral" : "danger"}>Required</Pill> : <Pill>Recommended</Pill>}
        </div>
        <p className="fx-small mt-0.5 break-words">{check.detail}</p>

        {needsFix ? (
          <div className="mt-2 flex flex-col gap-2">
            {check.fixAction === "enable-usage" ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" onClick={() => enable.mutate()} disabled={enable.isPending || enable.isSuccess}>
                  <Power /> {enable.isSuccess ? "Turned on" : "Turn on tracking"}
                </Button>
                {enable.isSuccess ? <span className="fx-small">Restart the daemon to apply: <code>rig daemon stop</code> then <code>rig daemon start</code></span> : null}
                {enable.error ? <span className="text-[13px] text-[color:var(--fx-danger)]">{(enable.error as Error).message}</span> : null}
              </div>
            ) : null}
            {check.fixAction === "check-sign-in" ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
                  <RefreshCw className={signIn.isPending ? "animate-spin" : undefined} /> {signIn.isPending ? "Checking… (up to a minute)" : "Check now"}
                </Button>
                {signIn.error ? <span className="text-[13px] text-[color:var(--fx-danger)]">{(signIn.error as Error).message}</span> : null}
              </div>
            ) : null}
            {check.fixAction === "register-person" ? <RegisterPerson /> : null}
            {check.fixCommand && check.fixAction !== "register-person" ? (
              open || !check.fixAction ? (
                <div className="flex flex-col gap-1">
                  <span className="fx-tiny">Run in a terminal:</span>
                  <CopyCommand command={check.fixCommand} />
                </div>
              ) : (
                <button type="button" className="fx-link self-start text-[12.5px]" onClick={() => setOpen(true)}>Or fix it in a terminal</button>
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function SetupPage() {
  const { data, isLoading, error, refetch, isFetching } = useReadiness();
  const checks = data?.checks ?? [];
  const required = checks.filter((c) => c.required);
  const done = checks.filter((c) => c.state === "ok").length;
  const order = (c: ReadinessCheck) => (c.state === "ok" ? 3 : c.required ? 0 : c.state === "fail" ? 1 : 2);
  const sorted = [...checks].sort((a, b) => order(a) - order(b));

  return (
    <Page testId="setup-page" width={880}>
      <PageHeader
        eyebrow="Get ready"
        title="Is everything ready?"
        subtitle="What this machine needs before a team of agents can run. Fix the required items; the recommended ones make work smoother."
        actions={
          <Button onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={isFetching ? "animate-spin" : undefined} /> Check again
          </Button>
        }
      />

      {error ? (
        <Alert tone="danger" icon={<AlertCircle />} title="Could not run the checks">{(error as Error).message}</Alert>
      ) : isLoading ? (
        <p className="fx-small">Checking this machine…</p>
      ) : data ? (
        <>
          <div className="fx-card mb-5 flex flex-wrap items-center gap-4 p-5" data-testid="setup-summary">
            <span className="fx-empty-icon h-12 w-12" style={data.ready ? { background: "var(--fx-success-soft)", color: "var(--fx-success)" } : undefined}>
              {data.ready ? <Rocket /> : <TriangleAlert />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="fx-h2">{data.ready ? "Ready to run a team" : `${required.filter((c) => c.state !== "ok").length} required item(s) to fix`}</div>
              <div className="fx-small">{done} of {checks.length} checks pass</div>
              <div className="fx-progress mt-2 max-w-[360px]">
                <span style={{ width: `${checks.length ? (done / checks.length) * 100 : 0}%`, background: data.ready ? "var(--fx-success)" : "var(--fx-primary)" }} />
              </div>
            </div>
            {data.ready ? (
              <Link to="/studio" className="fx-btn fx-btn-primary">Build a team <ArrowRight /></Link>
            ) : null}
          </div>
          <ul className="fx-card" data-testid="setup-checks">
            {sorted.map((c) => <CheckRow key={c.id} check={c} />)}
          </ul>
        </>
      ) : null}
    </Page>
  );
}

/** One-line nudge for Studio and Workspace when something required is missing. */
export function ReadinessBanner() {
  const { data } = useReadiness();
  if (!data || data.ready) return null;
  const missing = data.checks.filter((c) => c.required && c.state !== "ok");
  return (
    <div className="mb-5" data-testid="readiness-banner">
      <Alert tone="warning" icon={<TriangleAlert />} title={`${missing.length} thing(s) to set up before a team can run`}>
        {missing.map((c) => c.title).join(", ")}. <Link to="/setup" className="font-semibold underline">Open Get ready</Link>
      </Alert>
    </div>
  );
}
