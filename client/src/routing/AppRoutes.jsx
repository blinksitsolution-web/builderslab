import { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import AppShell from "../layout/AppShell";
import ProtectedRoute from "./ProtectedRoute";
import RoleRoute from "./RoleRoute";
import LoadingState from "../components/ui/LoadingState";
import AppHome from "../pages/AppHome";
import NotFound from "../pages/NotFound";

// Performance pass: every page below used to be a static top-level
// import, which put the entire app — every portal's every page — into
// one JS bundle (~720KB minified, tripping Vite's 500KB chunk-size
// warning). A learner never touches a single admin page, and vice versa,
// so there's no reason their first page load should have to download
// AdminSponsorsPage, RoleTemplatesPage, InstructorGradingPage, etc.
// React.lazy() + Suspense below splits each of these into its own chunk,
// fetched only the first time its route is actually visited. AppShell/
// ProtectedRoute/RoleRoute/AppHome/NotFound stay static imports since
// they're on the critical path for genuinely every authenticated route.
const ProfilePage = lazy(() => import("../pages/ProfilePage"));
const DesignSystemPreview = lazy(() => import("../pages/DesignSystemPreview"));

const LoginPage = lazy(() => import("../pages/auth/LoginPage"));
const RegisterPage = lazy(() => import("../pages/auth/RegisterPage"));
const ForgotPasswordPage = lazy(() => import("../pages/auth/ForgotPasswordPage"));
const ResetPasswordPage = lazy(() => import("../pages/auth/ResetPasswordPage"));

const LearnerDashboard = lazy(() => import("../pages/learner/LearnerDashboard"));
const ModuleLearningPage = lazy(() => import("../pages/learner/ModuleLearningPage"));
const LessonPage = lazy(() => import("../pages/learner/LessonPage"));
const NotesAndAssignmentsPage = lazy(() => import("../pages/learner/NotesAndAssignmentsPage"));
const CourseTopicsPage = lazy(() => import("../pages/learner/CourseTopicsPage"));
const ProjectsPage = lazy(() => import("../pages/learner/ProjectsPage"));
const LearnerExaminationsPage = lazy(() => import("../pages/learner/LearnerExaminationsPage"));
const LearnerExaminationDetailPage = lazy(() => import("../pages/learner/LearnerExaminationDetailPage"));
const LearnerContinuousAssessmentsPage = lazy(() => import("../pages/learner/LearnerContinuousAssessmentsPage"));
const LearnerContinuousAssessmentDetailPage = lazy(() => import("../pages/learner/LearnerContinuousAssessmentDetailPage"));
const LearnerPaymentsPage = lazy(() => import("../pages/learner/LearnerPaymentsPage"));
const LearnerProgrammesPage = lazy(() => import("../pages/learner/LearnerProgrammesPage"));
const LearnerMessagesPage = lazy(() => import("../pages/learner/LearnerMessagesPage"));
const LearnerTranscriptsPage = lazy(() => import("../pages/learner/LearnerTranscriptsPage"));
const LearnerCertificatesPage = lazy(() => import("../pages/learner/LearnerCertificatesPage"));

const ParentDashboard = lazy(() => import("../pages/parent/ParentDashboard"));
const AddChildPage = lazy(() => import("../pages/parent/AddChildPage"));
const ParentCertificatesPage = lazy(() => import("../pages/parent/ParentCertificatesPage"));
const ParentContinuousAssessmentsPage = lazy(() => import("../pages/parent/ParentContinuousAssessmentsPage"));
const ParentTranscriptsPage = lazy(() => import("../pages/parent/ParentTranscriptsPage"));
const SponsoredLearnersPage = lazy(() => import("../pages/parent/SponsoredLearnersPage"));
const SponsorBulkRegistrationPage = lazy(() => import("../pages/parent/SponsorBulkRegistrationPage"));
const ParentProgressPage = lazy(() => import("../pages/parent/ParentProgressPage"));
const ParentPaymentsPage = lazy(() => import("../pages/parent/ParentPaymentsPage"));
const ParentProgrammesPage = lazy(() => import("../pages/parent/ParentProgrammesPage"));
const ParentMessagesPage = lazy(() => import("../pages/parent/ParentMessagesPage"));

const InstructorDashboard = lazy(() => import("../pages/instructor/InstructorDashboard"));
const InstructorNotesPage = lazy(() => import("../pages/instructor/InstructorNotesPage"));
const InstructorTopicsPage = lazy(() => import("../pages/instructor/InstructorTopicsPage"));
const InstructorAttendancePage = lazy(() => import("../pages/instructor/InstructorAttendancePage"));
const InstructorGradingPage = lazy(() => import("../pages/instructor/InstructorGradingPage"));
const InstructorLearnersPage = lazy(() => import("../pages/instructor/InstructorLearnersPage"));
const InstructorMessagesPage = lazy(() => import("../pages/instructor/InstructorMessagesPage"));
const InstructorExaminationsPage = lazy(() => import("../pages/instructor/InstructorExaminationsPage"));
const InstructorContinuousAssessmentsPage = lazy(() => import("../pages/instructor/InstructorContinuousAssessmentsPage"));

const AdminDashboard = lazy(() => import("../pages/admin/AdminDashboard"));
const AccountManagementPage = lazy(() => import("../pages/admin/AccountManagementPage"));
const PaymentsPage = lazy(() => import("../pages/admin/PaymentsPage"));
const AdminCertificatesPage = lazy(() => import("../pages/admin/AdminCertificatesPage"));
const AdminTranscriptsPage = lazy(() => import("../pages/admin/AdminTranscriptsPage"));
const AdminSettingsPage = lazy(() => import("../pages/admin/AdminSettingsPage"));
const AdminCmsPage = lazy(() => import("../pages/admin/AdminCmsPage"));
const AdminOfferingTypesPage = lazy(() => import("../pages/admin/AdminOfferingTypesPage"));
const AdminProgrammesPage = lazy(() => import("../pages/admin/AdminProgrammesPage"));
const AdminLearningInstancesPage = lazy(() => import("../pages/admin/AdminLearningInstancesPage"));
const AdminCorporateClientsPage = lazy(() => import("../pages/admin/AdminCorporateClientsPage"));
const AdminSponsorsPage = lazy(() => import("../pages/admin/AdminSponsorsPage"));
const AdminAdultLearnersPage = lazy(() => import("../pages/admin/AdminAdultLearnersPage"));
const AdminBulkPromotionPage = lazy(() => import("../pages/admin/AdminBulkPromotionPage"));
const AdminLearnerProgressPage = lazy(() => import("../pages/admin/AdminLearnerProgressPage"));
const AdminInstructorProgressPage = lazy(() => import("../pages/admin/AdminInstructorProgressPage"));
const AdminDefaultersPage = lazy(() => import("../pages/admin/AdminDefaultersPage"));
const AdminBroadcastPage = lazy(() => import("../pages/admin/AdminBroadcastPage"));
const RoleTemplatesPage = lazy(() => import("../pages/admin/RoleTemplatesPage"));
const AuditLogPage = lazy(() => import("../pages/admin/AuditLogPage"));

/**
 * Route foundation (Phase 2), the Phase 3 design-system preview route, the
 * Phase 4 login route, the Phase 5-8 portal dashboards, the Phase 9
 * public landing page, the Phase 10 module learning flow, the
 * Phase 11 Learner Notes/Assignments, Course Topics, and Projects
 * screens, and the Phase 12 Instructor working-portal screens (Notes &
 * Assignments incl. video lessons, Monthly Topics, Attendance, Grade
 * Projects, My Learners, Messages). Mounted at /app/* (see main.jsx) so the legacy static pages
 * keep owning their existing paths (/, /login.html, /register.html,
 * /dashboard.html) untouched during the coexistence period — see Phase 1
 * risk note on running both frontends side by side.
 *
 * The public landing page lives at /app/landing rather than replacing the
 * root index route: the true site root ("/") is still served by legacy
 * index.html via server.js's static file serving, which this migration
 * has consistently left untouched (see Phase 2). Wiring a React page to
 * literally replace "/" is a deployment decision for a later phase, not
 * a routing change to make here.
 *
 * Adult Learner is intentionally NOT a separate route or role guard —
 * matching the backend (role:"learner", is_adult:true) and the legacy
 * dashboard's own logic (see Phase 1, section 6/7; Phase 5 section 9), it
 * shares the learner route and component, adapting only cosmetically
 * based on `is_adult`.
 */
export default function AppRoutes() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Routes>
        {/* Phase 23: root cutover — "/" now serves this same
           PublicLandingPage directly (see server.js), so /app/landing
           redirects there instead of re-rendering the page under /app.
           This also sidesteps a real bug: the page's enrol-button hrefs
           (e.g. "register.html") are relative and only resolve correctly
           when the page is mounted at root; under /app/landing they'd
           resolve to /app/register.html, which doesn't exist. */}
        <Route path="landing" element={<Navigate to="/" replace />} />

        {/* Dev-only preview of the shared component library (Phase 3). Not
           behind ProtectedRoute on purpose — it renders only inline sample
           data, never real LMS data, so it doesn't need a session. */}
        <Route path="design-system" element={<DesignSystemPreview />} />

        {/* Migrated login route (Phase 4) — public, redirects to the
           appropriate portal itself if already signed in. */}
        <Route path="login" element={<LoginPage />} />

        {/* Migrated registration route (Group 1, final non-admin migration)
           — public, full port of legacy register.html's Parent + Child /
           Adult learner wizard. Supports the same ?offeringTypeSlug=
           (and &programmeId=, &audience=) deep-link params the landing
           page's per-offering "Enrol now" links use (see
           pages/public/publicUtils.js resolveEnrolDestination()). */}
        <Route path="register" element={<RegisterPage />} />

        {/* Migrated password-reset flow (Group 2, final non-admin
           migration) — public, two steps matching legacy login.html's
           #forgotPanel and reset-password.html exactly: request a reset
           link by email, then consume the emailed token to set a new
           password. The backend-generated email link now points at
           /app/reset-password?token=... directly (see
           server/src/routes/users.js). */}
        <Route path="forgot-password" element={<ForgotPasswordPage />} />
        <Route path="reset-password" element={<ResetPasswordPage />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route index element={<AppHome />} />
            {/* Shared across every role (learner/parent/instructor/admin) —
               not inside any RoleRoute group, since ProtectedRoute above
               already guarantees a session and the backend endpoints this
               calls (routes/users.js) are self-service for any role. */}
            <Route path="profile" element={<ProfilePage />} />

            <Route element={<RoleRoute allow={["learner"]} />}>
              <Route path="learner" element={<LearnerDashboard />} />
              <Route path="learner/modules/:moduleId" element={<ModuleLearningPage />} />
              <Route path="learner/modules/:moduleId/lessons/:lessonId" element={<LessonPage />} />
              <Route path="learner/notes" element={<NotesAndAssignmentsPage />} />
              <Route path="learner/topics" element={<CourseTopicsPage />} />
              <Route path="learner/projects" element={<ProjectsPage />} />
              <Route path="learner/examinations" element={<LearnerExaminationsPage />} />
              <Route path="learner/examinations/:id" element={<LearnerExaminationDetailPage />} />
              <Route path="learner/continuous-assessments" element={<LearnerContinuousAssessmentsPage />} />
              <Route path="learner/continuous-assessments/:id" element={<LearnerContinuousAssessmentDetailPage />} />
              <Route path="learner/payments" element={<LearnerPaymentsPage />} />
              <Route path="learner/programmes" element={<LearnerProgrammesPage />} />
              <Route path="learner/messages" element={<LearnerMessagesPage />} />
              <Route path="learner/transcripts" element={<LearnerTranscriptsPage />} />
              <Route path="learner/certificates" element={<LearnerCertificatesPage />} />
            </Route>

            <Route element={<RoleRoute allow={["parent"]} />}>
              <Route path="parent" element={<ParentDashboard />} />
              <Route path="parent/add-child" element={<AddChildPage />} />
              <Route path="parent/progress" element={<ParentProgressPage />} />
              <Route path="parent/continuous-assessments" element={<ParentContinuousAssessmentsPage />} />
              <Route path="parent/transcripts" element={<ParentTranscriptsPage />} />
              <Route path="parent/sponsored-learners" element={<SponsoredLearnersPage />} />
              <Route path="parent/bulk-registration" element={<SponsorBulkRegistrationPage />} />
              <Route path="parent/certificates" element={<ParentCertificatesPage />} />
              <Route path="parent/payments" element={<ParentPaymentsPage />} />
              <Route path="parent/programmes" element={<ParentProgrammesPage />} />
              <Route path="parent/messages" element={<ParentMessagesPage />} />
            </Route>

            <Route element={<RoleRoute allow={["instructor"]} />}>
              <Route path="instructor" element={<InstructorDashboard />} />
              <Route path="instructor/notes" element={<InstructorNotesPage />} />
              <Route path="instructor/topics" element={<InstructorTopicsPage />} />
              <Route path="instructor/attendance" element={<InstructorAttendancePage />} />
              <Route path="instructor/grading" element={<InstructorGradingPage />} />
              <Route path="instructor/learners" element={<InstructorLearnersPage />} />
              <Route path="instructor/messages" element={<InstructorMessagesPage />} />
              <Route path="instructor/examinations" element={<InstructorExaminationsPage />} />
              <Route path="instructor/continuous-assessments" element={<InstructorContinuousAssessmentsPage />} />
            </Route>

            <Route element={<RoleRoute allow={["admin"]} />}>
              <Route path="admin" element={<AdminDashboard />} />
              <Route path="admin/accounts" element={<AccountManagementPage />} />
              <Route path="admin/payments" element={<PaymentsPage />} />
              {/* Phase 26: Certificates & Transcripts — same admin-only guard as
                 every other admin route here, matching legacy's requireRole
                 ("admin")/requireSelfParentOrStaff+requireActiveAccess backend
                 gates (see certificates.js, grades.js). */}
              <Route path="admin/certificates" element={<AdminCertificatesPage />} />
              <Route path="admin/transcripts" element={<AdminTranscriptsPage />} />
              <Route path="admin/settings" element={<AdminSettingsPage />} />
              {/* Phase 28: Landing Page CMS — same admin-only guard as every
                 other admin route here (backend gate is siteSettings.view/
                 siteSettings.edit per endpoint, see settings.js). */}
              <Route path="admin/cms" element={<AdminCmsPage />} />
              {/* Phase 30: Learning Offering Types — root entity for the
                 Programmes → Learning Instances chain (not migrated yet).
                 Same admin-only guard as every other admin route here. */}
              <Route path="admin/offering-types" element={<AdminOfferingTypesPage />} />
              {/* Phase 31: Programmes — second step in the Learning Offering
                 Types → Programmes → Learning Instances chain. Same
                 admin-only guard. */}
              <Route path="admin/programmes" element={<AdminProgrammesPage />} />
              {/* Phase 32: Learning Instances — third and final step in the
                 Learning Offering Types → Programmes → Learning Instances
                 chain. Same admin-only guard. */}
              <Route path="admin/learning-instances" element={<AdminLearningInstancesPage />} />
              {/* Phase 33: Corporate Clients — companies whose employees
                 enrol under a Corporate Training programme. Same
                 admin-only guard. */}
              <Route path="admin/corporate-clients" element={<AdminCorporateClientsPage />} />
              <Route path="admin/sponsors" element={<AdminSponsorsPage />} />
              {/* Final admin migration pass: Participants / Adult Learners,
                 Bulk Promotion, Learner Progress, Instructor Progress,
                 Defaulters, Broadcast Messages — the last six legacy
                 dashboard.html bridges. Same admin-only guard as every other
                 admin route here. */}
              <Route path="admin/participants" element={<AdminAdultLearnersPage />} />
              <Route path="admin/bulk-promotion" element={<AdminBulkPromotionPage />} />
              <Route path="admin/learner-progress" element={<AdminLearnerProgressPage />} />
              <Route path="admin/instructor-progress" element={<AdminInstructorProgressPage />} />
              <Route path="admin/defaulters" element={<AdminDefaultersPage />} />
              <Route path="admin/broadcast" element={<AdminBroadcastPage />} />
            </Route>

            <Route element={<RoleRoute allow={["admin"]} requireSuperAdmin />}>
              {/* Phase 19: Role Templates & Custom Permissions (legacy's
                 "Roles & Access" / accesscontrol nav key) now lives here
                 instead of the placeholder — path kept as-is since nothing
                 else needed to change (see navConfig.js label update); still
                 Super Administrator-only via this same RoleRoute guard. */}
              <Route path="admin/super" element={<RoleTemplatesPage />} />
              {/* Audit Trail: every change/modification recorded anywhere in
                 the LMS, for Super Administrator review — same guard as
                 Roles & Access above (see api/auditLog.js and
                 server/src/routes/auditLog.js, both requireSuperAdmin). */}
              <Route path="admin/audit-log" element={<AuditLogPage />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
