import { useState } from "react";
import { useAdminCorporateClients } from "./useAdminCorporateClients";
import { PageHeader, Card, Button, Badge, DataTable, LoadingState, ErrorState, UnauthorizedState } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import CorporateClientModal from "./CorporateClientModal";

/**
 * Corporate Clients (Phase 33). Migrates legacy adminCorporateClients()/
 * loadCorporateClientsList()/openCorporateClientModal()/
 * saveCorporateClient()/toggleCorporateClientActive() (dashboard.html) in
 * full — same /api/learning-offerings/corporate-clients... contract.
 */
export default function AdminCorporateClientsPage() {
  const data = useAdminCorporateClients();
  const toast = useToast();
  const [editorClient, setEditorClient] = useState(undefined); // undefined = closed, null = new, object = edit

  async function handleToggleActive(c) {
    try {
      await data.toggleActive(c.id, c.isActive);
      toast.success(c.isActive ? "Deactivated." : "Activated.");
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div>
      <PageHeader
        title="Corporate Clients"
        description={'Corporate Clients are companies whose employees enrol under a Corporate Training programme (e.g. "MTN Ghana").'}
        actions={data.status === "ready" && <Button onClick={() => setEditorClient(null)}>+ New Corporate Client</Button>}
      />

      {data.status === "loading" && <LoadingState label="Loading Corporate Clients…" />}
      {data.status === "forbidden" && <UnauthorizedState description="Corporate Clients is limited to administrators." />}
      {data.status === "error" && <ErrorState description={data.error} action={{ label: "Try again", onClick: data.reload }} />}

      {data.status === "ready" && (
        <>
          <Card padding={false}>
            <DataTable
              columns={[
                {
                  key: "name",
                  header: "Name",
                  render: (c) => (
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {c.logoPath && <img src={c.logoPath} alt="" style={{ width: 32, height: 32, borderRadius: 6, objectFit: "cover" }} />}
                      <b>{c.name}</b>
                    </span>
                  ),
                },
                { key: "contactName", header: "Contact", render: (c) => c.contactName || "—" },
                { key: "contactEmail", header: "Email", render: (c) => c.contactEmail || "—" },
                { key: "contactPhone", header: "Phone", render: (c) => c.contactPhone || "—" },
                { key: "status", header: "Status", render: (c) => <Badge tone={c.isActive ? "success" : "neutral"}>{c.isActive ? "Active" : "Inactive"}</Badge> },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  render: (c) => (
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <Button variant="ghost" size="sm" onClick={() => setEditorClient(c)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleToggleActive(c)}>
                        {c.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  ),
                },
              ]}
              rows={data.clients}
              getRowKey={(c) => c.id}
              emptyState={<div style={{ padding: 24, color: "var(--text-muted, #6b7280)" }}>No corporate clients yet.</div>}
            />
          </Card>

          <CorporateClientModal open={editorClient !== undefined} existingClient={editorClient} onClose={() => setEditorClient(undefined)} onSave={data.saveClient} />
        </>
      )}
    </div>
  );
}
