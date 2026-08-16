const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { resolveClassOperationalConfig } = require("../utils/learningInstances");
const { getInstructorClassIds } = require("../utils/instructorScope");

const router = express.Router();

// ---------------------------------------------------------------------
// ABRS v2.2 §11 / §13.5 / Appendix A-9 — Operational Group responsibility
// removal.
//
// `classes` is Programme Level ONLY (§13). Tuition Fee, Delivery Mode and
// Campus are Operational Group overrides (§11.3), owned exclusively by
// the `operational_groups` table scoped to a Programme Run (§8.2, §19).
// This route file must never again be a second writer of those three
// facts — a second writer is exactly the "two owners" failure §2.1
// forbids, and is the specific defect Appendix A-9 named ("every existing
// read of `classes` for its non-progression purpose... must be
// re-pointed at the new table; missing one is a silent data-consistency
// defect").
//
// `fee_ghs`/`delivery_mode`/`campus_id` remain as columns on `classes`
// (dropping them is out of scope until Phase 5's monitoring window
// closes — migrate.js's v39 comment and this document's §20.1 "additive,
// never destructive" discipline), and GET responses below continue to
// resolve them for any class that still carries a pre-migration value
// (via resolveClassOperationalConfig's Class-then-Run fallback), so
// historical data keeps reading exactly as it did before. What changes
// here is that this route no longer accepts WRITES to any of the three —
// creating or renaming a Programme Level can never again set an
// Operational Group field. New operational configuration belongs on
// POST/PATCH /api/learning-instances/:id/operational-groups.
// ---------------------------------------------------------------------
const OPERATIONAL_GROUP_FIELDS_MOVED = {
  feeGHS: "Tuition Fee",
  deliveryMode: "Delivery Mode",
  campusId: "Campus",
};

// Returns a 400 error message if the request body tries to set any field
// that Operational Groups (§11.3), not Programme Levels, now own — null
// if the body is clean. Used by both POST and PATCH below so neither can
// drift out of sync with the other.
function rejectOperationalGroupFields(body) {
  const offending = Object.keys(OPERATIONAL_GROUP_FIELDS_MOVED).filter((k) => body[k] !== undefined);
  if (!offending.length) return null;
  const names = offending.map((k) => OPERATIONAL_GROUP_FIELDS_MOVED[k]).join(", ");
  return (
    `${names} ${offending.length > 1 ? "are" : "is"} configured on Operational Groups, not Programme Levels ` +
    `(ABRS v2.2 §11.3). Create or edit an Operational Group under this Programme's active Programme Run instead ` +
    `(POST/PATCH /api/learning-instances/:id/operational-groups).`
  );
}

// Programme Levels ("Learning Groups") are fully admin-configurable for
// every Programme, Kids STEM included — create, rename, reorder, and
// extend (e.g. a future "Pioneer" or "Advanced" level) with no code
// changes. Nothing in this file singles out any particular name as
// protected; entry-level resolution and promotion elsewhere in this
// codebase already work purely off sort_order scoped to programme_id
// (see resolveEntryClass in routes/auth.js and nextClass in
// routes/promotion.js), never off a hardcoded name like "Foundation".

// A class only counts as one of the protected Kids STEM rows if it BOTH has
// one of the protected names AND actually belongs to a programme under the
// Kids STEM offering type. Checking the name alone would incorrectly lock
// down any other programme's Learning Group that happens to reuse one of
// these names (e.g. a Bootcamp or Adult Professional "Framework" cohort) —
// exactly the kind of name-only identification the Learning Offering
// architecture must not do. Learning Offering Type (via programme_id) is
// the primary context; the name is only ever a secondary, display detail.
// Delivery Mode (On-Campus vs Online) — see migrate.js's
// classes.delivery_mode/campus_id comment for the full rationale. NULL
// means "unspecified/legacy" (every class created before this feature)
// and is never validated here — it's the byte-for-byte-unchanged state.
// HYBRID added per the Builders' Lab architecture spec — a class that runs
// both an on-campus and an online component. Treated like ON_CAMPUS for
// campus validation below (it still has a physical component, so a campus
// is required), which keeps the existing ON_CAMPUS/ONLINE branch logic
// everywhere else in this file and in routes/auth.js unchanged: those only
// ever special-case "=== 'ONLINE'" and treat everything else as carrying a
// campus, which is exactly the behaviour HYBRID also needs.
// Resolves what this Learning Group should be *called* in the UI: its own
// override, else its programme's override, else its offering type's default
// (Class | Batch/Cohort | Training Group), else the historical "Class"
// fallback for any row that predates the Unified Learning Architecture.
function toClassDto(row) {
  // v31 — Delivery Mode/Campus/Fee are resolved through the Class's
  // Programme Run now (Class-level values remain valid, back-compat
  // per-batch overrides — see resolveClassOperationalConfig) rather than
  // read as raw, always-authoritative Class columns.
  const effective = resolveClassOperationalConfig(row);
  let campusName = row.campus_name || null;
  if (effective.campusId && effective.campusId !== row.campus_id) {
    const campusRow = db.prepare("SELECT name FROM campuses WHERE id = ?").get(effective.campusId);
    campusName = campusRow ? campusRow.name : null;
  }
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    programmeId: row.programme_id || null,
    programmeName: row.programme_name || null,
    // Learning Offering Type context — required alongside programmeId so
    // every consumer (admin grouped checklists, the instructor cascade,
    // terminology resolution) can tell *which* offering type this Learning
    // Group belongs to without falling back to name-based guessing. Mirrors
    // modules.js's toModule()/MODULE_SELECT_WITH_OFFERING_TYPE exactly, so a
    // Bootcamp "Weekday" cohort and a Kids STEM "Foundation" class are never
    // conflated just because neither carried this before.
    offeringTypeId: row.offering_type_id || null,
    offeringTypeSlug: row.offering_type_slug || null,
    offeringTypeName: row.offering_type_name || null,
    displayLabel: row.display_label || row.programme_group_label || row.offering_type_group_label || "Class",
    // Per-Batch/Cohort fee override, resolved against its Programme Run's
    // fee when the Class itself hasn't set one. null = fall back further,
    // to the offering-type/global fee (utils/fees.js).
    feeGHS: effective.feeGHS,
    // Delivery Mode (On-Campus vs Online), resolved against its Programme
    // Run's configured Delivery Modes when the Class itself hasn't set
    // one. null for every legacy/unspecified Class whose Run also hasn't
    // configured Delivery Modes. campusName is resolved here (not just
    // campusId) so registration UI can display it read-only without a
    // second call.
    deliveryMode: effective.deliveryMode,
    campusId: effective.campusId,
    campusName,
  };
}

const CLASS_SELECT = `
  SELECT c.*, p.name as programme_name, p.learning_group_label as programme_group_label,
         t.id as offering_type_id, t.slug as offering_type_slug, t.name as offering_type_name,
         t.learning_group_label as offering_type_group_label,
         cm.name as campus_name
  FROM classes c
  LEFT JOIN programmes p ON p.id = c.programme_id
  LEFT JOIN learning_offering_types t ON t.id = p.offering_type_id
  LEFT JOIN campuses cm ON cm.id = c.campus_id
`;

// Public: Learning Groups (Batch/Cohort/Training Group) under one programme,
// for the public self-registration flow — an adult picking a Batch/Cohort
// before an account (and therefore a session) exists yet. Requires
// ?programmeId= (unlike the authenticated list below, this never returns
// every Learning Group unfiltered, since that would leak the full Kids STEM
// Foundation/Framework/Skyline roster structure to an anonymous caller for
// no reason). Reuses the same toClassDto()/CLASS_SELECT as the admin route.
// Optional ?deliveryMode=ON_CAMPUS|ONLINE narrows to classes carrying that
// exact mode — lets the public registration UI show only On-Campus (or
// only Online) Batches/Cohorts once the learner has picked a Delivery
// Mode. Omitting it (every pre-existing frontend build, and any programme
// with no delivery-mode classes yet) returns every class under the
// programme unfiltered, exactly as before this feature existed.
router.get("/public", (req, res) => {
  if (!req.query.programmeId) return res.status(400).json({ error: "programmeId is required." });
  const sql = CLASS_SELECT + " WHERE c.programme_id = ? ORDER BY c.sort_order ASC, c.name ASC";
  const rows = db.prepare(sql).all(req.query.programmeId);
  let dtos = rows.map(toClassDto);
  // v31 — filtered against the resolved (Class override, else Programme
  // Run) Delivery Mode, not just the raw column, so a Run that configures
  // Delivery Mode at the Run level (with no per-Class override) still
  // filters correctly.
  if (req.query.deliveryMode) {
    dtos = dtos.filter((c) => c.deliveryMode === req.query.deliveryMode);
  }
  // Minimum delivery/campus metadata registration needs — campusName only
  // (never the full campus row/location/contact details) for ON_CAMPUS
  // classes; deliveryMode/campusId are null for legacy/unspecified classes.
  res.json({
    classes: dtos.map((c) => ({
      id: c.id,
      name: c.name,
      displayLabel: c.displayLabel,
      sortOrder: c.sortOrder,
      feeGHS: c.feeGHS,
      deliveryMode: c.deliveryMode,
      campusId: c.campusId,
      campusName: c.campusName,
    })),
  });
});

// Any signed-in user: every Learning Group, optionally narrowed to one
// programme. With no filter this still returns Foundation/Framework/Skyline
// first (by sort_order) exactly as before — existing Kids STEM callers are
// unaffected.
router.get("/", requireAuth, (req, res) => {
  let sql = CLASS_SELECT;
  const params = [];
  if (req.query.programmeId) {
    sql += " WHERE c.programme_id = ?";
    params.push(req.query.programmeId);
  }
  sql += " ORDER BY c.sort_order ASC, c.name ASC";
  const rows = db.prepare(sql).all(...params);
  res.json({ classes: rows.map(toClassDto) });
});

// Instructor: only the Programme Level(s) admin has assigned them to
// (instructor_assignments — utils/instructorScope.js).
router.get("/mine", requireAuth, requireRole("instructor"), (req, res) => {
  const myClassIds = getInstructorClassIds(req.user.id);
  if (!myClassIds.length) return res.json({ classes: [] });
  const rows = db
    .prepare(`${CLASS_SELECT} WHERE c.id IN (${myClassIds.map(() => "?").join(",")}) ORDER BY c.sort_order ASC, c.name ASC`)
    .all(...myClassIds);
  res.json({ classes: rows.map(toClassDto) });
});

// Admin: create an additional Learning Group under any programme — this is
// what lets Adult Batches/Cohorts, Corporate Training Groups and additional
// Kids sections be created without a code change, while the three protected
// Kids STEM class names stay exactly as seeded.
router.post("/", requireAuth, requireRole("admin"), (req, res) => {
  const { name, programmeId, sortOrder, displayLabel } = req.body;
  if (!name || !programmeId) return res.status(400).json({ error: "name and programmeId are required." });
  const ogError = rejectOperationalGroupFields(req.body);
  if (ogError) return res.status(400).json({ error: ogError });
  if (!db.prepare("SELECT id FROM programmes WHERE id = ?").get(programmeId)) {
    return res.status(400).json({ error: "programmeId does not match a known programme." });
  }
  if (db.prepare("SELECT id FROM classes WHERE name = ? AND programme_id = ?").get(name, programmeId)) {
    return res.status(409).json({ error: "A Learning Group with this name already exists under this programme." });
  }
  const id = uuid();
  // fee_ghs/delivery_mode/campus_id are intentionally left NULL on every
  // newly-created row — see the Operational Group note above. They exist
  // as columns purely so pre-migration rows keep resolving; no code path
  // may write a non-NULL value into them again.
  db.prepare(
    "INSERT INTO classes (id, name, sort_order, programme_id, display_label) VALUES (?, ?, ?, ?, ?)"
  ).run(id, name, sortOrder ?? 0, programmeId, displayLabel || null);
  res.json(toClassDto(db.prepare(CLASS_SELECT + " WHERE c.id = ?").get(id)));
});

router.patch("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const row = db.prepare("SELECT * FROM classes WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Learning Group not found." });
  const { name, sortOrder, displayLabel } = req.body;
  const ogError = rejectOperationalGroupFields(req.body);
  if (ogError) return res.status(400).json({ error: ogError });
  // fee_ghs/delivery_mode/campus_id are deliberately untouched here (not
  // even re-written to their existing value) — this endpoint is no longer
  // a writer of those facts at all, per the Operational Group note above.
  db.prepare("UPDATE classes SET name=?, sort_order=?, display_label=? WHERE id=?").run(
    name ?? row.name,
    sortOrder ?? row.sort_order,
    displayLabel !== undefined ? displayLabel : row.display_label,
    req.params.id
  );
  res.json(toClassDto(db.prepare(CLASS_SELECT + " WHERE c.id = ?").get(req.params.id)));
});

router.delete("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const row = db.prepare("SELECT * FROM classes WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Learning Group not found." });
  const inUse = db.prepare("SELECT COUNT(*) as n FROM users WHERE class_id = ?").get(req.params.id).n;
  if (inUse > 0) return res.status(409).json({ error: `${inUse} learner(s) are assigned to this Learning Group — reassign them first.` });
  db.prepare("DELETE FROM classes WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

