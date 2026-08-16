import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, FormField, Input, Textarea, Button } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import CmsTabState from "./CmsTabState";

/**
 * About Us (Phase 28). Migrates legacy cmsRenderAbout()/cmsSaveAbout() —
 * same PATCH /api/settings/about contract (multipart when an image is
 * attached, JSON otherwise).
 */
export default function CmsAboutTab({ cms }) {
  const tab = cms.tabs.about;
  const toast = useToast();

  const [eyebrow, setEyebrow] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const imageRef = useRef(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (tab.status !== "ready") return;
    setEyebrow(tab.data.about.eyebrow || "");
    setTitle(tab.data.about.title || "");
    setBody(tab.data.about.body || "");
  }, [tab.status, tab.data]);

  async function handleSave() {
    setSaving(true);
    try {
      await cms.saveAbout({
        eyebrow: eyebrow.trim(),
        title: title.trim(),
        body: body.trim(),
        image: imageRef.current?.files?.[0] || null,
      });
      if (imageRef.current) imageRef.current.value = "";
      toast.success("Saved.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <CmsTabState tab={tab} loadingLabel="Loading About Us content…" forbiddenDescription="Landing Page CMS is limited to administrators." onRetry={() => cms.reload("about")}>
      {(data) => (
        <Card>
          <CardHeader title="About Us" />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FormField label="Eyebrow">
              <Input value={eyebrow} onChange={(e) => setEyebrow(e.target.value)} />
            </FormField>
            <FormField label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </FormField>
            <FormField label="Body">
              <Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
            </FormField>
            <FormField label="Image (optional)">
              <input ref={imageRef} type="file" accept="image/*" />
            </FormField>
            {data.about.imagePath && <img src={data.about.imagePath} alt="" style={{ width: 120, borderRadius: 8, display: "block" }} />}
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
