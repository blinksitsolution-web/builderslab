import { useState } from "react";
import { useAuditLog } from "./useAuditLog";
import {
  PageHeader,
  Card,
  DataTable,
  Badge,
  Button,
  Input,
  Select,
  FormField,
  Modal,
  Pagination,
  LoadingState,
  ErrorState,
  UnauthorizedState,
  EmptyState,
} from "../../components/ui";

const ACTION_TONE = {
  create: "success",
  update: "info",
  delete: "danger",
  status_change: "warning",
};

function actionLabel(action) {
  if (!action) return "—";
  return action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function entityTypeLabel(entityType) {
  if (!entityType) return "—";
  return entityType
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function formatTimestamp(value) {
  if (!value) return "—";
  // Stored as SQLite's UTC "YYYY-MM-DD HH:MM:SS" — normalize to ISO so the
  // browser renders it in the viewer's own local time instead of showing
  // the raw UTC string as-is.
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function ChangesSummary({ entry }) {
  if (entry.changes && typeof entry.changes === "object") {
    const fields = Object.keys(entry.changes);
    if (fields.length === 0) return <span style={{ color: "var(--color-text-muted)" }}>No fields changed</span>;
    return <span>{fields.length} field{fields.length === 1 ? "" : "s"} changed</span>;
  }
  return <span style={{ color: "var(--color-text-muted)" }}>—</span>;
}

function AuditEntryDetailModal({ entry, onClose }) {
  if (!entry) return null;
  const hasDiff = entry.changes && typeof entry.changes === "object" && Object.keys(entry.changes).length > 0;
  return (
    <Modal open={!!entry} onClose={onClose} title="Audit Trail Entry" size="lg">
      <div style={{ display: "grid", gap: "var(--space-3)" }}>
        <div className="grid-2">
          <div>
            <p className="text-label">Actor</p>
            <p>
              {entry.actorName} {entry.actorRole && <Badge tone="neutral">{entry.actorRole}</Badge>}
            </p>
          </div>
          <div>
            <p className="text-label">When</p>
            <p>{formatTimestamp(entry.createdAt)}</p>
          </div>
          <div>
            <p className="text-label">Action</p>
            <p>
              <Badge tone={ACTION_TONE[entry.action] || "neutral"}>{actionLabel(entry.action)}</Badge>
            </p>
          </div>
          <div>
            <p className="text-label">Entity</p>
            <p>
              {entityTypeLabel(entry.entityType)}
              {entry.entityLabel ? ` — ${entry.entityLabel}` : ""}
              {entry.entityId ? ` (${entry.entityId})` : ""}
            </p>
          </div>
          <div>
            <p className="text-label">Request</p>
            <p>
              {entry.method} {entry.path}
              {entry.statusCode ? ` → ${entry.statusCode}` : ""}
            </p>
          </div>
          <div>
            <p className="text-label">IP address</p>
            <p>{entry.ipAddress || "—"}</p>
          </div>
        </div>

        <div>
          <p className="text-label">What changed</p>
          {hasDiff ? (
            <Card padding={false} style={{ marginTop: "var(--space-2)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "var(--space-2)" }}>Field</th>
                    <th style={{ textAlign: "left", padding: "var(--space-2)" }}>From</th>
                    <th style={{ textAlign: "left", padding: "var(--space-2)" }}>To</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(entry.changes).map(([field, { from, to }]) => (
                    <tr key={field} style={{ borderTop: "1px solid var(--color-border)" }}>
                      <td style={{ padding: "var(--space-2)", fontFamily: "var(--font-mono)" }}>{field}</td>
                      <td style={{ padding: "var(--space-2)", color: "var(--color-danger-text)" }}>{String(from ?? "—")}</td>
                      <td style={{ padding: "var(--space-2)", color: "var(--color-success-text)" }}>{String(to ?? "—")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : (
            <p style={{ color: "var(--color-text-muted)" }}>
              No field-level diff was captured for this entry — it was logged from the request itself (method, path,
              actor), not a before/after comparison.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Audit Trail — read-only log of every create/update/delete/status-change
 * recorded anywhere in the LMS (see server/src/db/schema.sql's audit_log
 * table). Reserved entirely for Super Administrators: the route this page
 * is mounted on is behind RoleRoute's requireSuperAdmin (see
 * routing/AppRoutes.jsx), same as Roles & Access, and every read here goes
 * through the backend's own requireSuperAdmin gate regardless
 * (server/src/routes/auditLog.js).
 */
export default function AuditLogPage() {
  const log = useAuditLog();
  const [selected, setSelected] = useState(null);

  return (
    <div>
      <PageHeader title="Audit Trail" description="Every change and modification made across the platform, most recent first." />

      {log.status === "loading" && <LoadingState label="Loading Audit Trail…" />}
      {log.status === "forbidden" && <UnauthorizedState description="The Audit Trail is limited to Super Administrators." />}
      {log.status === "error" && <ErrorState description={log.error} action={{ label: "Try again", onClick: log.reload }} />}

      {(log.status === "ready" || log.entries.length > 0) && log.status !== "forbidden" && log.status !== "error" && (
        <>
          <Card padding style={{ marginBottom: "var(--space-4)" }}>
            <div className="grid-3">
              <FormField label="Search">
                <Input value={log.search} onChange={(e) => log.setSearch(e.target.value)} placeholder="Actor, entity, or path" />
              </FormField>
              <FormField label="Entity type">
                <Select value={log.entityType} onChange={(e) => log.setEntityType(e.target.value)}>
                  <option value="">All entity types</option>
                  {log.filterOptions.entityTypes.map((t) => (
                    <option key={t} value={t}>
                      {entityTypeLabel(t)}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="Action">
                <Select value={log.action} onChange={(e) => log.setAction(e.target.value)}>
                  <option value="">All actions</option>
                  {log.filterOptions.actions.map((a) => (
                    <option key={a} value={a}>
                      {actionLabel(a)}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="From">
                <Input type="date" value={log.from} onChange={(e) => log.setFrom(e.target.value)} />
              </FormField>
              <FormField label="To">
                <Input type="date" value={log.to} onChange={(e) => log.setTo(e.target.value)} />
              </FormField>
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    log.setSearch("");
                    log.setEntityType("");
                    log.setAction("");
                    log.setFrom("");
                    log.setTo("");
                  }}
                >
                  Clear filters
                </Button>
              </div>
            </div>
          </Card>

          <Card padding={false}>
            <DataTable
              loading={log.status === "loading"}
              columns={[
                { key: "when", header: "When", render: (e) => formatTimestamp(e.createdAt) },
                {
                  key: "actor",
                  header: "Actor",
                  render: (e) => (
                    <>
                      {e.actorName}
                      {e.actorRole && (
                        <Badge tone="neutral" className="ml-2">
                          {e.actorRole}
                        </Badge>
                      )}
                    </>
                  ),
                },
                { key: "action", header: "Action", render: (e) => <Badge tone={ACTION_TONE[e.action] || "neutral"}>{actionLabel(e.action)}</Badge> },
                { key: "entity", header: "Entity", render: (e) => `${entityTypeLabel(e.entityType)}${e.entityLabel ? ` — ${e.entityLabel}` : ""}` },
                { key: "changes", header: "Changes", render: (e) => <ChangesSummary entry={e} /> },
                { key: "request", header: "Request", render: (e) => `${e.method || ""} ${e.path || ""}`.trim() || "—" },
                {
                  key: "view",
                  header: "",
                  render: (e) => (
                    <Button variant="ghost" size="sm" onClick={() => setSelected(e)}>
                      View
                    </Button>
                  ),
                },
              ]}
              rows={log.entries}
              getRowKey={(e) => e.id}
              emptyState={<EmptyState title="No audit entries match these filters" />}
            />
          </Card>

          <div style={{ display: "flex", justifyContent: "center", marginTop: "var(--space-4)" }}>
            <Pagination page={log.page} totalPages={log.totalPages} onChange={log.goToPage} />
          </div>
        </>
      )}

      <AuditEntryDetailModal entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
