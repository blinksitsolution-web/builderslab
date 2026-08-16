import { useEffect, useState } from "react";
import { Card, CardHeader, FormField, Input, Select, Checkbox, Button } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import CmsTabState from "./CmsTabState";

/**
 * Enrol Button (Phase 28). Migrates legacy cmsRenderEnrolButton()/
 * cmsSaveEnrolButton() — same PATCH /api/settings/enrol-button contract.
 * Controls the header, hero and closing-banner Enrol buttons only; each
 * Featured Learning Offering card has its own Enrol button, configured
 * separately under Learning Offering Types (out of scope here, unchanged).
 */
export default function CmsEnrolButtonTab({ cms }) {
  const tab = cms.tabs.enrolButton;
  const toast = useToast();

  const [text, setText] = useState("Enrol now");
  const [targetOfferingSlug, setTargetOfferingSlug] = useState("");
  const [openBehavior, setOpenBehavior] = useState("same_tab");
  const [visible, setVisible] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (tab.status !== "ready") return;
    const eb = tab.data.enrolButton || {};
    setText(eb.text || "Enrol now");
    setTargetOfferingSlug(eb.targetOfferingSlug || "");
    setOpenBehavior(eb.openBehavior || "same_tab");
    setVisible(eb.visible !== false);
  }, [tab.status, tab.data]);

  async function handleSave() {
    setSaving(true);
    try {
      await cms.saveEnrolButton({ text: text.trim(), targetOfferingSlug, openBehavior, visible });
      toast.success("Saved.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <CmsTabState tab={tab} loadingLabel="Loading Enrol Button settings…" forbiddenDescription="Landing Page CMS is limited to administrators." onRetry={() => cms.reload("enrolButton")}>
      {(data) => (
        <Card>
          <CardHeader title="Enrol Button" subtitle="Controls the header, hero and closing-banner Enrol buttons. Each Featured Learning Offering card has its own Enrol button, configured in Learning Offering Types → Landing Page." />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FormField label="Button text">
              <Input value={text} onChange={(e) => setText(e.target.value)} />
            </FormField>
            <FormField label="Target Learning Offering">
              <Select value={targetOfferingSlug} onChange={(e) => setTargetOfferingSlug(e.target.value)}>
                {data.offerings.length === 0 && <option value="">— No Learning Offerings yet —</option>}
                {data.offerings.map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Opens in">
              <Select value={openBehavior} onChange={(e) => setOpenBehavior(e.target.value)}>
                <option value="same_tab">Same tab</option>
                <option value="new_tab">New tab</option>
              </Select>
            </FormField>
            <Checkbox label="Show Enrol button" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
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
