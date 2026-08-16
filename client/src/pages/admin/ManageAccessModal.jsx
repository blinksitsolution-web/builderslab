import { useCallback, useEffect, useState } from "react";
import { fetchRoleTemplates, fetchPermissionCatalog, fetchCorporateClientsForRoleAssignment, assignRoleTemplate, setCustomPermissions } from "../../api/roleTemplates";
import { fetchCampuses } from "../../api/admin";
import { Modal, Button, FormField, Select, Radio, Alert, Skeleton } from "../../components/ui";
import PermissionCheckboxGrid from "./PermissionCheckboxGrid";
import { useToast } from "../../context/ToastContext";

// Matches legacy toggleManageAccessCorporateField(): the Corporate Client
// picker only ever appears for the one template that needs it, and only
// while assigning by Role Template (never in Custom Permission Set mode).
const CORPORATE_CLIENT_TEMPLATE_NAME = "Corporate Coordinator";
// Same idea for the campus picker — only "Campus Administrator" is scoped
// by users.campus (see server/src/utils/rbac.js campusScopeFor), and the
// backend now requires a campus whenever this template is (re)assigned.
const CAMPUS_TEMPLATE_NAME = "Campus Administrator";

/**
 * Reassign an existing administrator's Role Template (Option 1) or Custom
 * Permission Set (Option 2) — Phase 19, migrates legacy
 * manageAdminAccess()/saveAdminAccess() (dashboard.html). Opened from the
 * "Manage Access" row action in Manage Accounts (Phase 17's
 * AccountManagementPage), Super Administrator only, same as legacy's own
 * `user.isSuperAdmin` gate on that button.
 *
 * The backend remains the sole authority here: effective permissions are
 * never computed client-side (server/src/utils/rbac.js
 * effectivePermissions()), and every save goes through the same
 * requireSuperAdmin-gated endpoints legacy used (see api/roleTemplates.js).
 *
 * @param {object|null} account - the administrator account being managed, or null when closed
 * @param {() => void} onClose
 * @param {() => void} onSaved - called after a successful save so the caller can reload its own account list
 */
export default function ManageAccessModal({ account, onClose, onSaved }) {
  const toast = useToast();

  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [error, setError] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [corporateClients, setCorporateClients] = useState([]);
  const [campuses, setCampuses] = useState([]);

  const [mode, setMode] = useState("template"); // "template" | "custom"
  const [roleTemplateId, setRoleTemplateId] = useState("");
  const [corporateClientId, setCorporateClientId] = useState("");
  const [campus, setCampus] = useState("");
  const [customPermissions, setCustomPermissionsState] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const load = useCallback(async () => {
    if (!account) return;
    setStatus("loading");
    setError(null);
    try {
      const [templatesResult, catalogResult, corporateClientsResult, campusesResult] = await Promise.all([
        fetchRoleTemplates(),
        fetchPermissionCatalog(),
        fetchCorporateClientsForRoleAssignment(),
        fetchCampuses(),
      ]);
      const activeTemplates = templatesResult.filter((t) => t.isActive);
      setTemplates(activeTemplates);
      setCatalog(catalogResult);
      setCorporateClients(corporateClientsResult);
      setCampuses(campusesResult);

      setMode(account.usesCustomPermissions ? "custom" : "template");
      const currentTemplateStillActive = !account.usesCustomPermissions && activeTemplates.some((t) => t.id === account.roleTemplateId);
      setRoleTemplateId(currentTemplateStillActive ? account.roleTemplateId : activeTemplates[0]?.id || "");
      setCorporateClientId(account.corporateClientId || "");
      setCampus(account.campus || "");
      setCustomPermissionsState(new Set(account.permissions || []));
      setFormError(null);
      setStatus("ready");
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }, [account]);

  useEffect(() => {
    load();
  }, [load]);

  if (!account) return null;

  const selectedTemplate = templates.find((t) => t.id === roleTemplateId) || null;
  const showCorporateClientField = mode === "template" && selectedTemplate && selectedTemplate.name === CORPORATE_CLIENT_TEMPLATE_NAME;
  const showCampusField = mode === "template" && selectedTemplate && selectedTemplate.name === CAMPUS_TEMPLATE_NAME;

  function toggleCustomPermission(key) {
    setCustomPermissionsState((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSave() {
    setFormError(null);
    if (mode === "template" && showCorporateClientField && !corporateClientId) {
      setFormError("A Corporate Client is required for the Corporate Coordinator template.");
      return;
    }
    if (mode === "template" && showCampusField && !campus) {
      setFormError("A campus is required for the Campus Administrator template.");
      return;
    }
    setSaving(true);
    try {
      if (mode === "template") {
        await assignRoleTemplate(account.id, roleTemplateId, showCorporateClientField ? corporateClientId : null, showCampusField ? campus : null);
      } else {
        await setCustomPermissions(account.id, Array.from(customPermissions));
      }
      toast.success("Access updated.");
      onSaved?.();
      onClose();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={!!account} onClose={onClose} title={`Manage access — ${account.name}`} size="lg" footer={
      status === "ready" ? (
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Save
          </Button>
        </>
      ) : undefined
    }>
      {status === "loading" && (
        <div>
          <Skeleton height={16} width="60%" />
          <div style={{ marginTop: "var(--space-3)" }}>
            <Skeleton height={16} width="80%" />
          </div>
        </div>
      )}

      {status === "error" && <Alert variant="danger">{error}</Alert>}

      {status === "ready" && (
        <div>
          <p className="text-helper" style={{ marginBottom: "var(--space-4)" }}>
            {account.isSuperAdmin ? "This is a Super Administrator — the system always requires at least one." : "Assign a Role Template or a Custom Permission Set for this administrator."}
          </p>

          <div style={{ display: "flex", gap: "var(--space-4)", marginBottom: "var(--space-4)" }}>
            <Radio name="maPermMode" label="Role Template" checked={mode === "template"} onChange={() => setMode("template")} />
            <Radio name="maPermMode" label="Custom Permission Set" checked={mode === "custom"} onChange={() => setMode("custom")} />
          </div>

          {mode === "template" && (
            <>
              <FormField label="Role Template">
                <Select value={roleTemplateId} onChange={(e) => setRoleTemplateId(e.target.value)}>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.permissions.length} permissions)
                    </option>
                  ))}
                </Select>
              </FormField>

              {showCorporateClientField && (
                <FormField label="Corporate Client">
                  <Select value={corporateClientId} onChange={(e) => setCorporateClientId(e.target.value)}>
                    <option value="">— select —</option>
                    {corporateClients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
              )}

              {showCampusField && (
                <FormField label="Campus" helperText="A Campus Administrator only sees and manages accounts, learners, and payments at this one campus.">
                  <Select value={campus} onChange={(e) => setCampus(e.target.value)}>
                    <option value="">— select —</option>
                    {campuses.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
              )}
            </>
          )}

          {mode === "custom" && (
            <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", padding: "var(--space-3)" }}>
              <PermissionCheckboxGrid groups={catalog} checked={customPermissions} onToggle={toggleCustomPermission} />
            </div>
          )}

          {formError && (
            <div style={{ marginTop: "var(--space-3)" }}>
              <Alert variant="danger">{formError}</Alert>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
