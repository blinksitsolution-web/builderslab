import { useEffect, useState } from "react";
import { Card, Button, Badge, DataTable, Modal, FormField, Input, Textarea, Checkbox, ConfirmationDialog } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import CmsTabState from "./CmsTabState";

/**
 * FAQs (Phase 28). Migrates legacy cmsRenderFaqs()/cmsLoadFaqsList()/
 * cmsOpenFaqModal()/cmsSaveFaq()/cmsDeleteFaqRow() — same
 * /api/settings/faqs... contract, preserving display order and
 * active/hidden status. The public landing page hides the FAQ section
 * entirely until at least one active question exists — unchanged here.
 */
export default function CmsFaqsTab({ cms }) {
  const tab = cms.tabs.faqs;
  const toast = useToast();
  const [editorFaq, setEditorFaq] = useState(undefined);
  const [deleteTarget, setDeleteTarget] = useState(null);

  return (
    <CmsTabState tab={tab} loadingLabel="Loading FAQs…" forbiddenDescription="Landing Page CMS is limited to administrators." onRetry={() => cms.reload("faqs")}>
      {(data) => (
        <>
          <p style={{ color: "var(--text-muted, #6b7280)", marginTop: 0 }}>The FAQ section on the Landing Page is hidden entirely until at least one question is added here.</p>
          <Card padding={false}>
            <div style={{ padding: 16, display: "flex", justifyContent: "flex-end" }}>
              <Button size="sm" onClick={() => setEditorFaq(null)}>
                + Add question
              </Button>
            </div>
            <DataTable
              columns={[
                { key: "question", header: "Question", render: (f) => f.question },
                { key: "order", header: "Order", render: (f) => f.sort_order },
                { key: "status", header: "Status", render: (f) => <Badge tone={f.active ? "success" : "neutral"}>{f.active ? "Active" : "Hidden"}</Badge> },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  render: (f) => (
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <Button variant="ghost" size="sm" onClick={() => setEditorFaq(f)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(f)}>
                        Delete
                      </Button>
                    </div>
                  ),
                },
              ]}
              rows={data.faqs}
              getRowKey={(f) => f.id}
              emptyState={<div style={{ padding: 24, color: "var(--text-muted, #6b7280)" }}>No FAQs yet.</div>}
            />
          </Card>

          <FaqModal faq={editorFaq} open={editorFaq !== undefined} onClose={() => setEditorFaq(undefined)} onSave={cms.saveFaq} />

          <ConfirmationDialog
            open={!!deleteTarget}
            onClose={() => setDeleteTarget(null)}
            title="Delete FAQ?"
            confirmLabel="Delete"
            confirmVariant="danger"
            onConfirm={async () => {
              try {
                await cms.removeFaq(deleteTarget.id);
              } catch (e) {
                toast.error(e.message);
              }
            }}
          >
            Delete "{deleteTarget?.question}"? This can't be undone.
          </ConfirmationDialog>
        </>
      )}
    </CmsTabState>
  );
}

function FaqModal({ faq, open, onClose, onSave }) {
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setQuestion(faq?.question || "");
    setAnswer(faq?.answer || "");
    setSortOrder(faq?.sort_order ?? 0);
    setActive(faq ? !!faq.active : true);
    setFormError(null);
  }, [open, faq]);

  async function handleSave() {
    if (!question.trim() || !answer.trim()) {
      setFormError("Question and answer are required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = { question: question.trim(), answer: answer.trim(), sortOrder: Number(sortOrder) || 0 };
      if (faq) payload.active = active;
      await onSave(faq?.id || null, payload);
      onClose();
      toast.success(faq ? "FAQ updated." : "FAQ added.");
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
      title={faq ? "Edit FAQ" : "Add FAQ"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            {faq ? "Save changes" : "Add FAQ"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <FormField label="Question">
          <Input value={question} onChange={(e) => setQuestion(e.target.value)} />
        </FormField>
        <FormField label="Answer">
          <Textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </FormField>
        <FormField label="Display order">
          <Input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
        </FormField>
        {faq && <Checkbox label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} />}
        {formError && <p style={{ color: "var(--danger, #dc2626)", margin: 0 }}>{formError}</p>}
      </div>
    </Modal>
  );
}
