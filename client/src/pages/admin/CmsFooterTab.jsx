import { useEffect, useState } from "react";
import { Card, CardHeader, FormField, Input, Textarea, Button } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import CmsTabState from "./CmsTabState";

/**
 * Footer (Phase 28). Migrates legacy cmsRenderFooter()/cmsSaveFooter() —
 * same PATCH /api/settings/footer contract. Contact links and the campus
 * list in the footer come from Contact (this page's Hero & Contact tab)
 * and Campuses (Site Settings) — unchanged, not duplicated here.
 */
export default function CmsFooterTab({ cms }) {
  const tab = cms.tabs.footer;
  const toast = useToast();
  const [tagline, setTagline] = useState("");
  const [copyrightText, setCopyrightText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (tab.status !== "ready") return;
    const f = tab.data.footer || {};
    setTagline(f.tagline || "");
    setCopyrightText(f.copyrightText || "");
  }, [tab.status, tab.data]);

  async function handleSave() {
    setSaving(true);
    try {
      await cms.saveFooter({ tagline: tagline.trim(), copyrightText: copyrightText.trim() });
      toast.success("Saved.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <CmsTabState tab={tab} loadingLabel="Loading footer content…" forbiddenDescription="Landing Page CMS is limited to administrators." onRetry={() => cms.reload("footer")}>
      {() => (
        <Card>
          <CardHeader title="Footer" subtitle="Contact links and the campus list in the footer come from Contact (Hero & Contact tab) and Campuses — edit those there / in Site Settings." />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FormField label="Tagline">
              <Textarea rows={2} value={tagline} onChange={(e) => setTagline(e.target.value)} />
            </FormField>
            <FormField label="Copyright text">
              <Input value={copyrightText} onChange={(e) => setCopyrightText(e.target.value)} />
            </FormField>
          </div>
          <div style={{ marginTop: 12 }}>
            <Button onClick={handleSave} loading={saving}>
              Save changes
            </Button>
          </div>
        </Card>
      )}
    </CmsTabState>
  );
}
