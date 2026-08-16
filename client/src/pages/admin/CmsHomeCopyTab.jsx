import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, FormField, Input, Textarea, Button } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import CmsTabState from "./CmsTabState";

const FIELD_IDS = [
  "statStripLeft",
  "statStripSecond",
  "statStripThird",
  "statStripFourth",
  "offeringsEyebrow",
  "offeringsTitle",
  "howItWorksEyebrow",
  "howItWorksTitle",
  "campusesEyebrow",
  "campusesTitle",
  "campusesBody",
  "storiesEyebrow",
  "storiesTitle",
  "newsEyebrow",
  "newsTitle",
  "ctaTitle",
  "ctaBody",
];

/**
 * Home Page Copy (Phase 28). Migrates legacy cmsRenderHome()/cmsSaveHome()
 * — same PATCH /api/settings/home contract (single free-form object, same
 * field names).
 */
export default function CmsHomeCopyTab({ cms }) {
  const tab = cms.tabs.home;
  const toast = useToast();
  const [fields, setFields] = useState(() => Object.fromEntries(FIELD_IDS.map((id) => [id, ""])));
  const [saving, setSaving] = useState(false);
  const howItWorksImageRef = useRef(null);

  useEffect(() => {
    if (tab.status !== "ready") return;
    const hm = tab.data.home || {};
    setFields(Object.fromEntries(FIELD_IDS.map((id) => [id, hm[id] || ""])));
  }, [tab.status, tab.data]);

  function setField(id, value) {
    setFields((current) => ({ ...current, [id]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload = {};
      FIELD_IDS.forEach((id) => {
        payload[id] = (fields[id] || "").trim();
      });
      payload.howItWorksImage = howItWorksImageRef.current?.files?.[0] || null;
      await cms.saveHome(payload);
      if (howItWorksImageRef.current) howItWorksImageRef.current.value = "";
      toast.success("Saved.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <CmsTabState tab={tab} loadingLabel="Loading home page copy…" forbiddenDescription="Landing Page CMS is limited to administrators." onRetry={() => cms.reload("home")}>
      {() => (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <p style={{ color: "var(--text-muted, #6b7280)", margin: 0 }}>Section eyebrows/titles shown across the Landing Page, plus the stat strip and closing call-to-action.</p>

          <Card>
            <CardHeader title="Stat strip" subtitle="4 cells, shown under About Us" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <FormField label='Cell 1 — format "Big text — small label"'>
                <Input value={fields.statStripLeft} onChange={(e) => setField("statStripLeft", e.target.value)} />
              </FormField>
              <FormField label="Cell 2">
                <Input value={fields.statStripSecond} onChange={(e) => setField("statStripSecond", e.target.value)} />
              </FormField>
              <FormField label="Cell 3">
                <Input value={fields.statStripThird} onChange={(e) => setField("statStripThird", e.target.value)} />
              </FormField>
              <FormField label="Cell 4">
                <Input value={fields.statStripFourth} onChange={(e) => setField("statStripFourth", e.target.value)} />
              </FormField>
            </div>
          </Card>

          <Card>
            <CardHeader title="Section headings" />
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FormField label="Offerings eyebrow">
                  <Input value={fields.offeringsEyebrow} onChange={(e) => setField("offeringsEyebrow", e.target.value)} />
                </FormField>
                <FormField label="Offerings title">
                  <Input value={fields.offeringsTitle} onChange={(e) => setField("offeringsTitle", e.target.value)} />
                </FormField>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FormField label="How It Works eyebrow">
                  <Input value={fields.howItWorksEyebrow} onChange={(e) => setField("howItWorksEyebrow", e.target.value)} />
                </FormField>
                <FormField label="How It Works title">
                  <Input value={fields.howItWorksTitle} onChange={(e) => setField("howItWorksTitle", e.target.value)} />
                </FormField>
              </div>
              <FormField label="How It Works image">
                <input ref={howItWorksImageRef} type="file" accept="image/*" />
              </FormField>
              {tab.status === "ready" && tab.data.home?.howItWorksImagePath && (
                <img src={tab.data.home.howItWorksImagePath} alt="" style={{ width: 120, borderRadius: 8, display: "block" }} />
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FormField label="Campuses eyebrow">
                  <Input value={fields.campusesEyebrow} onChange={(e) => setField("campusesEyebrow", e.target.value)} />
                </FormField>
                <FormField label="Campuses title">
                  <Input value={fields.campusesTitle} onChange={(e) => setField("campusesTitle", e.target.value)} />
                </FormField>
              </div>
              <FormField label="Campuses body">
                <Textarea rows={2} value={fields.campusesBody} onChange={(e) => setField("campusesBody", e.target.value)} />
              </FormField>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FormField label="Stories eyebrow">
                  <Input value={fields.storiesEyebrow} onChange={(e) => setField("storiesEyebrow", e.target.value)} />
                </FormField>
                <FormField label="Stories title">
                  <Input value={fields.storiesTitle} onChange={(e) => setField("storiesTitle", e.target.value)} />
                </FormField>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FormField label="News eyebrow">
                  <Input value={fields.newsEyebrow} onChange={(e) => setField("newsEyebrow", e.target.value)} />
                </FormField>
                <FormField label="News title">
                  <Input value={fields.newsTitle} onChange={(e) => setField("newsTitle", e.target.value)} />
                </FormField>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Closing call-to-action" />
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <FormField label="Title">
                <Input value={fields.ctaTitle} onChange={(e) => setField("ctaTitle", e.target.value)} />
              </FormField>
              <FormField label="Body">
                <Textarea rows={2} value={fields.ctaBody} onChange={(e) => setField("ctaBody", e.target.value)} />
              </FormField>
            </div>
          </Card>

          <div>
            <Button onClick={handleSave} loading={saving}>
              Save changes
            </Button>
          </div>
        </div>
      )}
    </CmsTabState>
  );
}
