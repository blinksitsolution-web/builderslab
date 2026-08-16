const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const {
  getActiveYear,
  getActiveTerm,
  listYears,
  listTerms,
  setActiveYear,
  setActiveTerm,
} = require("../utils/academicTerm");

const router = express.Router();

// Open-ended on purpose (matches academic_calendar_periods.type comment in
// schema.sql) — validated here so typos are caught, but adding a new period
// type later only means adding a string to this array, not a migration.
const PERIOD_TYPES = [
  "registration",
  "lesson",
  "midterm",
  "end_of_term_exam",
  "retake",
  "payment_deadline",
  "transcript_release",
  "certificate_release",
  "holiday",
];

// ============================================================
// Academic Years
// ============================================================

// Any signed-in user can list years/terms — the year/term switcher (for
// viewing historical transcripts, payments, etc.) is available to admins,
// instructors, parents and learners alike, not just admins.
router.get("/years", requireAuth, (req, res) => {
  res.json({ years: listYears(), active: getActiveYear() });
});

router.post("/years", requireAuth, requireRole("admin"), (req, res) => {
  const { name, startDate, endDate } = req.body;
  if (!name) return res.status(400).json({ error: "name is required." });
  const id = uuid();
  db.prepare("INSERT INTO academic_years (id, name, start_date, end_date, is_active) VALUES (?, ?, ?, ?, 0)").run(
    id,
    name,
    startDate || null,
    endDate || null
  );
  res.json(db.prepare("SELECT * FROM academic_years WHERE id = ?").get(id));
});

router.patch("/years/:id", requireAuth, requireRole("admin"), (req, res) => {
  const year = db.prepare("SELECT * FROM academic_years WHERE id = ?").get(req.params.id);
  if (!year) return res.status(404).json({ error: "Academic year not found." });
  const name = req.body.name ?? year.name;
  const startDate = req.body.startDate ?? year.start_date;
  const endDate = req.body.endDate ?? year.end_date;
  db.prepare("UPDATE academic_years SET name = ?, start_date = ?, end_date = ? WHERE id = ?").run(
    name,
    startDate,
    endDate,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM academic_years WHERE id = ?").get(req.params.id));
});

// Sets the Active Academic Year. Does not change the active term — an admin
// can prep next year's record ahead of time without disrupting the live term.
router.post("/years/:id/activate", requireAuth, requireRole("admin"), (req, res) => {
  try {
    res.json(setActiveYear(req.params.id));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ============================================================
// Academic Terms
// ============================================================

router.get("/terms", requireAuth, (req, res) => {
  res.json({ terms: listTerms(req.query.yearId), active: getActiveTerm() });
});

router.get("/terms/active", requireAuth, (req, res) => {
  const term = getActiveTerm();
  if (!term) return res.status(404).json({ error: "No active Academic Term is configured yet." });
  res.json(term);
});

router.post("/terms", requireAuth, requireRole("admin"), (req, res) => {
  const { academicYearId, name, sortOrder } = req.body;
  if (!academicYearId || !name) return res.status(400).json({ error: "academicYearId and name are required." });
  const year = db.prepare("SELECT id FROM academic_years WHERE id = ?").get(academicYearId);
  if (!year) return res.status(404).json({ error: "Academic year not found." });
  const id = uuid();
  try {
    db.prepare(
      "INSERT INTO academic_terms (id, academic_year_id, name, sort_order, is_active) VALUES (?, ?, ?, ?, 0)"
    ).run(id, academicYearId, name, sortOrder || 0);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      return res.status(409).json({ error: `A term named "${name}" already exists for that academic year.` });
    }
    throw e;
  }
  res.json(db.prepare("SELECT * FROM academic_terms WHERE id = ?").get(id));
});

router.patch("/terms/:id", requireAuth, requireRole("admin"), (req, res) => {
  const term = db.prepare("SELECT * FROM academic_terms WHERE id = ?").get(req.params.id);
  if (!term) return res.status(404).json({ error: "Academic term not found." });
  const name = req.body.name ?? term.name;
  const sortOrder = req.body.sortOrder ?? term.sort_order;
  db.prepare("UPDATE academic_terms SET name = ?, sort_order = ? WHERE id = ?").run(name, sortOrder, req.params.id);
  res.json(db.prepare("SELECT * FROM academic_terms WHERE id = ?").get(req.params.id));
});

// "Term Transition": starting a new Academic Term. Activating a term also
// activates its parent year (see utils/academicTerm.js). This does not copy
// or touch any existing records — every academic table already carries its
// own term_id, so switching the active term simply changes what future
// writes get stamped with; everything already written keeps its original
// term_id and remains permanently accessible.
router.post("/terms/:id/activate", requireAuth, requireRole("admin"), (req, res) => {
  try {
    res.json(setActiveTerm(req.params.id));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ============================================================
// Academic Calendar Periods (registration, lesson, midterm, end-of-term exam,
// retake, payment deadline, transcript release, certificate release, holiday)
// ============================================================

router.get("/periods", requireAuth, (req, res) => {
  const termId = req.query.termId || (getActiveTerm() || {}).id;
  if (!termId) return res.json({ periods: [] });
  let periods;
  if (req.query.type) {
    periods = db
      .prepare("SELECT * FROM academic_calendar_periods WHERE term_id = ? AND type = ? ORDER BY start_date ASC")
      .all(termId, req.query.type);
  } else {
    periods = db
      .prepare("SELECT * FROM academic_calendar_periods WHERE term_id = ? ORDER BY type ASC, start_date ASC")
      .all(termId);
  }
  res.json({ periods });
});

router.post("/periods", requireAuth, requireRole("admin"), (req, res) => {
  const { termId, type, label, startDate, endDate } = req.body;
  if (!termId || !type || !startDate) {
    return res.status(400).json({ error: "termId, type and startDate are required." });
  }
  if (!PERIOD_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${PERIOD_TYPES.join(", ")}` });
  }
  const term = db.prepare("SELECT id FROM academic_terms WHERE id = ?").get(termId);
  if (!term) return res.status(404).json({ error: "Academic term not found." });
  const id = uuid();
  db.prepare(
    "INSERT INTO academic_calendar_periods (id, term_id, type, label, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, termId, type, label || null, startDate, endDate || null);
  res.json(db.prepare("SELECT * FROM academic_calendar_periods WHERE id = ?").get(id));
});

router.patch("/periods/:id", requireAuth, requireRole("admin"), (req, res) => {
  const period = db.prepare("SELECT * FROM academic_calendar_periods WHERE id = ?").get(req.params.id);
  if (!period) return res.status(404).json({ error: "Calendar period not found." });
  if (req.body.type && !PERIOD_TYPES.includes(req.body.type)) {
    return res.status(400).json({ error: `type must be one of: ${PERIOD_TYPES.join(", ")}` });
  }
  const type = req.body.type ?? period.type;
  const label = req.body.label ?? period.label;
  const startDate = req.body.startDate ?? period.start_date;
  const endDate = req.body.endDate ?? period.end_date;
  db.prepare("UPDATE academic_calendar_periods SET type = ?, label = ?, start_date = ?, end_date = ? WHERE id = ?").run(
    type,
    label,
    startDate,
    endDate,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM academic_calendar_periods WHERE id = ?").get(req.params.id));
});

router.delete("/periods/:id", requireAuth, requireRole("admin"), (req, res) => {
  const result = db.prepare("DELETE FROM academic_calendar_periods WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Calendar period not found." });
  res.json({ ok: true });
});

module.exports = router;
