import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, FormField, Input, Button, LoadingState, ErrorState, UnauthorizedState } from "../../components/ui";
import { useToast } from "../../context/ToastContext";

/**
 * Branding (Phase 27). Migrates legacy settingsBranding()/saveLogo()/
 * saveSignature() — same POST /api/settings/branding/logo,
 * POST /api/settings/branding/signature, and PATCH /api/settings/branding
 * (adminSignatureName) contracts.
 */
export default function SettingsBrandingTab({ settings }) {
  const tab = settings.tabs.branding;
  const toast = useToast();

  const logoInputRef = useRef(null);
  const sigInputRef = useRef(null);
  const [sigName, setSigName] = useState("");
  const [savingLogo, setSavingLogo] = useState(false);
  const [savingSignature, setSavingSignature] = useState(false);

  useEffect(() => {
    if (tab.status === "ready") setSigName(tab.data.branding?.adminSignatureName || "");
  }, [tab.status, tab.data]);

  if (tab.status === "loading" || tab.status === "idle") return <LoadingState label="Loading branding…" />;
  if (tab.status === "forbidden") return <UnauthorizedState description="Branding is limited to administrators with Site Settings access." />;
  if (tab.status === "error") return <ErrorState description={tab.error} action={{ label: "Try again", onClick: () => settings.reload("branding") }} />;

  const branding = tab.data.branding || {};

  async function handleSaveLogo() {
    const file = logoInputRef.current?.files?.[0];
    if (!file) return toast.error("Choose a file first.");
    setSavingLogo(true);
    try {
      await settings.saveLogo(file);
      logoInputRef.current.value = "";
      toast.success("Logo updated.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingLogo(false);
    }
  }

  async function handleSaveSignature() {
    setSavingSignature(true);
    try {
      await settings.saveSignature({ file: sigInputRef.current?.files?.[0] || null, adminSignatureName: sigName });
      if (sigInputRef.current) sigInputRef.current.value = "";
      toast.success("Signature settings saved.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingSignature(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card>
        <CardHeader title="Logo" />
        {branding.logoPath && (
          <img src={branding.logoPath} alt="Current logo" style={{ width: 80, height: 80, borderRadius: 10, objectFit: "cover", marginBottom: 10 }} />
        )}
        <FormField label="Upload new logo">
          <input ref={logoInputRef} type="file" accept="image/*" />
        </FormField>
        <div style={{ marginTop: 12 }}>
          <Button onClick={handleSaveLogo} loading={savingLogo}>
            Upload logo
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Admin signature (appears on transcripts)" />
        {branding.signaturePath && <img src={branding.signaturePath} alt="Current signature" style={{ height: 50, marginBottom: 10 }} />}
        <FormField label="Upload signature image">
          <input ref={sigInputRef} type="file" accept="image/*" />
        </FormField>
        <FormField label="Name shown under signature">
          <Input value={sigName} onChange={(e) => setSigName(e.target.value)} />
        </FormField>
        <div style={{ marginTop: 12 }}>
          <Button onClick={handleSaveSignature} loading={savingSignature}>
            Save signature
          </Button>
        </div>
      </Card>
    </div>
  );
}
