// ============================================================
// Legacy Participation Structure metadata (ABRS v2.1 §10.2)
// ============================================================
// The three Participation Structure keys the old `TEXT CHECK` enum on
// programme_enrollments/learning_instances ever allowed, and the
// behaviour metadata §10.2's table assigns each one. This is *seed data*
// for auto-creating a Programme's own `programme_participation_structures`
// row the first time that Programme actually uses one of these keys — it
// is not, itself, a business-logic branch (nothing in application code
// does `if (key === 'structured_school_club')`; see §2.2). Once a
// Programme has its own config row, every caller reads behaviour from
// that row, never from this object again.
//
// This is deliberately the single place this metadata is written down.
// server/src/db/migrate.js's v34/v36 backfills historically embedded their
// own copy (frozen, since a migration's own past behaviour must never
// change on re-run) — this module is for new, going-forward code
// (utils/learningInstances.js's ensureProgrammeParticipationStructure) to
// import instead of re-declaring the same three literals a third time.
const PARTICIPATION_STRUCTURE_METADATA = {
  structured_school_club: {
    name: "Structured School Club",
    usesProgrammeLevels: true,
    usesPromotion: true,
    requiresCourseSelection: false,
    registrantRole: "parent",
    usesLongTermEnrollment: true,
    autoAssignsEntryLevel: true,
    sortOrder: 0,
  },
  structured_other: {
    name: "Structured Online Journey",
    usesProgrammeLevels: true,
    usesPromotion: true,
    requiresCourseSelection: false,
    registrantRole: "parent",
    usesLongTermEnrollment: false,
    autoAssignsEntryLevel: false,
    sortOrder: 1,
  },
  individual_course: {
    name: "Individual Course",
    usesProgrammeLevels: false,
    usesPromotion: false,
    requiresCourseSelection: true,
    registrantRole: "parent_or_self",
    usesLongTermEnrollment: false,
    autoAssignsEntryLevel: false,
    sortOrder: 2,
  },
};

module.exports = { PARTICIPATION_STRUCTURE_METADATA };
