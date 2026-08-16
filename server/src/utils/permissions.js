// ============================================================
// RBAC Engine — Permission Registry
// ============================================================
// Every permission checkable anywhere in the LMS is declared here, grouped
// by module exactly as specced. Nothing outside this file (and role_templates
// rows derived from it) should hardcode a permission string — routes/UI
// call utils/rbac.js, which reads from here, so adding a new permission or
// a new default template never requires touching route files.

// module -> { actionKey: "Human label" }
const PERMISSION_GROUPS = {
  dashboard: { view: "View Dashboard" },
  learningOfferings: {
    view: "View", create: "Create", edit: "Edit", delete: "Delete", publish: "Publish",
  },
  // One concrete "run" of a Programme or a Module — create/edit cover the
  // base record; activate/complete/archive/cancel (the status transitions)
  // are deliberately folded into "edit" rather than given their own keys,
  // matching how programmes.js already gates its /activate, /deactivate,
  // /reopen-registration etc. action endpoints behind "learningOfferings.edit".
  learningInstances: { view: "View", create: "Create", edit: "Edit" },
  campuses: { view: "View", create: "Create", edit: "Edit", delete: "Delete" },
  campusBranding: { view: "View", edit: "Edit" },
  learners: {
    view: "View", create: "Create", edit: "Edit", delete: "Delete",
    promote: "Promote", transfer: "Transfer", suspend: "Suspend",
  },
  parents: { view: "View", create: "Create", edit: "Edit", delete: "Delete" },
  instructors: { view: "View", create: "Create", edit: "Edit", delete: "Delete" },
  corporateClients: { view: "View", create: "Create", edit: "Edit", delete: "Delete" },
  // NGO/MP/corporate/individual sponsors covering a learner's fees — same
  // shape as corporateClients deliberately (view/create/edit; no delete,
  // same is_active-toggle-not-delete pattern, since a sponsor with
  // learners attached shouldn't just vanish from history).
  sponsors: { view: "View", create: "Create", edit: "Edit" },
  corporateCoordinators: { view: "View", create: "Create", edit: "Edit", delete: "Delete" },
  modules: { view: "View", create: "Create", edit: "Edit", delete: "Delete" },
  lessons: { view: "View", create: "Create", edit: "Edit", delete: "Delete", publish: "Publish" },
  assessments: {
    aiQuizzes: "AI Quizzes", teacherTests: "Teacher Tests", assignments: "Assignments",
    projects: "Projects", grade: "Grade", publishResults: "Publish Results",
  },
  examinations: { midterm: "Midterm", endOfTerm: "End of Term", retake: "Retake" },
  attendance: { view: "View", edit: "Edit" },
  payments: { view: "View", record: "Record", refund: "Refund", reports: "Reports" },
  // Admin configuration of the §15 Pricing & Financial Policy Framework
  // (Installment Configurations, Payment Plans, Promotional Campaigns,
  // Discount/Scholarship/Financial Aid Policies, Corporate Pricing,
  // Refund Policies). Deliberately separate from payments.* — payments.*
  // governs recording/refunding actual money movement; pricing.* governs
  // the CONFIGURATION the one Pricing Engine reads (ABRS v2.2 §15, §19).
  pricing: { view: "View", create: "Create", edit: "Edit", delete: "Delete" },
  certificates: { create: "Create", issue: "Issue", revoke: "Revoke", download: "Download" },
  transcripts: { view: "View", generate: "Generate", publish: "Publish" },
  reports: { view: "View", export: "Export" },
  academicCalendar: { view: "View", create: "Create", edit: "Edit" },
  offeringTypes: { view: "View", create: "Create", edit: "Edit", delete: "Delete" }, // "Learning Offering Types"
  certificateTemplates: { view: "View", create: "Create", edit: "Edit", delete: "Delete" },
  siteSettings: { view: "View", edit: "Edit" },
  aiProviders: { configure: "Configure", testConnection: "Test Connection" },
  apiKeys: { view: "View", edit: "Edit" },
  userManagement: { createUsers: "Create Users", resetPasswords: "Reset Passwords", disableAccounts: "Disable Accounts" },
  roleTemplates: { view: "View", create: "Create", edit: "Edit", delete: "Delete" },
  accessPermissions: { assignRoles: "Assign Roles", managePermissions: "Manage Permissions" },
  // Read-only Audit Trail of every change/modification recorded anywhere in
  // the LMS (see server/src/utils/auditLog.js and routes/auditLog.js) —
  // Super-Administrator-only per spec, same pattern as roleTemplates.* and
  // accessPermissions.* above (hard-gated below in SUPER_ADMIN_ONLY_PERMISSIONS).
  auditLog: { view: "View" },
};

// The Corporate Coordinator role uses its own small, bespoke permission set
// (per spec) rather than the generic module permissions above — a
// Coordinator never gets "learners.view" etc, only these narrow view rights
// scoped to their one Corporate Client (enforced in rbac.js/routes, not here).
const CORPORATE_COORDINATOR_GROUP = {
  viewParticipants: "View Participants",
  viewAttendance: "View Attendance",
  viewAssessmentResults: "View Assessment Results",
  viewCertificates: "View Certificates",
  viewTranscripts: "View Transcripts (if enabled)",
  viewPaymentStatus: "View Payment Status",
  downloadReports: "Download Reports",
};
PERMISSION_GROUPS.corporateCoordinator = CORPORATE_COORDINATOR_GROUP;

// Flat "module.action" key list, generated once from the groups above.
const ALL_PERMISSIONS = Object.entries(PERMISSION_GROUPS).flatMap(([mod, actions]) =>
  Object.keys(actions).map((action) => `${mod}.${action}`)
);
const ALL_PERMISSIONS_SET = new Set(ALL_PERMISSIONS);

function isKnownPermission(key) {
  return ALL_PERMISSIONS_SET.has(key);
}

// Permissions that, per the spec's "SUPER ADMINISTRATOR PROTECTION" section,
// only a Super Administrator may ever exercise — regardless of what a Role
// Template or an admin's Custom Permission Set says. rbac.js's hasPermission()
// hard-gates these behind isSuperAdmin() so they can never be granted away.
const SUPER_ADMIN_ONLY_PERMISSIONS = [
  "roleTemplates.view", "roleTemplates.create", "roleTemplates.edit", "roleTemplates.delete",
  "accessPermissions.assignRoles", "accessPermissions.managePermissions",
  "aiProviders.configure", "aiProviders.testConnection",
  "apiKeys.view", "apiKeys.edit",
  "siteSettings.edit",
  "auditLog.view",
];

const modulePerms = (mod) => Object.keys(PERMISSION_GROUPS[mod]).map((a) => `${mod}.${a}`);

// Default permission sets for the seven built-in Role Templates. Applied
// once at migration time (see rbac.js#ensureDefaultRoleTemplatesAndSuperAdmin) —
// after that, Super Administrators can edit a template's permissions freely
// from the Admin Portal without this file being touched again.
const DEFAULT_TEMPLATE_PERMISSIONS = {
  "Super Administrator": ALL_PERMISSIONS.slice(), // full system access, always
  Administrator: ALL_PERMISSIONS.filter((p) => !SUPER_ADMIN_ONLY_PERMISSIONS.includes(p)),
  "Academic Administrator": [
    "dashboard.view",
    ...modulePerms("learningOfferings"),
    ...modulePerms("learningInstances"),
    ...modulePerms("modules"),
    ...modulePerms("lessons"),
    ...modulePerms("assessments"),
    ...modulePerms("examinations"),
    ...modulePerms("academicCalendar"),
    "attendance.view", "attendance.edit",
    "learners.view", "learners.edit", "learners.promote", "learners.transfer",
    "instructors.view", "instructors.create", "instructors.edit",
    "transcripts.view", "transcripts.generate",
    "reports.view", "reports.export",
    "offeringTypes.view",
  ],
  "Finance Administrator": [
    "dashboard.view",
    ...modulePerms("payments"),
    "learners.view",
    "parents.view",
    "corporateClients.view",
    ...modulePerms("sponsors"),
    "reports.view", "reports.export",
  ],
  "Certificate Administrator": [
    "dashboard.view",
    ...modulePerms("certificates"),
    ...modulePerms("certificateTemplates"),
    "transcripts.view", "transcripts.generate", "transcripts.publish",
    "learners.view",
    "reports.view",
  ],
  "Campus Administrator": [
    // Scoped at runtime to the admin's assigned campus (users.campus) —
    // this list is *what* they can touch, scope restricts *where*.
    "dashboard.view",
    "learners.view", "learners.create", "learners.edit", "learners.promote", "learners.suspend",
    "parents.view", "parents.create", "parents.edit",
    // View-only for instructors: a Campus Administrator can see who
    // teaches at their campus, but creating/editing instructor accounts
    // is a least-privilege violation of the spec's original requirement —
    // that capability is Super-Administrator-only by default and must be
    // deliberately granted via a Custom Permission Set, not shipped in
    // this template (see routes/users.js POST /staff and PATCH
    // /:userId/assignments, which both hard-require instructors.create /
    // instructors.edit rather than trusting template membership alone).
    "instructors.view",
    ...modulePerms("attendance"),
    "payments.view", "payments.record", "payments.reports",
    "campusBranding.view", "campusBranding.edit",
    "reports.view", "reports.export",
    ...modulePerms("academicCalendar"),
  ],
  "Corporate Coordinator": [
    // Scoped at runtime to the coordinator's single assigned Corporate
    // Client (users.corporate_client_id) — never full learners.* etc.
    ...modulePerms("corporateCoordinator"),
  ],
};

module.exports = {
  PERMISSION_GROUPS,
  ALL_PERMISSIONS,
  ALL_PERMISSIONS_SET,
  isKnownPermission,
  SUPER_ADMIN_ONLY_PERMISSIONS,
  DEFAULT_TEMPLATE_PERMISSIONS,
};
