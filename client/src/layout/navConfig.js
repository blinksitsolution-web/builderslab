import {
  LayoutDashboard,
  LayoutGrid,
  Layers,
  BookOpen,
  CalendarRange,
  Building2,
  Users,
  UserCog,
  GraduationCap,
  ArrowUpCircle,
  BarChart3,
  TrendingUp,
  Activity,
  AlertTriangle,
  Megaphone,
  Wallet,
  HandCoins,
  CreditCard,
  FileText,
  Award,
  Globe,
  LayoutTemplate,
  Settings,
  ShieldCheck,
  NotebookPen,
  ListChecks,
  FolderKanban,
  PencilRuler,
  ClipboardCheck,
  MessageSquare,
  HeartHandshake,
  UploadCloud,
  CalendarClock,
} from "lucide-react";

/**
 * Nav items per role. Learner/Adult Learner (Phase 5), Parent (Phase 6),
 * Instructor (Phase 7 dashboard + Phase 12 working portal), and Admin
 * (Phase 8) point at their real routes (see routing/AppRoutes.jsx). Only
 * lists destinations that actually exist — no invented nav items for
 * unmigrated functionality (e.g. Instructor Examinations/Continuous
 * Assessment, previously deferred, now has real routes/nav items as of
 * Phase 14).
 *
 * Admin nav (regression fix): this used to hardcode only Overview, Manage
 * Accounts, and Payments — every other admin feature the legacy
 * dashboard.html exposes (Learning Offering Types (now migrated — Phase
 * 30), Programmes (now migrated — Phase 31), Learning Instances (now
 * migrated — Phase 32), Corporate Clients (now migrated — Phase 33),
 * Participants, Bulk Promotion, Learner/Instructor Progress, Defaulters,
 * Broadcast Messages (all now migrated — final admin migration pass),
 * Transcripts, Certificates, Landing Page CMS (now migrated — Phase 28),
 * Site Settings) was simply never added here, so even a Super
 * Administrator — who the backend grants every permission to (see
 * server/src/utils/permissions.js DEFAULT_TEMPLATE_PERMISSIONS["Super
 * Administrator"]) — never saw them. That was a frontend nav-list gap, not
 * a permissions/backend problem: GET /api/auth/me already returns the real
 * `isSuperAdmin` and `permissions` this file needed.
 *
 * `ADMIN_NAV_GROUPS` below still mirrors dashboard.html's own NAVS.admin
 * list and its ADMIN_NAV_PERMISSIONS filtering (same keys, same required
 * permissions, same relative order) so a Super Administrator sees every
 * existing admin feature and a non-super admin sees exactly the subset
 * their granted permissions unlock — identical to the legacy nav's
 * behavior. This is a UX nicety only, same as legacy: the backend
 * (requirePermission/requireSuperAdmin) is the only real gate, and every
 * route below is independently guarded there regardless of what this
 * list shows (see RoleRoute.jsx, routing/AppRoutes.jsx).
 *
 * UI pass: with 17+ destinations, a single flat list was hard to scan, so
 * the admin nav is now organized into a few standalone links (Overview,
 * Broadcast Messages, the super-admin-only Roles & Access) plus five
 * collapsible groups (Catalog, People, Reports, Finance & Records, Site)
 * — same items, same permission gating per item, just grouped for
 * scanability. NavList.jsx renders any node with an `items` array as a
 * collapsible group and everything else as a plain link, so this is the
 * only file that needed to change for the grouping; other roles' flat
 * arrays below are untouched in structure (still flat, not grouped).
 * Every item across every role now also carries an `icon` (lucide-react)
 * purely for visual scanning — never the source of truth for what a link
 * does.
 *
 * Each entry points at a real, already-migrated React route (`to`) where
 * one exists, or the working legacy dashboard.html bridge (`legacyHref`,
 * same anchor keys as dashboard.html's NAVS.admin) where the feature has
 * not been migrated to React yet — never a fake/invented React page.
 * "Roles & Access" is handled separately below: unlike every other item
 * here, it is gated on `isSuperAdmin` alone (matching RoleRoute's
 * `requireSuperAdmin` guard on admin/super — Phase 19), not on a
 * permission list, so that narrowing is preserved exactly as-is.
 */
const ADMIN_NAV_PERMISSIONS = {
  overview: ["dashboard.view"],
  offeringtypes: ["offeringTypes.view"],
  programmes: ["learningOfferings.view"],
  learninginstances: ["learningInstances.view"],
  corporateclients: ["corporateClients.view"],
  accounts: ["userManagement.createUsers", "learners.view", "instructors.view", "parents.view"],
  adultlearners: ["learners.view"],
  bulkpromotion: ["learners.promote"],
  learnerprogress: ["learners.view", "reports.view"],
  instructorprogress: ["instructors.view", "reports.view"],
  defaulters: ["payments.view"],
  broadcast: [],
  payments: ["payments.view", "payments.reports"],
  transcripts: ["transcripts.view"],
  certificates: ["certificates.create", "certificates.issue", "certificates.download"],
  sponsors: ["sponsors.view"],
  settings: ["siteSettings.view", "siteSettings.edit"],
  cms: ["siteSettings.view", "siteSettings.edit"],
};

// Same underlying items as dashboard.html's NAVS.admin, now organized
// into standalone top-level links and collapsible groups instead of one
// flat list. `to` = real existing React route; `legacyHref` = working
// legacy bridge for a feature not yet migrated to React (never both).
const ADMIN_NAV_STRUCTURE = [
  { key: "overview", label: "Overview", to: "/app/admin", icon: LayoutDashboard },
  {
    key: "catalog",
    label: "Catalog",
    icon: LayoutGrid,
    items: [
      // Phase 30: migrated off the legacy dashboard.html#offeringtypes
      // bridge onto a real React route (see AppRoutes.jsx).
      { key: "offeringtypes", label: "Learning Offering Types", to: "/app/admin/offering-types", icon: Layers },
      // Phase 31: migrated off the legacy dashboard.html#programmes
      // bridge onto a real React route (see AppRoutes.jsx).
      { key: "programmes", label: "Programmes", to: "/app/admin/programmes", icon: BookOpen },
      // Phase 32: migrated off the legacy dashboard.html#learninginstances
      // bridge onto a real React route (see AppRoutes.jsx).
      { key: "learninginstances", label: "Learning Instances", to: "/app/admin/learning-instances", icon: CalendarRange },
      // Phase 33: migrated off the legacy dashboard.html#corporateclients
      // bridge onto a real React route (see AppRoutes.jsx).
      { key: "corporateclients", label: "Corporate Clients", to: "/app/admin/corporate-clients", icon: Building2 },
    ],
  },
  {
    key: "people",
    label: "People",
    icon: Users,
    items: [
      { key: "accounts", label: "Manage Accounts", to: "/app/admin/accounts", icon: UserCog },
      // Final admin migration pass: migrated off the legacy dashboard.html
      // bridges onto real React routes (see AppRoutes.jsx).
      { key: "adultlearners", label: "Participants", to: "/app/admin/participants", icon: GraduationCap },
      { key: "bulkpromotion", label: "Bulk Promotion", to: "/app/admin/bulk-promotion", icon: ArrowUpCircle },
    ],
  },
  {
    key: "reports",
    label: "Reports",
    icon: BarChart3,
    items: [
      { key: "learnerprogress", label: "Learner Progress", to: "/app/admin/learner-progress", icon: TrendingUp },
      { key: "instructorprogress", label: "Instructor Progress", to: "/app/admin/instructor-progress", icon: Activity },
      { key: "defaulters", label: "Defaulters", to: "/app/admin/defaulters", icon: AlertTriangle },
    ],
  },
  { key: "broadcast", label: "Broadcast Messages", to: "/app/admin/broadcast", icon: Megaphone },
  {
    key: "finance",
    label: "Finance & Records",
    icon: Wallet,
    items: [
      { key: "payments", label: "Payments", to: "/app/admin/payments", icon: CreditCard },
      // Phase 26: migrated off the legacy dashboard.html#transcripts /
      // #certificates bridges onto real React routes (see AppRoutes.jsx).
      { key: "transcripts", label: "Transcripts", to: "/app/admin/transcripts", icon: FileText },
      { key: "certificates", label: "Certificates", to: "/app/admin/certificates", icon: Award },
      { key: "sponsors", label: "Sponsors", to: "/app/admin/sponsors", icon: HandCoins },
    ],
  },
  {
    key: "site",
    label: "Site",
    icon: Globe,
    items: [
      // Phase 28: migrated off the legacy dashboard.html#cms bridge onto
      // a real React route (see AppRoutes.jsx).
      { key: "cms", label: "Landing Page CMS", to: "/app/admin/cms", icon: LayoutTemplate },
      { key: "settings", label: "Site Settings", to: "/app/admin/settings", icon: Settings },
    ],
  },
];

// A leaf link is visible when the caller is a Super Administrator (who
// implicitly holds every permission) or holds at least one permission
// from its required list (or the item requires none at all, like
// Broadcast Messages). Same rule ADMIN_NAV_ITEMS used before grouping.
function leafVisible(key, isSuperAdmin, hasAnyPermission) {
  const required = ADMIN_NAV_PERMISSIONS[key];
  return isSuperAdmin || !required || required.length === 0 || hasAnyPermission(required);
}

function buildAdminNav(isSuperAdmin, hasAnyPermission) {
  const nodes = [];
  for (const node of ADMIN_NAV_STRUCTURE) {
    if (node.items) {
      const visibleItems = node.items.filter((item) => leafVisible(item.key, isSuperAdmin, hasAnyPermission));
      // Hide a group entirely once none of its items are visible, rather
      // than showing an empty collapsible section.
      if (visibleItems.length > 0) nodes.push({ ...node, items: visibleItems });
    } else if (leafVisible(node.key, isSuperAdmin, hasAnyPermission)) {
      nodes.push(node);
    }
  }

  // "Roles & Access" (Phase 19): Super Administrator-only, matching
  // RoleRoute's `requireSuperAdmin` guard on admin/super — permission-
  // list filtering above intentionally doesn't apply to this one item.
  if (isSuperAdmin) nodes.push({ key: "rolesaccess", label: "Roles & Access", to: "/app/admin/super", icon: ShieldCheck });

  // Audit Trail: read-only log of every change/modification recorded
  // anywhere in the LMS. Same Super-Administrator-only gating as Roles &
  // Access above (RoleRoute's requireSuperAdmin on admin/audit-log).
  if (isSuperAdmin) nodes.push({ key: "auditlog", label: "Audit Trail", to: "/app/admin/audit-log", icon: Activity });

  return nodes;
}

export function getNavItems(role, isAdult, { isSuperAdmin = false, hasAnyPermission = () => false, isCoordinator = false } = {}) {
  switch (role) {
    case "learner": {
      const items = [
        { label: "Overview", to: "/app/learner", icon: LayoutDashboard },
        { label: "Assignments & Notes", to: "/app/learner/notes", icon: NotebookPen },
        { label: "Course Topics", to: "/app/learner/topics", icon: BookOpen },
        { label: "Projects", to: "/app/learner/projects", icon: FolderKanban },
        { label: "Examinations", to: "/app/learner/examinations", icon: PencilRuler },
        { label: "Continuous Assessment", to: "/app/learner/continuous-assessments", icon: ListChecks },
        { label: "Transcript", to: "/app/learner/transcripts", icon: FileText },
        { label: "Certificates", to: "/app/learner/certificates", icon: Award },
        { label: "Messages", to: "/app/learner/messages", icon: MessageSquare },
      ];
      // Legacy only ever pushes "Payments" into an adult learner's own
      // menu (dashboard.html: `if (u.is_adult) { ... push("payments") }`)
      // — a non-adult learner's fees are paid by their parent, from the
      // parent portal, not here. Same reasoning applies to "My
      // Programmes" (final migration pass): learnerProgrammes()
      // (dashboard.html) only lets an adult learner self-enrol into an
      // additional programme; a non-adult's enrolment is handled by
      // their parent's portal instead (see ParentProgrammesPage.jsx).
      if (isAdult) {
        items.push({ label: "My Programmes", to: "/app/learner/programmes", icon: LayoutGrid });
        items.push({ label: "Payments", to: "/app/learner/payments", icon: CreditCard });
      }
      return items;
    }
    case "parent":
      return [
        { label: "Overview", to: "/app/parent", icon: LayoutDashboard },
        { label: "My Ward's Progress", to: "/app/parent/progress", icon: TrendingUp },
        { label: "Continuous Assessment", to: "/app/parent/continuous-assessments", icon: ListChecks },
        { label: "Transcripts", to: "/app/parent/transcripts", icon: FileText },
        { label: "Certificates", to: "/app/parent/certificates", icon: Award },
        { label: "Payments", to: "/app/parent/payments", icon: CreditCard },
        { label: "My Programmes", to: "/app/parent/programmes", icon: LayoutGrid },
        // Only a coordinator (sponsor_id set — see db/migrate.js's
        // "Coordinator accounts" section) sponsors/creates learners on
        // someone else's behalf and needs a dedicated credentials/roster
        // view (Stage 4B); an ordinary parent's own children/credentials
        // aren't the "sponsored learners" this screen is for.
        ...(isCoordinator ? [{ label: "Sponsored Learners", to: "/app/parent/sponsored-learners", icon: HeartHandshake }] : []),
        // Part 8 legacy remediation — a coordinator registers learners
        // through this bulk workflow now, not one at a time; see
        // AddChildPage.jsx's coordinator redirect and ParentDashboard.jsx's
        // gated CTA for the other two entry points into the same flow.
        ...(isCoordinator ? [{ label: "Bulk Registration", to: "/app/parent/bulk-registration", icon: UploadCloud }] : []),
        { label: "Messages", to: "/app/parent/messages", icon: MessageSquare },
      ];
    case "instructor":
      return [
        { label: "Overview", to: "/app/instructor", icon: LayoutDashboard },
        { label: "Notes & Assignments", to: "/app/instructor/notes", icon: NotebookPen },
        { label: "Monthly Topics", to: "/app/instructor/topics", icon: CalendarClock },
        { label: "Attendance", to: "/app/instructor/attendance", icon: ClipboardCheck },
        { label: "Grade Projects", to: "/app/instructor/grading", icon: FolderKanban },
        { label: "My Learners", to: "/app/instructor/learners", icon: GraduationCap },
        { label: "Messages", to: "/app/instructor/messages", icon: MessageSquare },
        { label: "Examinations", to: "/app/instructor/examinations", icon: PencilRuler },
        { label: "Continuous Assessment", to: "/app/instructor/continuous-assessments", icon: ListChecks },
      ];
    case "admin":
      return buildAdminNav(isSuperAdmin, hasAnyPermission);
    default:
      return [{ label: "Overview", to: "/app", icon: LayoutDashboard }];
  }
}
