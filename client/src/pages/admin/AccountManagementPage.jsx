import { useState } from "react";
import { useAccountManagement } from "./useAccountManagement";
import { useToast } from "../../context/ToastContext";
import AccountDetailDrawer from "./AccountDetailDrawer";
import { LearnerClassModal, LearnerModulesModal, PromoteDialog, InstructorAssignModal, DeleteAdminDialog } from "./AccountActionModals";
import ManageAccessModal from "./ManageAccessModal";
import CreateAccountModal from "./CreateAccountModal";
import { PageHeader, Card, Tabs, FormField, Input, Select, DataTable, Badge, StatusIndicator, Button, Pagination, EmptyState, ErrorState } from "../../components/ui";

const ROLE_TABS = [
  { key: "", label: "All" },
  { key: "parent", label: "Parents" },
  { key: "learner", label: "Learners" },
  { key: "instructor", label: "Instructors" },
];

/**
 * Admin Account Management (Phase 17). Migrates legacy adminAccounts() /
 * renderAcctTable() (dashboard.html) — same account listing, filters, and
 * row actions, against the same backend endpoints (see api/admin.js and
 * server/src/routes/users.js).
 *
 * Creating new instructor/admin accounts ("Create an instructor or admin
 * account") was deliberately deferred out of Phase 17 — see api/admin.js —
 * and is migrated here in Phase 20 via CreateAccountModal, wired into this
 * same screen's account list (its "Create account" button below) rather
 * than as a disconnected page.
 *
 * Still out of scope for this phase:
 *   - the Access Override (payment-restriction bypass) action — Payments
 *     & Access Restrictions, Phase 18. The current restriction state is
 *     still shown, read-only, in the account detail drawer.
 *
 * Every action below still goes through the backend's own authorization
 * (requireRole/requireSuperAdmin — see server/src/routes/users.js); this
 * page only decides what to *show*, matching PermissionContext's own
 * documented boundary.
 */
export default function AccountManagementPage() {
  const acct = useAccountManagement();
  const toast = useToast();

  const [detailUserId, setDetailUserId] = useState(null);
  const [classModalAccount, setClassModalAccount] = useState(null);
  const [modulesModalAccount, setModulesModalAccount] = useState(null);
  const [promoteAccount, setPromoteAccount] = useState(null);
  const [assignAccount, setAssignAccount] = useState(null);
  const [deleteAccount, setDeleteAccount] = useState(null);
  const [accessAccount, setAccessAccount] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);

  async function handleSuspendToggle(account) {
    try {
      await acct.suspendOrReactivate(account);
      toast.success(account.status !== "suspended" ? "Account suspended." : "Account reactivated.");
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div>
      <PageHeader
        title="Manage Accounts"
        description="Every parent, learner, instructor, and administrator account on the platform."
        actions={<Button onClick={() => setCreateOpen(true)}>Create account</Button>}
      />

      <Card padding>
        <Tabs tabs={ROLE_TABS.concat(acct.isSuperAdmin ? [{ key: "admin", label: "Admins" }] : [])} active={acct.roleTab} onChange={acct.setRoleTab} />

        <div className="grid-3" style={{ marginTop: "var(--space-4)" }}>
          <FormField label="Search by name/email">
            <Input value={acct.search} onChange={(e) => acct.setSearch(e.target.value)} placeholder="Type a name or email…" />
          </FormField>
          <FormField label="Campus">
            <Select value={acct.campus} onChange={(e) => acct.setCampus(e.target.value)}>
              <option value="">All campuses</option>
              {acct.campuses.map((c) => (
                <option key={c.id || c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        {acct.catalogStatus === "ready" && (
          <div className="grid-3" style={{ marginTop: "var(--space-4)" }}>
            <FormField label="Learning Offering Type">
              <Select value={acct.offeringTypeId} onChange={(e) => acct.setOfferingTypeId(e.target.value)}>
                <option value="">All offering types</option>
                {acct.offeringTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Programme">
              <Select value={acct.programmeId} onChange={(e) => acct.setProgrammeId(e.target.value)}>
                <option value="">All programmes</option>
                {acct.visibleProgrammes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </FormField>
            {!acct.instancesForbidden && (
              <FormField label="Learning Instance (run)">
                <Select value={acct.instanceSelection} onChange={(e) => acct.setInstanceSelection(e.target.value)}>
                  <option value="">Active runs only</option>
                  {acct.visibleInstances.map((li) => (
                    <option key={li.id} value={li.id}>
                      {(li.name || li.programmeName || li.moduleTitle || "Unnamed run") + " — " + li.status}
                    </option>
                  ))}
                  <option value="ALL">All Learning Instances (consolidated)</option>
                </Select>
              </FormField>
            )}
          </div>
        )}
        <p className="text-helper" style={{ marginTop: "var(--space-3)" }}>
          "Account Type" (the tabs above) is which kind of account; Offering Type/Programme/Learning Instance here scope which learners those tabs' rows are drawn from — parent/instructor/admin rows are never affected by these three, since only learners carry a Programme enrolment.
        </p>
      </Card>

      <div style={{ marginTop: "var(--space-6)" }}>
        {acct.listStatus === "error" ? (
          <ErrorState description={acct.listError} action={{ label: "Try again", onClick: acct.reload }} />
        ) : (
          <>
            <DataTable
              loading={acct.listStatus === "loading"}
              rows={acct.accounts}
              getRowKey={(u) => u.id}
              emptyState={<EmptyState title="No matching accounts" description="Try a different name, campus, or filter." />}
              columns={[
                {
                  key: "name",
                  header: "Name",
                  render: (u) => (
                    <button type="button" onClick={() => setDetailUserId(u.id)} style={{ background: "none", border: "none", padding: 0, color: "var(--color-primary-700)", cursor: "pointer", textAlign: "left" }}>
                      {u.name}
                      {u.role === "learner" && u.student_code ? (
                        <>
                          <br />
                          <span className="text-helper">{u.student_code}</span>
                        </>
                      ) : null}
                    </button>
                  ),
                },
                {
                  key: "role",
                  header: "Role",
                  render: (u) => (
                    <>
                      {u.role}
                      {u.role === "learner" && u.is_adult ? " (adult)" : ""}
                      {u.role === "admin" && (
                        <>
                          <br />
                          <Badge tone={u.isSuperAdmin ? "success" : "warning"}>
                            {u.roleTemplateName || "No template"}
                            {u.usesCustomPermissions ? " (custom)" : ""}
                          </Badge>
                        </>
                      )}
                    </>
                  ),
                },
                { key: "email", header: "Email", render: (u) => u.email },
                {
                  key: "campus",
                  header: "Campus",
                  render: (u) =>
                    u.role === "instructor"
                      ? u.campusNames === null
                        ? "All campuses"
                        : (u.campusNames || []).length
                        ? u.campusNames.join(", ")
                        : "—"
                      : u.campus || "—",
                },
                {
                  key: "assignment",
                  header: "Class / Assignments",
                  render: (u) =>
                    u.role === "learner" ? (
                      u.className || (u.is_adult ? "—" : "Unassigned")
                    ) : u.role === "instructor" ? (
                      // ABRS v2.2 §8.2 — sourced from instructor_assignments
                      // (the sole owner of Instructor Assignment), the same
                      // data the backend already resolved via
                      // getInstructorInstanceIds/getInstructorCourseIds/
                      // getInstructorClassIds/getInstructorCampusIds for the
                      // Campus column above. Previously this cell only
                      // showed a bare count from two of those four
                      // (classIds/assignedCourseIds), and read it from
                      // fields the pre-migration instructor_classes/
                      // instructor_courses tables used to populate —
                      // tables dropped by migrate.js's v40 consolidation —
                      // so it always showed "None assigned" regardless of
                      // what was actually granted.
                      (u.assignedInstanceNames || []).length ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
                          <span>
                            <strong>Run:</strong> {u.assignedInstanceNames.join(", ")}
                          </span>
                          <span>
                            <strong>Course:</strong> {(u.assignedCourseNames || []).length ? u.assignedCourseNames.join(", ") : "Any"}
                          </span>
                          <span>
                            <strong>Level:</strong> {(u.classNames || []).length ? u.classNames.join(", ") : "Any"}
                          </span>
                          <span>
                            <strong>Campus:</strong> {u.campusNames === null ? "All campuses" : (u.campusNames || []).length ? u.campusNames.join(", ") : "Any"}
                          </span>
                        </div>
                      ) : (
                        "None assigned"
                      )
                    ) : (
                      "—"
                    ),
                },
                {
                  key: "status",
                  header: "Status",
                  render: (u) => <StatusIndicator tone={u.status === "active" ? "positive" : u.status === "pending_payment" ? "caution" : "critical"}>{u.status}</StatusIndicator>,
                },
                {
                  key: "actions",
                  header: "",
                  render: (u) => (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
                      <Button variant="ghost" size="sm" onClick={() => handleSuspendToggle(u)}>
                        {u.status !== "suspended" ? "Suspend" : "Reactivate"}
                      </Button>
                      {u.role === "learner" && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setClassModalAccount(u)}>
                            Class
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setModulesModalAccount(u)}>
                            Modules
                          </Button>
                          {!u.is_adult && (
                            <Button variant="ghost" size="sm" onClick={() => setPromoteAccount(u)}>
                              Promote
                            </Button>
                          )}
                        </>
                      )}
                      {u.role === "instructor" && (
                        <Button variant="ghost" size="sm" onClick={() => setAssignAccount(u)}>
                          Assign
                        </Button>
                      )}
                      {u.role === "admin" && acct.isSuperAdmin && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setAccessAccount(u)}>
                            Manage Access
                          </Button>
                          <Button variant="danger" size="sm" onClick={() => setDeleteAccount(u)}>
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
                  ),
                },
              ]}
            />
            <div style={{ marginTop: "var(--space-4)" }}>
              <Pagination page={acct.page} totalPages={acct.totalPages} onChange={acct.setPage} />
            </div>
          </>
        )}
      </div>

      <AccountDetailDrawer userId={detailUserId} open={!!detailUserId} onClose={() => setDetailUserId(null)} classNameById={acct.classNameById} moduleTitleById={acct.moduleTitleById} />

      <LearnerClassModal account={classModalAccount} classes={acct.classes} onClose={() => setClassModalAccount(null)} onSave={acct.saveLearnerClass} />
      <LearnerModulesModal account={modulesModalAccount} modules={acct.modules} onClose={() => setModulesModalAccount(null)} onSave={acct.saveLearnerModules} />
      <PromoteDialog account={promoteAccount} onClose={() => setPromoteAccount(null)} onConfirm={(a) => acct.promote(a)} />
      <InstructorAssignModal
        account={assignAccount}
        instances={(acct.instances || acct.visibleInstances || []).filter((li) => li.status === "active")}
        onClose={() => setAssignAccount(null)}
        onSave={acct.saveInstructorAssignments}
        fetchOptions={acct.fetchInstructorAssignmentOptions}
        fetchExisting={acct.fetchInstructorAssignments}
      />
      <DeleteAdminDialog account={deleteAccount} onClose={() => setDeleteAccount(null)} onConfirm={acct.removeAdmin} />
      <ManageAccessModal account={accessAccount} onClose={() => setAccessAccount(null)} onSaved={acct.reload} />
      <CreateAccountModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        isSuperAdmin={acct.isSuperAdmin}
        campuses={acct.campuses}
        instances={(acct.instances || acct.visibleInstances || []).filter((li) => li.status === "active")}
        fetchOptions={acct.fetchInstructorAssignmentOptions}
        onCreated={acct.reload}
      />
    </div>
  );
}
