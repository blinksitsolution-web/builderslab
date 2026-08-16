import { useEffect, useRef, useState } from "react";
import { Card, Button, Badge, DataTable, Modal, FormField, Input, Textarea, Checkbox, ConfirmationDialog } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import CmsTabState from "./CmsTabState";

/**
 * How It Works steps (Phase 28). Migrates legacy cmsRenderHowItWorks()/
 * cmsLoadHowItWorksList()/cmsOpenHowItWorksModal()/
 * cmsSaveHowItWorksStep()/cmsDeleteHowItWorksStep() — same
 * /api/settings/how-it-works... contract, preserving display order and
 * active/hidden status.
 */
export default function CmsHowItWorksTab({ cms }) {
  const tab = cms.tabs.howItWorks;
  const toast = useToast();
  const [editorStep, setEditorStep] = useState(undefined); // undefined = closed, null = new, object = edit
  const [deleteTarget, setDeleteTarget] = useState(null);

  return (
    <CmsTabState tab={tab} loadingLabel="Loading How It Works steps…" forbiddenDescription="Landing Page CMS is limited to administrators." onRetry={() => cms.reload("howItWorks")}>
      {(data) => (
        <>
          <p style={{ color: "var(--text-muted, #6b7280)", marginTop: 0 }}>Steps shown in order in the Landing Page's "How enrolment works" section.</p>
          <Card padding={false}>
            <div style={{ padding: 16, display: "flex", justifyContent: "flex-end" }}>
              <Button size="sm" onClick={() => setEditorStep(null)}>
                + Add step
              </Button>
            </div>
            <DataTable
              columns={[
                {
                  key: "step",
                  header: "Step",
                  render: (s) => (
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {s.image_path && <img src={s.image_path} alt="" style={{ width: 40, height: 40, borderRadius: 6, objectFit: "cover" }} />}
                      <b>{s.icon}</b> {s.title}
                    </span>
                  ),
                },
                { key: "order", header: "Order", render: (s) => s.sort_order },
                { key: "status", header: "Status", render: (s) => <Badge tone={s.active ? "success" : "neutral"}>{s.active ? "Active" : "Hidden"}</Badge> },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  render: (s) => (
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <Button variant="ghost" size="sm" onClick={() => setEditorStep(s)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(s)}>
                        Delete
                      </Button>
                    </div>
                  ),
                },
              ]}
              rows={data.steps}
              getRowKey={(s) => s.id}
              emptyState={<div style={{ padding: 24, color: "var(--text-muted, #6b7280)" }}>No steps yet.</div>}
            />
          </Card>

          <HowItWorksModal step={editorStep} open={editorStep !== undefined} onClose={() => setEditorStep(undefined)} onSave={cms.saveHowItWorksStep} />

          <ConfirmationDialog
            open={!!deleteTarget}
            onClose={() => setDeleteTarget(null)}
            title="Delete step?"
            confirmLabel="Delete"
            confirmVariant="danger"
            onConfirm={async () => {
              try {
                await cms.removeHowItWorksStep(deleteTarget.id);
              } catch (e) {
                toast.error(e.message);
              }
            }}
          >
            Delete "{deleteTarget?.title}"? This can't be undone.
          </ConfirmationDialog>
        </>
      )}
    </CmsTabState>
  );
}

function HowItWorksModal({ step, open, onClose, onSave }) {
  const toast = useToast();
  const [icon, setIcon] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [active, setActive] = useState(true);
  const imageRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setIcon(step?.icon || "");
    setTitle(step?.title || "");
    setDescription(step?.description || "");
    setSortOrder(step?.sort_order ?? 0);
    setActive(step ? !!step.active : true);
    setFormError(null);
    if (imageRef.current) imageRef.current.value = "";
  }, [open, step]);

  async function handleSave() {
    if (!title.trim()) {
      setFormError("Title is required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        icon: icon.trim(),
        title: title.trim(),
        description: description.trim(),
        sortOrder: Number(sortOrder) || 0,
        image: imageRef.current?.files?.[0] || null,
      };
      if (step) payload.active = active;
      await onSave(step?.id || null, payload);
      onClose();
      toast.success(step ? "Step updated." : "Step added.");
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={step ? "Edit step" : "Add step"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            {step ? "Save changes" : "Add step"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <FormField label="Icon / step number">
          <Input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="e.g. 01" />
        </FormField>
        <FormField label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <FormField label="Description">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
        <FormField label="Image (optional)">
          <input ref={imageRef} type="file" accept="image/*" />
        </FormField>
        {step?.image_path && <img src={step.image_path} alt="" style={{ width: 80, borderRadius: 8 }} />}
        <FormField label="Display order">
          <Input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
        </FormField>
        {step && <Checkbox label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} />}
        {formError && <p style={{ color: "var(--danger, #dc2626)", margin: 0 }}>{formError}</p>}
      </div>
    </Modal>
  );
}
