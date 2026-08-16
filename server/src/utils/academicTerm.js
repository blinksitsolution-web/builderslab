const db = require("../db/db");

// ============================================================
// ABRS v2.2 Compliance Remediation.
//
// This module used to be documented as the "central helper... every route
// that reads/writes a term-scoped record... resolves its term through
// here" — via resolveTerm()/resolveTermId(), which defaulted to
// getActiveTerm(): one school-wide "active" Academic Term, selected
// independently of any Programme Run.
//
// That was a Single Ownership Principle violation (ABRS v2.2 §2.1/§19):
// the Academic Calendar and Academic Periods are owned by the Programme
// Run (§8.2), which owns its own Academic Period, which may itself be
// linked to one of the academic_terms rows this module manages
// (learning_instance_academic_periods.academic_term_id). A term-scoped
// activity record's Academic Term must be derived from THAT ownership
// chain — Programme Run -> Academic Period -> Academic Term — never from
// an independently-selected global "current term" that could silently
// disagree with the Run's own calendar. resolveTerm()/resolveTermId() have
// been REMOVED; every former caller now resolves through
// utils/learningInstances.js's resolveConstitutionalTermId /
// resolveConstitutionalTermIdForCourse / resolveConstitutionalTermIdForClass
// instead (see routes/attendance.js, grades.js, exams.js, assignments.js,
// certificates.js, utils/transcriptInterpretation.js,
// utils/promotionEngine.js).
//
// What legitimately remains here: academic_years/academic_terms are still
// real configuration data — the school-wide calendar vocabulary an
// Academic Period MAY optionally link to (migrate.js v25) — and admins
// still need to create/rename/activate Years and Terms as entities
// (routes/academicCalendar.js's CRUD, and browsing a specific historical
// term by an explicitly-known id). getActiveTerm()/getActiveTermId() are
// kept ONLY for that display/administration surface — they must never
// again be used to silently stamp or filter a Programme-Run-owned
// activity record's term_id.
// ============================================================

// ---- active year / term ----------------------------------------------------

function getActiveYear() {
  return db.prepare("SELECT * FROM academic_years WHERE is_active = 1").get() || null;
}

function getActiveTerm() {
  return db.prepare("SELECT * FROM academic_terms WHERE is_active = 1").get() || null;
}

// The one that both routes and the frontend care about most: the active
// term's id, or null if none has ever been set up (shouldn't happen after
// migrate.js's first-run seed, but callers should still handle null).
function getActiveTermId() {
  const t = getActiveTerm();
  return t ? t.id : null;
}

// ---- point lookups by id -----------------------------------------------
// Used wherever a route needs to resolve a *specific* (not necessarily
// active) term/year — e.g. issuing a certificate for a past term, or
// entering/viewing a historical grade. These were referenced by
// routes/grades.js and routes/certificates.js but were never actually
// defined/exported here, which is the root cause of the
// "TypeError: getTermById is not a function" crash. Adding them fixes it.
function getTermById(termId) {
  if (!termId) return null;
  return db.prepare("SELECT * FROM academic_terms WHERE id = ?").get(termId) || null;
}

function getYearById(yearId) {
  if (!yearId) return null;
  return db.prepare("SELECT * FROM academic_years WHERE id = ?").get(yearId) || null;
}

// ---- CRUD used by the admin Academic Calendar routes ------------------------

function listYears() {
  return db.prepare("SELECT * FROM academic_years ORDER BY start_date DESC, created_at DESC").all();
}

function listTerms(yearId) {
  if (yearId) {
    return db
      .prepare("SELECT * FROM academic_terms WHERE academic_year_id = ? ORDER BY sort_order ASC")
      .all(yearId);
  }
  return db.prepare("SELECT * FROM academic_terms ORDER BY sort_order ASC").all();
}

// Only one Academic Year may be active at a time. Setting a new active year
// does NOT change the active term automatically — an admin still explicitly
// activates a term within it, since a new year can be created ahead of time
// (e.g. to configure next year's calendar) without switching the live term.
function setActiveYear(yearId) {
  const year = db.prepare("SELECT * FROM academic_years WHERE id = ?").get(yearId);
  if (!year) throw new Error("Academic year not found.");
  const setActive = db.transaction(() => {
    db.prepare("UPDATE academic_years SET is_active = 0").run();
    db.prepare("UPDATE academic_years SET is_active = 1 WHERE id = ?").run(yearId);
  });
  setActive();
  return db.prepare("SELECT * FROM academic_years WHERE id = ?").get(yearId);
}

// Only one Academic Term may be active system-wide at a time (matches the
// comment in migrate.js's schema addition). Activating a term also activates
// its parent year, since a term can't be "current" while its year isn't.
function setActiveTerm(termId) {
  const term = db.prepare("SELECT * FROM academic_terms WHERE id = ?").get(termId);
  if (!term) throw new Error("Academic term not found.");
  const setActive = db.transaction(() => {
    db.prepare("UPDATE academic_years SET is_active = 0").run();
    db.prepare("UPDATE academic_years SET is_active = 1 WHERE id = ?").run(term.academic_year_id);
    db.prepare("UPDATE academic_terms SET is_active = 0").run();
    db.prepare("UPDATE academic_terms SET is_active = 1 WHERE id = ?").run(termId);
  });
  setActive();
  return db.prepare("SELECT * FROM academic_terms WHERE id = ?").get(termId);
}

module.exports = {
  getActiveYear,
  getActiveTerm,
  getActiveTermId,
  getTermById,
  getYearById,
  listYears,
  listTerms,
  setActiveYear,
  setActiveTerm,
};
