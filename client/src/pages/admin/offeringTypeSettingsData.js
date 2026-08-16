/**
 * Ported verbatim from legacy dashboard.html's OFFERING_SETTINGS_SECTIONS
 * (Phase 30). This is the single source of truth for the bool/tristate/text
 * fields in each settings section — the form renders and reads generically
 * over this list, same as legacy's otRenderField()/otReadSettings(), so it
 * must stay in exact sync with the section/field keys the backend deep-merges
 * into `learning_offering_types.settings`
 * (server/src/utils/offeringTypeSettings.js's DEFAULT_SETTINGS).
 *
 * Certificates, Fees, and Landing Page are intentionally NOT here — same as
 * legacy, they need richer inputs (checklists, free text, selects) than a
 * flat bool/tristate/text list, so they're rendered by their own
 * subcomponents (see OfferingTypeModal.jsx).
 */
export const OFFERING_SETTINGS_SECTIONS = [
  {
    key: "enrollment",
    title: "Enrollment",
    fields: [
      { key: "parentAccountRequired", label: "Parent Account Required", type: "tristate" },
      { key: "selfRegistrationAllowed", label: "Self Registration Allowed", type: "bool" },
      { key: "instructorApprovalRequired", label: "Instructor Approval Required", type: "bool" },
    ],
  },
  {
    key: "academicStructure",
    title: "Academic Structure",
    fields: [
      { key: "usesAcademicYear", label: "Uses Academic Year", type: "bool" },
      { key: "usesAcademicTerm", label: "Uses Academic Term", type: "tristate" },
      { key: "usesPromotion", label: "Uses Promotion", type: "bool" },
      { key: "usesLearningGroups", label: "Uses Learning Groups", type: "bool" },
      { key: "usesModules", label: "Uses Modules", type: "bool" },
      { key: "usesLessons", label: "Uses Lessons", type: "bool" },
      { key: "usesAttendance", label: "Uses Attendance", type: "bool" },
    ],
  },
  {
    key: "assessments",
    title: "Assessments",
    fields: [
      { key: "aiQuizzes", label: "AI Quizzes", type: "bool" },
      { key: "teacherTests", label: "Teacher Tests", type: "bool" },
      { key: "assignments", label: "Assignments", type: "bool" },
      { key: "projects", label: "Projects", type: "bool" },
      { key: "midtermExams", label: "Midterm Exams", type: "bool" },
      { key: "endOfTermExams", label: "End of Term Exams", type: "bool" },
      { key: "retakeExams", label: "Retake Exams", type: "bool" },
    ],
  },
  {
    key: "academicRecords",
    title: "Academic Records",
    fields: [
      { key: "generateTranscript", label: "Generate Transcript", type: "tristate" },
      { key: "generateCertificates", label: "Generate Certificates", type: "bool" },
      { key: "generateAttendanceReport", label: "Generate Attendance Report", type: "bool" },
    ],
  },
  {
    key: "payments",
    title: "Payments",
    fields: [
      { key: "registrationFee", label: "Registration Fee", type: "bool" },
      { key: "monthlyFees", label: "Monthly Fees", type: "bool" },
      { key: "termFees", label: "Term Fees", type: "bool" },
      { key: "programmeFee", label: "Programme Fee", type: "bool" },
      { key: "workshopFee", label: "Workshop Fee", type: "bool" },
      { key: "bootcampFee", label: "Bootcamp Fee", type: "bool" },
      { key: "installmentsAllowed", label: "Installments Allowed", type: "bool" },
    ],
  },
  {
    key: "ai",
    title: "AI",
    fields: [
      { key: "aiQuizGenerationEnabled", label: "AI Quiz Generation Enabled", type: "bool" },
      { key: "transcriptRequired", label: "Transcript Required", type: "bool" },
      { key: "aiTranscriptSummaryEnabled", label: "AI Transcript Summary Enabled", type: "bool" },
    ],
  },
  {
    key: "visibility",
    title: "Visibility",
    fields: [
      { key: "displayOnPublicWebsite", label: "Display on Public Website", type: "bool" },
      { key: "displayInLearnerPortal", label: "Display in Learner Portal", type: "bool" },
      { key: "displayInParentPortal", label: "Display in Parent Portal", type: "bool" },
    ],
  },
  {
    key: "terminology",
    title: "Instructor Portal Terminology",
    fields: [
      { key: "moduleLabel", label: 'What to call "Module"', type: "text", placeholder: "e.g. Programme (for Bootcamp/Corporate Training)" },
      { key: "termLabel", label: 'What to call "Term"', type: "text", placeholder: "e.g. Exam Type" },
      { key: "singleTermOptionLabel", label: 'Single Term/Exam-Type option (used when Uses Academic Term = No, above)', type: "text", placeholder: "e.g. Final Exam" },
    ],
  },
];

/** Tristate field option values, in the same order as legacy's <select>. */
export const TRISTATE_OPTIONS = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "optional", label: "Optional" },
];
