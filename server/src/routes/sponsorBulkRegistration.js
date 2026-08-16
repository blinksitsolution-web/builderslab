// ============================================================
// Sponsor Bulk Registration — mounted at
// /api/sponsors/:sponsorId/bulk-registration (see server.js).
//
// Authorization (Part 6): a Sponsor Account's own coordinator (role
// 'parent', sponsor_id === :sponsorId) may operate on their own Sponsor
// Account only; staff holding sponsors.edit may act on any Sponsor
// Account (the same admin-oversight bypass every other sponsor-scoped
// endpoint in this codebase grants). This is enforced here, per-request,
// rather than only in the UI — "Backend authorization must enforce
// Sponsor Account ownership."
// ============================================================

const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { createUploadPipeline } = require("../middleware/upload");
const { getLearningInstanceById, getInstanceTargets } = require("../utils/learningInstances");
const { getOfferingTypeForProgramme } = require("../utils/offeringTypeSettings");
const { resolveEntryClassForChild } = require("./users");
const {
  TEMPLATE_FIELDS,
  fileHash,
  buildTemplateWorkbook,
  parseUploadedWorkbook,
  validateBatch,
  buildPreview,
  commitBatch,
} = require("../utils/sponsorBulkRegistration");
const XLSX = require("xlsx");

const router = express.Router({ mergeParams: true });

const { upload, verify } = createUploadPipeline("DOCUMENT", "sponsor-bulk-registration", 5);

function requireSponsorAccess(req, res, next) {
  const sponsor = db.prepare("SELECT * FROM sponsors WHERE id = ?").get(req.params.sponsorId);
  if (!sponsor) return res.status(404).json({ error: "Sponsor not found." });

  const isOwnCoordinator = req.user.role === "parent" && req.user.sponsor_id === sponsor.id;
  const isStaff = req.user.role === "admin" || req.user.role === "instructor";
  if (!isOwnCoordinator && !isStaff) {
    return res.status(403).json({ error: "You don't have permission to manage bulk registration for this Sponsor Account." });
  }
  if (isStaff && !isOwnCoordinator) {
    // Staff acting on behalf of a sponsor still needs sponsors.edit, same
    // as every other staff-mediated sponsor mutation in this codebase.
    const { hasPermission } = require("../utils/rbac");
    if (!hasPermission(req.user, "sponsors.edit")) {
      return res.status(403).json({ error: "You don't have permission to manage bulk registration for this Sponsor Account." });
    }
  }
  if (!sponsor.is_active) {
    return res.status(400).json({ error: "This sponsor is deactivated — reactivate it before registering learners." });
  }
  req.sponsor = sponsor;
  next();
}

// Resolves + validates the Learning Instance (Programme Run) a batch is
// being registered into. Registration never bypasses the Programme Run
// (§16) — an inactive or unknown instance is rejected outright, before
// any file is even parsed.
function resolveLearningInstanceOrFail(learningInstanceId, res) {
  const instance = learningInstanceId ? getLearningInstanceById(learningInstanceId) : null;
  if (!instance || !instance.programmeId) {
    res.status(400).json({ error: "Select a valid, active Programme Run (Learning Instance) to register learners into." });
    return null;
  }
  if (instance.status !== "active") {
    res.status(400).json({ error: "This Programme Run isn't Active — bulk registration is only available for an Active Programme Run." });
    return null;
  }
  const programme = db.prepare("SELECT * FROM programmes WHERE id = ?").get(instance.programmeId);
  if (!programme) {
    res.status(400).json({ error: "This Programme Run's Programme could not be found." });
    return null;
  }
  const targets = getInstanceTargets(instance.id).filter((t) => t.targetType === "course" && t.courseId);
  const targetCourseIds = targets.map((t) => t.courseId);
  const entryClass = resolveEntryClassForChild(instance.programmeId);
  return {
    instance: { id: instance.id, programme_id: instance.programmeId, name: instance.name },
    programme,
    targetCourseIds,
    entryClass,
  };
}

// ---------------------------------------------------------------------
// Part 1 — "select an active Learning Instance". A minimal, read-only
// picker list scoped to what a coordinator actually needs (id/name/
// programme/course-target count) — no existing self-service catalogue
// endpoint a parent-role account can call already covers this, so this
// is a plain read, not a second copy of any Programme Run business logic.
// ---------------------------------------------------------------------
router.get("/learning-instances", requireAuth, requireSponsorAccess, (req, res) => {
  const rows = db
    .prepare(
      `SELECT li.id, li.name, p.name as programme_name
       FROM learning_instances li
       JOIN programmes p ON p.id = li.programme_id
       WHERE li.status = 'active'
       ORDER BY p.name ASC, li.created_at DESC`
    )
    .all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name || r.programme_name,
      programmeName: r.programme_name,
      courseTargetCount: getInstanceTargets(r.id).filter((t) => t.targetType === "course").length,
    }))
  );
});

// ---------------------------------------------------------------------
// Part 1 — GET the system-generated Excel registration template.
// ---------------------------------------------------------------------
router.get("/template", requireAuth, requireSponsorAccess, (req, res) => {
  const ctx = resolveLearningInstanceOrFail(req.query.learningInstanceId, res);
  if (!ctx) return;
  const buffer = buildTemplateWorkbook();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="bulk-registration-template.xlsx"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(buffer);
});

// ---------------------------------------------------------------------
// Part 2 & 3 — upload, validate, and preview. Nothing is written to the
// learner/registration/enrollment tables here — only the batch row itself
// (the validation+preview result cache) is persisted, keyed by content
// hash so re-uploading the identical file resolves to the same batch.
// ---------------------------------------------------------------------
router.post("/validate", requireAuth, requireSponsorAccess, upload.single("file"), verify, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload the completed registration template (.xlsx)." });
  const ctx = resolveLearningInstanceOrFail(req.body.learningInstanceId, res);
  if (!ctx) return;
  const { instance, programme, targetCourseIds, entryClass } = ctx;

  // Which coordinator account these learners will belong to (parent_id).
  // When the coordinator is the one calling this themselves, it's them —
  // no ambiguity. When staff is acting on a Sponsor Account's behalf (the
  // same admin-oversight bypass requireSponsorAccess grants elsewhere),
  // staff must say which of the sponsor's coordinators owns the batch;
  // there's no single correct default to guess.
  let coordinator = req.user;
  if (req.user.role !== "parent") {
    const coordinatorId = req.body.coordinatorId;
    coordinator = coordinatorId ? db.prepare("SELECT * FROM users WHERE id = ? AND role = 'parent' AND sponsor_id = ?").get(coordinatorId, req.sponsor.id) : null;
    if (!coordinator) {
      return res.status(400).json({ error: "Select which coordinator account these learners should belong to (coordinatorId)." });
    }
  }

  const fs = require("fs");
  const buffer = fs.readFileSync(req.file.path);
  const hash = fileHash(buffer);

  const existingBatch = db.prepare("SELECT * FROM sponsor_bulk_batches WHERE sponsor_id = ? AND file_hash = ?").get(req.sponsor.id, hash);
  if (existingBatch) {
    return res.json({
      ok: true,
      batchId: existingBatch.id,
      status: existingBatch.status,
      validation: JSON.parse(existingBatch.validation_json || "{}"),
      preview: JSON.parse(existingBatch.preview_json || "{}"),
      reused: true,
    });
  }

  let rows;
  try {
    rows = parseUploadedWorkbook(buffer);
  } catch (e) {
    return res.status(400).json({ error: "Couldn't read this file — make sure it's the downloaded template (.xlsx)." });
  }
  if (!rows.length) {
    return res.status(400).json({ error: "This file has no learner rows." });
  }

  const validation = validateBatch({ sponsor: req.sponsor, learningInstance: instance, programme, rows });
  const validRows = validation.rows.filter((r) => r.valid);
  const preview = buildPreview({
    sponsor: req.sponsor,
    coordinator,
    learningInstance: instance,
    programme,
    entryClass,
    targetCourseIds,
    validRows,
  });

  const batchId = uuid();
  db.prepare(
    `INSERT INTO sponsor_bulk_batches (id, sponsor_id, coordinator_id, learning_instance_id, file_name, file_hash, status, row_count, validation_json, preview_json)
     VALUES (?, ?, ?, ?, ?, ?, 'validated', ?, ?, ?)`
  ).run(
    batchId,
    req.sponsor.id,
    coordinator.id,
    instance.id,
    req.file.originalname || "bulk-registration.xlsx",
    hash,
    rows.length,
    JSON.stringify({ errors: validation.errors, duplicateRowNumbers: validation.duplicateRowNumbers, rows: validation.rows }),
    JSON.stringify(preview)
  );

  res.json({
    ok: true,
    batchId,
    status: "validated",
    validation: { errors: validation.errors, duplicateRowNumbers: validation.duplicateRowNumbers, rowCount: rows.length, validRowCount: validRows.length },
    preview,
  });
});

// GET a previously validated/committed batch back (re-display after navigating away).
router.get("/:batchId", requireAuth, requireSponsorAccess, (req, res) => {
  const batch = db.prepare("SELECT * FROM sponsor_bulk_batches WHERE id = ? AND sponsor_id = ?").get(req.params.batchId, req.sponsor.id);
  if (!batch) return res.status(404).json({ error: "Batch not found." });
  res.json({
    batchId: batch.id,
    status: batch.status,
    learningInstanceId: batch.learning_instance_id,
    fileName: batch.file_name,
    validation: JSON.parse(batch.validation_json || "{}"),
    preview: JSON.parse(batch.preview_json || "{}"),
    commitResult: batch.commit_result_json ? JSON.parse(batch.commit_result_json) : null,
  });
});

// ---------------------------------------------------------------------
// Downloadable validation/audit report (Part 2's "downloadable validation
// report" and Part 7's audit trail, in one artifact).
// ---------------------------------------------------------------------
router.get("/:batchId/report", requireAuth, requireSponsorAccess, (req, res) => {
  const batch = db.prepare("SELECT * FROM sponsor_bulk_batches WHERE id = ? AND sponsor_id = ?").get(req.params.batchId, req.sponsor.id);
  if (!batch) return res.status(404).json({ error: "Batch not found." });

  const validation = JSON.parse(batch.validation_json || "{}");
  const preview = JSON.parse(batch.preview_json || "{}");
  const commitResult = batch.commit_result_json ? JSON.parse(batch.commit_result_json) : null;

  const wb = XLSX.utils.book_new();

  const errorRows = [["Row", "Issue"], ...(validation.errors || []).map((e) => [e.rowNumber, e.message])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(errorRows), "Validation Errors");

  const cats = (preview.categories || {});
  const previewRows = [["Category", "Row", "Name", "Detail"]];
  Object.entries(cats).forEach(([category, entries]) => {
    (entries || []).forEach((e) => previewRows.push([category, e.rowNumber, e.name, e.reason || (e.missingCourses ? `Missing: ${e.missingCourses.length} course(s)` : "")]));
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(previewRows), "Preview");

  if (commitResult) {
    const commitRows = [["Outcome", "Row", "Detail"]];
    (commitResult.learnersCreated || []).forEach((e) => commitRows.push(["Learner account created", e.rowNumber, `${e.name} — Student ID ${e.studentCode}`]));
    (commitResult.sponsorshipAssociationsCreated || []).forEach((e) => commitRows.push(["Sponsorship association created", e.rowNumber, e.userId]));
    (commitResult.registrationsCreated || []).forEach((e) => commitRows.push(["Registration created", e.rowNumber, e.userId]));
    (commitResult.enrollmentsGranted || []).forEach((e) => commitRows.push(["Enrollment granted", e.rowNumber, `${(e.courseIds || []).length} course(s)`]));
    (commitResult.skipped || []).forEach((e) => commitRows.push(["Skipped", e.rowNumber, `${e.name} — ${e.reason}`]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(commitRows), "Processing Result");
  }

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="bulk-registration-report.xlsx"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(buffer);
});

// ---------------------------------------------------------------------
// Part 4 & 5 & 7 — commit the batch: create/attach/register/enroll,
// transactionally and idempotently. Payment itself is NOT handled here —
// once committed, every new/updated learner sits in the exact same
// pending_payment state routes/users.js's individual flow already
// produces, so the coordinator's existing combined-charge payment
// (POST /api/payments/:coordinatorId/initiate, type: "registration")
// picks the whole batch up automatically — no parallel payment workflow.
// ---------------------------------------------------------------------
router.post("/:batchId/commit", requireAuth, requireSponsorAccess, (req, res) => {
  const batch = db.prepare("SELECT * FROM sponsor_bulk_batches WHERE id = ? AND sponsor_id = ?").get(req.params.batchId, req.sponsor.id);
  if (!batch) return res.status(404).json({ error: "Batch not found." });

  const ctx = resolveLearningInstanceOrFail(batch.learning_instance_id, res);
  if (!ctx) return;
  const { instance, programme, targetCourseIds, entryClass } = ctx;

  const validation = JSON.parse(batch.validation_json || "{}");
  const validRows = (validation.rows || []).filter((r) => r.valid);
  if (!validRows.length && batch.status !== "committed") {
    return res.status(400).json({ error: "This batch has no valid rows to process — fix the validation errors and re-upload." });
  }

  // batch.coordinator_id was resolved once, correctly, at /validate time
  // (see above) — the actual coordinator whose account new learners'
  // parent_id will point to, not necessarily whoever is calling commit
  // (which may be staff acting on the sponsor's behalf).
  const coordinator = db.prepare("SELECT * FROM users WHERE id = ?").get(batch.coordinator_id);
  if (!coordinator) return res.status(400).json({ error: "This batch's coordinator account could not be found." });

  const result = commitBatch({ batch, sponsor: req.sponsor, coordinator, learningInstance: instance, programme, entryClass, targetCourseIds, validRows });

  res.json({ ok: true, batchId: batch.id, status: "committed", result, coordinatorId: coordinator.id });
});

module.exports = router;
