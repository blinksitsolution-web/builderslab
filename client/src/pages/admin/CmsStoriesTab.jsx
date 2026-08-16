import { useRef, useState } from "react";
import { Card, CardHeader, Button, DataTable, FormField, Input, Textarea, Checkbox, ConfirmationDialog } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import CmsTabState from "./CmsTabState";

/**
 * Success Stories (Phase 28). Migrates legacy settingsStories()/
 * addStory()/loadStoriesList()/removeStory() — same
 * /api/settings/success-stories contract. No dedicated admin "list all"
 * endpoint exists; the list read reuses GET /api/settings/public (same
 * as legacy's loadStoriesList(), which also calls DTL.publicSettings()).
 */
export default function CmsStoriesTab({ cms }) {
  const tab = cms.tabs.stories;
  const toast = useToast();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [quote, setQuote] = useState("");
  const [highlighted, setHighlighted] = useState(false);
  const avatarRef = useRef(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  async function handleAdd() {
    if (!name.trim() || !quote.trim()) {
      setAddError("Name and quote are required.");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await cms.addStory({
        name: name.trim(),
        role: role.trim(),
        quote: quote.trim(),
        avatar: avatarRef.current?.files?.[0] || null,
        highlighted,
      });
      setName("");
      setRole("");
      setQuote("");
      setHighlighted(false);
      if (avatarRef.current) avatarRef.current.value = "";
      toast.success("Story added.");
    } catch (e) {
      setAddError(e.message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <CmsTabState tab={tab} loadingLabel="Loading success stories…" forbiddenDescription="Landing Page CMS is limited to administrators." onRetry={() => cms.reload("stories")}>
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card>
            <CardHeader title="Add a success story" />
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FormField label="Name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </FormField>
                <FormField label="Role / aspiration">
                  <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Aspiring AI Engineer" />
                </FormField>
              </div>
              <FormField label="Quote">
                <Textarea rows={2} value={quote} onChange={(e) => setQuote(e.target.value)} />
              </FormField>
              <FormField label="Photo (optional)">
                <input ref={avatarRef} type="file" accept="image/*" />
              </FormField>
              <Checkbox label="Highlight this story" checked={highlighted} onChange={(e) => setHighlighted(e.target.checked)} />
              {addError && <p style={{ color: "var(--danger, #dc2626)", margin: 0 }}>{addError}</p>}
              <div>
                <Button onClick={handleAdd} loading={adding}>
                  Add story
                </Button>
              </div>
            </div>
          </Card>

          <Card padding={false}>
            <DataTable
              columns={[
                { key: "name", header: "Name", render: (s) => s.name },
                { key: "role", header: "Role", render: (s) => s.role || "" },
                { key: "highlighted", header: "Highlighted", render: (s) => (s.highlighted ? "⭐" : "") },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  render: (s) => (
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(s)}>
                      Remove
                    </Button>
                  ),
                },
              ]}
              rows={data.stories}
              getRowKey={(s) => s.id}
              emptyState={<div style={{ padding: 24, color: "var(--text-muted, #6b7280)" }}>None yet.</div>}
            />
          </Card>

          <ConfirmationDialog
            open={!!deleteTarget}
            onClose={() => setDeleteTarget(null)}
            title="Remove story?"
            confirmLabel="Remove"
            confirmVariant="danger"
            onConfirm={async () => {
              try {
                await cms.removeStory(deleteTarget.id);
              } catch (e) {
                toast.error(e.message);
              }
            }}
          >
            Remove {deleteTarget?.name}'s story? This can't be undone.
          </ConfirmationDialog>
        </div>
      )}
    </CmsTabState>
  );
}
