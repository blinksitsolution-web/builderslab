import { useState } from "react";
import { useRoleTemplates } from "./useRoleTemplates";
import RoleTemplateEditorModal from "./RoleTemplateEditorModal";
import { useToast } from "../../context/ToastContext";
import { PageHeader, Card, DataTable, Badge, Button, ConfirmationDialog, EmptyState, ErrorState, UnauthorizedState } from "../../components/ui";

/**
 * Roles & Access — Role Template management (Phase 19). Migrates legacy
 * adminAccessControl()/renderRoleTemplateTable() (dashboard.html): list
 * every Role Template with its permission count and status, plus create/
 * edit/duplicate/enable-disable/delete, against the same backend
 * endpoints (see api/roleTemplates.js and
 * server/src/routes/roleTemplates.js).
 *
 * Reserved entirely for Super Administrators, same as legacy — the route
 * this page is mounted on is behind RoleRoute's `requireSuperAdmin` (see
 * routing/AppRoutes.jsx), and every mutation here still goes through the
 * backend's own requireSuperAdmin gate regardless. Legacy's read-only
 * "Your access" summary for non-Super-Administrator admins is not
 * reproduced here since ordinary administrators can never reach this
 * route in the first place; their own Role Template/permissions are
 * already visible read-only in AccountDetailDrawer's "Role Template"
 * field (Phase 17) and in the profile menu, so nothing duplicates that.
 *
 * Custom Permission Set / Role Template *assignment* to a specific
 * administrator account (legacy manageAdminAccess()) is handled by
 * ManageAccessModal from the Manage Accounts screen, not here — this page
 * only manages the reusable templates themselves.
 */
export default function RoleTemplatesPage() {
  const rt = useRoleTemplates();
  const toast = useToast();

  const [editorTemplate, setEditorTemplate] = useState(undefined); // undefined = closed, null = "new", object = "edit"
  const [deleteTarget, setDeleteTarget] = useState(null);

  async function handleToggleActive(template) {
    try {
      await rt.toggleActive(template.id, !template.isActive);
      toast.success(template.isActive ? "Role Template disabled." : "Role Template enabled.");
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleDuplicate(template) {
    try {
      await rt.duplicate(template.id);
      toast.success("Role Template duplicated.");
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleSave(id, payload) {
    if (id) await rt.update(id, payload);
    else await rt.create(payload);
  }

  return (
    <div>
      <PageHeader
        title="Roles & Access"
        description="Reusable permission sets assigned to administrator accounts from Manage Accounts."
        actions={
          rt.status === "ready" ? (
            <Button onClick={() => setEditorTemplate(null)}>+ New Role Template</Button>
          ) : undefined
        }
      />

      {rt.status === "forbidden" && <UnauthorizedState description="Role Template management is limited to Super Administrators." />}

      {rt.status === "error" && <ErrorState description={rt.error} action={{ label: "Try again", onClick: rt.reload }} />}

      {(rt.status === "loading" || rt.status === "ready") && (
        <Card padding>
          <DataTable
            loading={rt.status === "loading"}
            rows={rt.templates}
            getRowKey={(t) => t.id}
            emptyState={<EmptyState title="No Role Templates yet" description="Create one to start assigning permission sets to administrators." />}
            columns={[
              {
                key: "name",
                header: "Role Template",
                render: (t) => (
                  <>
                    <b>{t.name}</b>
                    {t.isSystem ? (
                      <>
                        {" "}
                        <Badge tone="neutral">Built-in</Badge>
                      </>
                    ) : null}
                    <br />
                    <span className="text-helper">{t.description}</span>
                  </>
                ),
              },
              { key: "permissions", header: "Permissions", render: (t) => `${t.permissions.length} permission(s)` },
              {
                key: "status",
                header: "Status",
                render: (t) => <Badge tone={t.isActive ? "success" : "danger"}>{t.isActive ? "Active" : "Disabled"}</Badge>,
              },
              {
                key: "actions",
                header: "",
                render: (t) => (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
                    <Button variant="ghost" size="sm" onClick={() => setEditorTemplate(t)}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDuplicate(t)}>
                      Duplicate
                    </Button>
                    {t.name !== "Super Administrator" && (
                      <Button variant="ghost" size="sm" onClick={() => handleToggleActive(t)}>
                        {t.isActive ? "Disable" : "Enable"}
                      </Button>
                    )}
                    {!t.isSystem && (
                      <Button variant="danger" size="sm" onClick={() => setDeleteTarget(t)}>
                        Delete
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Card>
      )}

      <RoleTemplateEditorModal
        open={editorTemplate !== undefined}
        template={editorTemplate || null}
        catalog={rt.catalog}
        onClose={() => setEditorTemplate(undefined)}
        onSave={handleSave}
      />

      <ConfirmationDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={deleteTarget ? `Delete "${deleteTarget.name}"?` : ""}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={async () => {
          await rt.remove(deleteTarget.id);
          toast.success("Role Template deleted.");
        }}
      >
        <p>Any administrator still assigned this template must be reassigned first.</p>
      </ConfirmationDialog>
    </div>
  );
}
