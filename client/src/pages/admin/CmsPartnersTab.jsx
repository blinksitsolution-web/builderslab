import { useRef, useState } from "react";
import { Card, CardHeader, Button, Badge, DataTable, FormField, Input, ConfirmationDialog } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import CmsTabState from "./CmsTabState";

/**
 * Partners (Phase 28). Migrates legacy cmsRenderPartners()/
 * cmsAddPartnerRow()/cmsLoadPartnersList()/cmsTogglePartnerActive()/
 * cmsDeletePartnerRow() — same /api/settings/partners... contract.
 */
export default function CmsPartnersTab({ cms }) {
  const tab = cms.tabs.partners;
  const toast = useToast();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const logoRef = useRef(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  async function handleAdd() {
    if (!name.trim()) {
      setAddError("Name is required.");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await cms.addPartner({ name: name.trim(), url: url.trim(), logo: logoRef.current?.files?.[0] || null });
      setName("");
      setUrl("");
      if (logoRef.current) logoRef.current.value = "";
      toast.success("Partner added.");
    } catch (e) {
      setAddError(e.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(p) {
    try {
      await cms.togglePartnerActive(p.id, !p.active);
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <CmsTabState tab={tab} loadingLabel="Loading partners…" forbiddenDescription="Landing Page CMS is limited to administrators." onRetry={() => cms.reload("partners")}>
      {(data) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card>
            <CardHeader title="Add partner" />
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <FormField label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </FormField>
              <FormField label="Website URL (optional)">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
              </FormField>
              <FormField label="Logo (optional)">
                <input ref={logoRef} type="file" accept="image/*" />
              </FormField>
              {addError && <p style={{ color: "var(--danger, #dc2626)", margin: 0 }}>{addError}</p>}
              <div>
                <Button onClick={handleAdd} loading={adding}>
                  Add partner
                </Button>
              </div>
            </div>
          </Card>

          <Card padding={false}>
            <DataTable
              columns={[
                {
                  key: "partner",
                  header: "Partner",
                  render: (p) => (
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {p.logo_path && <img src={p.logo_path} alt="" style={{ width: 44, height: 44, borderRadius: 6, objectFit: "cover" }} />}
                      {p.name}
                    </span>
                  ),
                },
                { key: "status", header: "Status", render: (p) => <Badge tone={p.active ? "success" : "neutral"}>{p.active ? "Visible" : "Hidden"}</Badge> },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  render: (p) => (
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <Button variant="ghost" size="sm" onClick={() => handleToggle(p)}>
                        {p.active ? "Hide" : "Show"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(p)}>
                        Delete
                      </Button>
                    </div>
                  ),
                },
              ]}
              rows={data.partners}
              getRowKey={(p) => p.id}
              emptyState={<div style={{ padding: 24, color: "var(--text-muted, #6b7280)" }}>No partners yet.</div>}
            />
          </Card>

          <ConfirmationDialog
            open={!!deleteTarget}
            onClose={() => setDeleteTarget(null)}
            title="Delete partner?"
            confirmLabel="Delete"
            confirmVariant="danger"
            onConfirm={async () => {
              try {
                await cms.removePartner(deleteTarget.id);
              } catch (e) {
                toast.error(e.message);
              }
            }}
          >
            Delete "{deleteTarget?.name}"? This can't be undone.
          </ConfirmationDialog>
        </div>
      )}
    </CmsTabState>
  );
}
