import { useEffect, useState } from "react";
import { Modal, Button, FormField, Input, Select, Radio, Alert } from "../../components/ui";
import PermissionCheckboxGrid from "./PermissionCheckboxGrid";
import { InstructorAssignmentFields, emptyAssignmentRow, rowsToAssignments } from "./AccountActionModals";
import { createStaffAccount } from "../../api/admin";
import { fetchRoleTemplates, fetchPermissionCatalog, fetchCorporateClientsForRoleAssignment } from "../../api/roleTemplates";
import { useToast } from "../../context/ToastContext";

// Matches legacy toggleStaffCorporateField(): the Corporate Client picker
// only ever appears for the one template that needs it, and only while
// assigning by Role Template (never in Custom Permission Set mode) — same
// rule ManageAccessModal already applies when *reassigning* an existing
// administrator's access.
const CORPORATE_CLIENT_TEMPLATE_NAME = "Corporate Coordinator";

/**
 * Create an instructor or admin account (Phase 20) — migrates legacy
 * createStaff() / the "Create an instructor or admin account" panel
 * (dashboard.html), against the same POST /api/users/staff contract (see
 * api/admin.js). Instructors and admins can't self-register; only an
 * existing admin (Super Administrator, for role:"admin") can create their
 * logins.
 *
 * The backend remains the sole authority on who may create which account
 * type and with which permissions — this form only decides what to *show*
 * (e.g. the "Admin" role option and the RBAC fields are hidden for a
 * non-Super-Administrator, matching legacy's own `user.isSuperAdmin`
 * gate), never what's *allowed*. Every field here maps 1:1 onto a field
 * the backend's "/staff" route already validates
 * (server/src/routes/users.js) — nothing new is invented client-side.
 *
 * @param {boolean} open
 * @param {() => void} onClose
 * @param {boolean} isSuperAdmin - from PermissionContext, same source AccountManagementPage already uses
 * @param {Array} campuses - already loaded by useAccountManagement (admin Campus Administrator field only)
 * @param {Array} instances - Active Learning Instances, for the Instructor Assignment editor (useAccountManagement.js)
 * @param {(learningInstanceId: string) => Promise} fetchOptions - fetchInstructorAssignmentOptions, for the same editor
 * @param {() => void} onCreated - called after a successful create so the caller can reload its own account list
 */
export default function CreateAccountModal({ open, onClose, isSuperAdmin, campuses, instances, fetchOptions, onCreated }) {
  const toast = useToast();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("instructor");

  const [assignmentRows, setAssignmentRows] = useState([emptyAssignmentRow()]);

  const [permMode, setPermMode] = useState("template"); // "template" | "custom"
  const [roleTemplateId, setRoleTemplateId] = useState("");
  const [customPermissions, setCustomPermissionsState] = useState(new Set());
  const [campus, setCampus] = useState("");
  const [corporateClientId, setCorporateClientId] = useState("");

  const [rbacStatus, setRbacStatus] = useState("idle"); // "idle" | "loading" | "ready" | "error"
  const [rbacError, setRbacError] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [corporateClients, setCorporateClients] = useState([]);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  // Reset to a blank form every time the modal opens, rather than leaving
  // stale values from a previous create behind.
  useEffect(() => {
    if (!open) return;
    setName("");
    setEmail("");
    setPassword("");
    setPhone("");
    setRole("instructor");
    setAssignmentRows([emptyAssignmentRow()]);
    setPermMode("template");
    setCustomPermissionsState(new Set());
    setCampus("");
    setCorporateClientId("");
    setFormError(null);
    setRbacStatus("idle");
  }, [open]);

  // Only a Super Administrator can ever pick role:"admin" (mirrors legacy
  // gating the whole adminFieldsHtml block on user.isSuperAdmin), so the
  // RBAC catalog (role templates / permission catalog / corporate clients)
  // is only ever fetched for them — loaded once per modal open rather than
  // re-fetched on every role toggle.
  useEffect(() => {
    if (!open || !isSuperAdmin || rbacStatus !== "idle") return;
    setRbacStatus("loading");
    Promise.all([fetchRoleTemplates(), fetchPermissionCatalog(), fetchCorporateClientsForRoleAssignment()])
      .then(([templatesResult, catalogResult, corporateClientsResult]) => {
        const activeTemplates = templatesResult.filter((t) => t.isActive);
        setTemplates(activeTemplates);
        setCatalog(catalogResult);
        setCorporateClients(corporateClientsResult);
        setRoleTemplateId(activeTemplates[0]?.id || "");
        setRbacStatus("ready");
      })
      .catch((e) => {
        setRbacError(e.message);
        setRbacStatus("error");
      });
  }, [open, isSuperAdmin, rbacStatus]);

  if (!open) return null;

  const selectedTemplate = templates.find((t) => t.id === roleTemplateId) || null;
  const showCorporateClientField = role === "admin" && permMode === "template" && selectedTemplate && selectedTemplate.name === CORPORATE_CLIENT_TEMPLATE_NAME;

  function toggleCustomPermission(key) {
    setCustomPermissionsState((current) => {
      const next = new Set(current);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function handleClose() {
    if (saving) return; // prevent closing mid-submit
    onClose();
  }

  async function handleSubmit() {
    setFormError(null);

    // Client-side checks mirror the backend's own required-field/length
    // validation (see "/staff" route) purely so the person gets fast
    // feedback — the backend re-checks everything regardless and remains
    // the actual authority.
    if (!name.trim() || !email.trim() || !password) {
      setFormError("Full name, email, and a temporary password are required.");
      return;
    }
    if (password.length < 8) {
      setFormError("Password must be at least 8 characters.");
      return;
    }
    if (role === "admin") {
      if (permMode === "template" && !roleTemplateId) {
        setFormError("Choose a Role Template, or switch to a Custom Permission Set.");
        return;
      }
      if (showCorporateClientField && !corporateClientId) {
        setFormError("A Corporate Client is required for the Corporate Coordinator template.");
        return;
      }
    }

    const payload = {
      name: name.trim(),
      email: email.trim(),
      password,
      role,
      phone: phone.trim(),
    };
    if (role === "instructor") {
      payload.assignments = rowsToAssignments(assignmentRows);
    }
    if (role === "admin") {
      if (permMode === "template") {
        payload.roleTemplateId = roleTemplateId;
      } else {
        payload.customPermissions = Array.from(customPermissions);
      }
      payload.campus = campus || null;
      if (showCorporateClientField) payload.corporateClientId = corporateClientId || null;
    }

    setSaving(true);
    try {
      await createStaffAccount(payload);
      toast.success("Account created.");
      onCreated?.();
      onClose();
    } catch (e) {
      // Surfaces backend validation, 401 (session expired), 403
      // (ordinary admin trying role:"admin", or non-Super-Administrator
      // hitting the RBAC fields), and 409 (duplicate email) messages
      // as-is — the backend's error text is already the authoritative,
      // user-facing explanation for all of these.
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Create an instructor or admin account"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving}>
            Create account
          </Button>
        </>
      }
    >
      <p className="text-helper" style={{ marginBottom: "var(--space-4)" }}>
        Instructors and admins can't self-register — create their logins here.
      </p>

      <div className="grid-2">
        <FormField label="Full name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={saving} autoComplete="off" />
        </FormField>
        <FormField label="Email" required>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={saving} autoComplete="off" />
        </FormField>
      </div>

      <div className="grid-2" style={{ marginTop: "var(--space-3)" }}>
        <FormField label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value)} disabled={saving}>
            <option value="instructor">Instructor</option>
            {isSuperAdmin && <option value="admin">Admin</option>}
          </Select>
        </FormField>
        <FormField label="Temporary password (8+ chars)" required>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={saving} autoComplete="new-password" />
        </FormField>
      </div>

      <div style={{ marginTop: "var(--space-3)" }}>
        <FormField label="Phone">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} disabled={saving} autoComplete="off" />
        </FormField>
      </div>

      {role === "instructor" && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <p className="text-label" style={{ marginBottom: "var(--space-2)" }}>
            Instructor Assignment
          </p>
          <InstructorAssignmentFields instances={instances} fetchOptions={fetchOptions} rows={assignmentRows} setRows={setAssignmentRows} disabled={saving} />
        </div>
      )}

      {role === "admin" && isSuperAdmin && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
            Administrators never get automatic full access — assign a Role Template or build a Custom Permission Set for this account.
          </p>

          {rbacStatus === "loading" && <p className="text-helper">Loading role templates…</p>}
          {rbacStatus === "error" && <Alert variant="danger">{rbacError}</Alert>}

          {rbacStatus === "ready" && (
            <>
              <div style={{ display: "flex", gap: "var(--space-4)", marginBottom: "var(--space-4)" }}>
                <Radio name="createAcctPermMode" label="Use a Role Template" checked={permMode === "template"} onChange={() => setPermMode("template")} disabled={saving} />
                <Radio name="createAcctPermMode" label="Build a Custom Permission Set" checked={permMode === "custom"} onChange={() => setPermMode("custom")} disabled={saving} />
              </div>

              {permMode === "template" && (
                <>
                  <FormField label="Role Template">
                    <Select value={roleTemplateId} onChange={(e) => setRoleTemplateId(e.target.value)} disabled={saving}>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.permissions.length} permissions)
                        </option>
                      ))}
                    </Select>
                  </FormField>

                  {showCorporateClientField && (
                    <FormField label="Corporate Client">
                      <Select value={corporateClientId} onChange={(e) => setCorporateClientId(e.target.value)} disabled={saving}>
                        <option value="">— select —</option>
                        {corporateClients.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                </>
              )}

              {permMode === "custom" && (
                <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", padding: "var(--space-3)" }}>
                  <PermissionCheckboxGrid groups={catalog} checked={customPermissions} onToggle={toggleCustomPermission} />
                </div>
              )}

              <div style={{ marginTop: "var(--space-3)" }}>
                <FormField label="Campus (only relevant for a Campus Administrator template)">
                  <Select value={campus} onChange={(e) => setCampus(e.target.value)} disabled={saving}>
                    <option value="">— none —</option>
                    {campuses.map((c) => (
                      <option key={c.id || c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </div>
            </>
          )}
        </div>
      )}

      {formError && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <Alert variant="danger">{formError}</Alert>
        </div>
      )}
    </Modal>
  );
}
