// Settings (/settings) — the Anthropic API key, base URL and model every agent runs on.
import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, PlugZap, Save, Server, Trash2, XCircle } from "lucide-react";
import {
  SettingsError, useAgentApiSettings, useClearAgentApiKey, useSaveAgentApiSettings, useTestAgentApi, type AgentApiSettings,
} from "../../hooks/useAgentApiSettings.js";
import { Alert, Button, Field, Page, PageHeader, Panel, Pill, TextInput } from "../factory/fields.js";

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"];

function SourcePill({ s }: { s: AgentApiSettings }) {
  if (s.source === "settings") return <Pill tone="success" dot>Key ••••{s.keyHint} saved here</Pill>;
  if (s.source === "environment") return <Pill tone="info" dot>Key ••••{s.keyHint} from the daemon's environment</Pill>;
  return <Pill tone="danger" dot>No API key</Pill>;
}

export function SettingsPage() {
  const { data, isLoading, error } = useAgentApiSettings();
  const save = useSaveAgentApiSettings();
  const clear = useClearAgentApiKey();
  const test = useTestAgentApi();

  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  // Fill the form once with what is saved; the environment's values show as placeholders.
  useEffect(() => {
    if (!data || loaded) return;
    setBaseUrl(data.saved.baseUrl ?? "");
    setModel(data.saved.model ?? "");
    setLoaded(true);
  }, [data, loaded]);

  const saveError = save.error instanceof SettingsError ? save.error : null;
  const fieldError = (f: string) => (saveError?.field === f ? <span className="text-[color:var(--fx-danger)]">{saveError.message}</span> : null);
  const dirty = !!data && (apiKey.trim() !== "" || baseUrl.trim() !== (data.saved.baseUrl ?? "") || model.trim() !== (data.saved.model ?? ""));

  const onSave = () => {
    setSaved(false);
    test.reset();
    save.mutate(
      { ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), baseUrl: baseUrl.trim(), model: model.trim() },
      { onSuccess: () => { setApiKey(""); setShowKey(false); setSaved(true); } },
    );
  };

  return (
    <Page testId="settings-page" width={880}>
      <PageHeader
        eyebrow="Settings"
        title="Agent API"
        subtitle="Every agent runs on Claude Code with this Anthropic API key, base URL and model. Claude or Codex sign-ins on this machine aren't used."
      />

      {error ? (
        <Alert tone="danger" icon={<AlertCircle />} title="Could not load settings">{(error as Error).message}</Alert>
      ) : isLoading || !data ? (
        <p className="fx-small">Loading settings…</p>
      ) : (
        <div className="flex flex-col gap-5">
          {!data.hasKey ? (
            <Alert tone="warning" icon={<KeyRound />} title="Add an API key to start teams" testId="settings-no-key">
              Teams can't start until agents have a key. Paste one below, or start the daemon with <code>ANTHROPIC_API_KEY</code> set.
            </Alert>
          ) : null}

          <Panel
            title="Connection"
            actions={<SourcePill s={data} />}
            testId="settings-agent-api"
          >
            <div className="flex flex-col gap-4">
              <Field
                label="ANTHROPIC_API_KEY"
                hint={
                  <>
                    {fieldError("apiKey") ?? (data.hasKey
                      ? "Leave empty to keep the current key. The key is stored privately on this machine (file mode 0600) and never shown again."
                      : "Starts with sk-ant-… for Anthropic, or your gateway's key.")}
                  </>
                }
              >
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--fx-subtle)]" />
                    <TextInput
                      data-testid="settings-api-key"
                      type={showKey ? "text" : "password"}
                      autoComplete="off"
                      spellCheck={false}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={data.hasKey ? `••••••••••••${data.keyHint}  (type a new key to replace it)` : "sk-ant-api03-…"}
                      className="fx-mono pl-9"
                    />
                  </div>
                  <Button size="icon" variant="ghost" aria-label={showKey ? "Hide key" : "Show key"} onClick={() => setShowKey((v) => !v)}>
                    {showKey ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
              </Field>

              <Field
                label="ANTHROPIC_BASE_URL"
                hint={fieldError("baseUrl") ?? "Optional. Leave empty for Anthropic's API; set it for a gateway or proxy."}
              >
                <div className="relative">
                  <Server className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--fx-subtle)]" />
                  <TextInput
                    data-testid="settings-base-url"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={data.environment.baseUrl ?? "https://api.anthropic.com"}
                    className="fx-mono pl-9"
                    spellCheck={false}
                  />
                </div>
              </Field>

              <Field
                label="ANTHROPIC_MODEL"
                hint={fieldError("model") ?? "Optional. The model every agent uses. Leave empty for Claude Code's default."}
              >
                <TextInput
                  data-testid="settings-model"
                  list="settings-models"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={data.environment.model ?? "claude-sonnet-5-5"}
                  className="fx-mono"
                  spellCheck={false}
                />
                <datalist id="settings-models">
                  {MODELS.map((m) => <option key={m} value={m} />)}
                </datalist>
              </Field>

              {save.error && !saveError?.field ? (
                <Alert tone="danger" icon={<AlertCircle />} title="Not saved">{(save.error as Error).message}</Alert>
              ) : null}

              <div className="fx-divider flex flex-wrap items-center gap-2 pt-4">
                <Button variant="primary" onClick={onSave} disabled={!dirty || save.isPending} data-testid="settings-save">
                  <Save /> {save.isPending ? "Saving…" : "Save"}
                </Button>
                <Button onClick={() => test.mutate()} disabled={!data.hasKey || test.isPending || dirty} data-testid="settings-test"
                  title={dirty ? "Save first, then test" : undefined}>
                  <PlugZap /> {test.isPending ? "Testing…" : "Test connection"}
                </Button>
                {data.source === "settings" ? (
                  <Button variant="ghost" className="ml-auto" disabled={clear.isPending}
                    onClick={() => { if (window.confirm(data.environment.hasKey ? "Remove the saved key? Agents will use the daemon's ANTHROPIC_API_KEY instead." : "Remove the saved key? Teams can't start until you add one again.")) clear.mutate(); }}>
                    <Trash2 /> Remove saved key
                  </Button>
                ) : null}
              </div>

              {saved && !dirty ? (
                <p className="fx-small inline-flex items-center gap-1.5" data-testid="settings-saved" style={{ color: "var(--fx-success)" }}>
                  <CheckCircle2 className="h-4 w-4" /> Saved. Agents started from now on use these values.
                </p>
              ) : null}
              {test.data ? (
                <p data-testid="settings-test-result" className="inline-flex items-start gap-1.5 text-[13px]"
                  style={{ color: test.data.ok ? "var(--fx-success)" : "var(--fx-danger)" }}>
                  {test.data.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                  {test.data.message}
                </p>
              ) : null}
              {test.error ? <p className="text-[13px] text-[color:var(--fx-danger)]">{(test.error as Error).message}</p> : null}
            </div>
          </Panel>

          <Panel title="How agents use it" testId="settings-how">
            <ul className="fx-small flex list-disc flex-col gap-1.5 pl-5">
              <li>Values saved here win. Empty fields fall back to the daemon's own environment variables{data.environment.hasKey || data.environment.baseUrl || data.environment.model ? (
                <> (found: {[data.environment.hasKey && "ANTHROPIC_API_KEY", data.environment.baseUrl && "ANTHROPIC_BASE_URL", data.environment.model && "ANTHROPIC_MODEL"].filter(Boolean).join(", ")})</>
              ) : " (none set)"}.</li>
              <li>Every team member runs on Claude Code with this model. Codex and per-member models aren't used.</li>
              <li>Agents already running keep their old values. Stop and start the task to switch.</li>
              <li>Usage is billed to this API key, not to a Claude subscription.</li>
            </ul>
          </Panel>
        </div>
      )}
    </Page>
  );
}
