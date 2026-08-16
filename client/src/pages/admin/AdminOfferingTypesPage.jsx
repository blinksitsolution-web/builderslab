import { useState } from "react";
import { useAdminOfferingTypes } from "./useAdminOfferingTypes";
import { PageHeader, Card, Button, Badge, DataTable, LoadingState, ErrorState, UnauthorizedState } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import OfferingTypeModal from "./OfferingTypeModal";

/**
 * Learning Offering Types (Phase 30). Migrates legacy adminOfferingTypes()/
 * loadOfferingTypesList()/openOfferingTypeModal()/saveOfferingType()/
 * toggleOfferingTypeActive() (dashboard.html) in full — same
 * /api/learning-offerings/types... contract.
 *
 * Root entity for the Programmes → Learning Instances chain (later
 * phases) — not migrated here. This page only manages the Learning
 * Offering Type catalogue itself.
 */
export default function AdminOfferingTypesPage() {
  const data = useAdminOfferingTypes();
  const toast = useToast();
  const [editorType, setEditorType] = useState(undefined); // undefined = closed, null = new, object = configure

  async function handleToggleActive(t) {
    try {
      await data.toggleActive(t.id, !t.isActive);
      toast.success(t.isActive ? "Deactivated." : "Activated.");
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div>
      <PageHeader
        title="Learning Offering Types"
        description="Every Learning Offering Type's behaviour — enrollment rules, academic structure, assessments, records, payments, certificates, AI and visibility — is configured here. New types work everywhere in the LMS immediately, with no code changes."
        actions={
          data.status === "ready" && (
            <Button onClick={() => setEditorType(null)}>+ New Learning Offering Type</Button>
          )
        }
      />

      {(data.status === "loading") && <LoadingState label="Loading Learning Offering Types…" />}
      {data.status === "forbidden" && <UnauthorizedState description="Learning Offering Types is limited to administrators." />}
      {data.status === "error" && <ErrorState description={data.error} action={{ label: "Try again", onClick: data.reload }} />}

      {data.status === "ready" && (
        <>
          <Card padding={false}>
            <DataTable
              columns={[
                {
                  key: "name",
                  header: "Name",
                  render: (t) => (
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: "1.2rem" }}>{t.icon || "📘"}</span>
                      {t.name}
                      <Badge tone={t.isActive ? "success" : "neutral"}>{t.isActive ? "Active" : "Inactive"}</Badge>
                    </span>
                  ),
                },
                {
                  key: "color",
                  header: "Color",
                  render: (t) => (
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ display: "inline-block", width: 14, height: 14, borderRadius: 3, background: t.color || "#8B5E3C" }} />
                      {t.color || ""}
                    </span>
                  ),
                },
                { key: "groupLabel", header: "Learning Group Label", render: (t) => t.learningGroupLabel || "Class" },
                { key: "parentRequired", header: "Parent Required", render: (t) => t.settings.enrollment.parentAccountRequired },
                { key: "order", header: "Order", render: (t) => t.sortOrder },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  render: (t) => (
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <Button variant="ghost" size="sm" onClick={() => setEditorType(t)}>
                        Configure
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleToggleActive(t)}>
                        {t.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  ),
                },
              ]}
              rows={data.types}
              getRowKey={(t) => t.id}
              emptyState={<div style={{ padding: 24, color: "var(--text-muted, #6b7280)" }}>No Learning Offering Types yet.</div>}
            />
          </Card>

          <OfferingTypeModal
            open={editorType !== undefined}
            existingType={editorType}
            settingsSchema={data.settingsSchema}
            certificateTemplates={data.certificateTemplates}
            onClose={() => setEditorType(undefined)}
            onSave={data.saveType}
          />
        </>
      )}
    </div>
  );
}
