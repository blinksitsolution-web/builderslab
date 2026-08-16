import { useEffect, useState } from "react";
import { Card, CardHeader, FormField, Input, Select, Button, Badge, Alert, LoadingState, ErrorState, UnauthorizedState } from "../../components/ui";
import { useToast } from "../../context/ToastContext";

const AI_PROVIDERS = [
  { id: "groq", label: "Groq" },
  { id: "anthropic", label: "Anthropic" },
  { id: "ollama", label: "Ollama (local)" },
];

/**
 * API Keys (Phase 27, Super Administrator only). Migrates legacy
 * settingsApiKeys()/saveApiKeys()/testAiConnection() — same
 * GET/PATCH /api/settings/api-keys and
 * POST /api/settings/api-keys/test-connection contracts, both gated by
 * requireSuperAdmin on the backend regardless of this tab only being
 * shown to Super Administrators client-side (see useAdminSettings.js).
 *
 * AI provider keys arrive already masked (apiKeyMasked) — the real key is
 * never sent to the browser. A blank "new key" field on save means "leave
 * the existing key unchanged", matching the backend's own semantics.
 */
export default function SettingsApiKeysTab({ settings }) {
  const tab = settings.tabs.apiKeys;
  const toast = useToast();

  const [paystackKey, setPaystackKey] = useState("");
  const [activeAiProvider, setActiveAiProvider] = useState("groq");
  const [providerForm, setProviderForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(null);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    if (tab.status !== "ready") return;
    const keys = tab.data.apiKeys;
    setPaystackKey(keys.paystackKey || "");
    setActiveAiProvider(keys.activeAiProvider || "groq");
    setProviderForm({
      groq: { apiKey: "", model: keys.groq?.model || "" },
      anthropic: { apiKey: "", model: keys.anthropic?.model || "" },
      ollama: { apiKey: "", model: keys.ollama?.model || "", baseUrl: keys.ollama?.baseUrl || "" },
    });
  }, [tab.status, tab.data]);

  if (tab.status === "loading" || tab.status === "idle") return <LoadingState label="Loading API keys…" />;
  if (tab.status === "forbidden") return <UnauthorizedState description="API Keys are limited to Super Administrators." />;
  if (tab.status === "error") return <ErrorState description={tab.error} action={{ label: "Try again", onClick: () => settings.reload("apiKeys") }} />;

  const keys = tab.data.apiKeys;

  function setField(providerId, field, value) {
    setProviderForm((current) => ({ ...current, [providerId]: { ...current[providerId], [field]: value } }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await settings.saveApiKeys({
        paystackKey: paystackKey.trim(),
        activeAiProvider,
        groq: { apiKey: providerForm.groq.apiKey.trim(), model: providerForm.groq.model.trim() },
        anthropic: { apiKey: providerForm.anthropic.apiKey.trim(), model: providerForm.anthropic.model.trim() },
        ollama: { model: providerForm.ollama.model.trim(), baseUrl: providerForm.ollama.baseUrl.trim() },
      });
      toast.success("API keys saved.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(providerId) {
    setTesting(providerId);
    setTestResult(null);
    try {
      const result = await settings.testConnection(providerId);
      setTestResult({ providerId, ok: true, message: `${result.provider}: connection OK.` });
    } catch (e) {
      setTestResult({ providerId, ok: false, message: e.message });
    } finally {
      setTesting(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Alert variant="warning" title="Sensitive credentials">
        These keys are encrypted at rest and never fully displayed once saved. Leave a key field blank to keep the existing one unchanged.
      </Alert>

      <Card>
        <CardHeader title="Paystack" subtitle="Used for online fee payments." />
        <FormField label="Paystack secret key">
          <Input type="password" value={paystackKey} onChange={(e) => setPaystackKey(e.target.value)} autoComplete="off" />
        </FormField>
      </Card>

      <Card>
        <CardHeader title="AI provider" subtitle="Used for AI-assisted features (e.g. quiz generation)." />
        <FormField label="Active provider">
          <Select value={activeAiProvider} onChange={(e) => setActiveAiProvider(e.target.value)}>
            {AI_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </FormField>

        {AI_PROVIDERS.map((p) => (
          <div key={p.id} style={{ borderTop: "1px solid var(--border, #e5ddd0)", paddingTop: 12, marginTop: 12 }}>
            <h4 style={{ margin: "0 0 8px", display: "flex", alignItems: "center", gap: 8 }}>
              {p.label}
              {activeAiProvider === p.id && <Badge tone="success">Active</Badge>}
            </h4>
            {p.id !== "ollama" && (
              <>
                <p style={{ fontSize: ".82rem", opacity: 0.7, margin: "0 0 6px" }}>Current key: {keys[p.id]?.apiKeyMasked || "not set"}</p>
                <FormField label="New API key (leave blank to keep current)">
                  <Input type="password" value={providerForm[p.id]?.apiKey || ""} onChange={(e) => setField(p.id, "apiKey", e.target.value)} autoComplete="off" />
                </FormField>
              </>
            )}
            {p.id === "ollama" && (
              <FormField label="Base URL">
                <Input value={providerForm.ollama?.baseUrl || ""} onChange={(e) => setField("ollama", "baseUrl", e.target.value)} placeholder="http://localhost:11434" />
              </FormField>
            )}
            <FormField label="Model">
              <Input value={providerForm[p.id]?.model || ""} onChange={(e) => setField(p.id, "model", e.target.value)} />
            </FormField>
            <Button variant="ghost" size="sm" onClick={() => handleTest(p.id)} loading={testing === p.id}>
              Test connection
            </Button>
            {testResult && testResult.providerId === p.id && (
              <Alert variant={testResult.ok ? "success" : "danger"} className="animate-fade-in">
                {testResult.message}
              </Alert>
            )}
          </div>
        ))}

        <div style={{ marginTop: 16 }}>
          <Button onClick={handleSave} loading={saving}>
            Save API keys
          </Button>
        </div>
      </Card>
    </div>
  );
}
