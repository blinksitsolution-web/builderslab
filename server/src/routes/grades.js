const express = require("express");
const db = require("../db/db");
const { requireAuth, requireRole, requireSelfParentOrStaff, requireActiveAccess } = require("../middleware/auth");
const { getSetting } = require("../utils/settings");
const { getTermById } = require("../utils/academicTerm");
const { moduleResult, transcriptWeights, gradeFor } = require("../utils/transcriptEngine");
const {
  getActiveInstanceIdForCourse,
  getCourseInstanceLabel,
  getLearningInstanceById,
  getAcademicPeriodById,
  getLearnerActiveTargetsInPeriod,
  getLearnerLearningInstances,
  resolveConstitutionalTermId,
  resolveConstitutionalTermIdForCourse,
} = require("../utils/learningInstances");
const { instructorHasCourseAccess, isLearnerAssignedToInstructor } = require("../utils/instructorScope");

const router = express.Router();

// Manual Midterm/End of Term entry (legacy path — kept for modules not using
// the Examination panel; transcriptEngine.moduleResult() prefers an actual
// Examination attempt when one exists, see utils/transcriptEngine.js).
// ABRS v2.2 Compliance Remediation: term_id derives from this module's own
// Active Programme Run's current Academic Period -> Academic Term (§8.2/
// §19) — a caller cannot backdate a grade into a past term through this
// endpoint (same rule as before), since "records from one term must never
// overwrite another" — historical corrections are a separate admin tool.
// The former institution-wide "active term" fallback (resolveTermId) is
// gone: if this Run's Academic Calendar isn't configured yet, the write is
// rejected rather than silently drifting onto whatever term happens to be
// globally active for some unrelated Run.
router.patch("/:userId", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const { courseId, term, score } = req.body;
  if (!courseId || !["midterm", "endOfTerm"].includes(term)) {
    return res.status(400).json({ error: "courseId and a valid term ('midterm' or 'endOfTerm') are required." });
  }
  // Instructor Assignment scope enforcement (ABRS v2.2 §8.2/AUTHORIZATION)
  // — an instructor may only enter a grade for a Course they're assigned
  // to teach, and only for a learner within their assigned operational
  // scope. Backend-enforced independently of whatever the frontend
  // already filters down to.
  if (req.user.role === "instructor") {
    if (!instructorHasCourseAccess(req.user.id, courseId)) {
      return res.status(403).json({ error: "You aren't assigned to teach this module." });
    }
    if (!isLearnerAssignedToInstructor(req.user.id, req.params.userId)) {
      return res.status(403).json({ error: "This learner is outside your assigned scope." });
    }
  }
  const learningInstanceId = getActiveInstanceIdForCourse(courseId);
  const activeTermId = resolveConstitutionalTermId(learningInstanceId);
  if (!activeTermId) {
    return res.status(409).json({
      error: "This module's Programme Run has no Academic Period linked to an Academic Term yet — an admin must configure the Run's Academic Calendar (Configure Academic Periods) before grades can be entered.",
    });
  }
  const column = term === "midterm" ? "midterm" : "end_of_term";
  const existing = db
    .prepare("SELECT * FROM grades WHERE user_id=? AND course_id=? AND term_id=?")
    .get(req.params.userId, courseId, activeTermId);
  if (existing) {
    db.prepare(`UPDATE grades SET ${column} = ? WHERE user_id=? AND course_id=? AND term_id=?`).run(
      score,
      req.params.userId,
      courseId,
      activeTermId
    );
  } else {
    db.prepare(
      `INSERT INTO grades (user_id, course_id, midterm, end_of_term, term_id, learning_instance_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(req.params.userId, courseId, term === "midterm" ? score : null, term === "endOfTerm" ? score : null, activeTermId, learningInstanceId);
  }
  res.json({ ok: true });
});

// 1–5 stars from the overall average across every graded module's Total for
// this term (not the old midterm/end-of-term-only average).
function starsFromAverage(avg) {
  if (avg == null) return 0;
  if (avg >= 90) return 5;
  if (avg >= 80) return 4;
  if (avg >= 70) return 3;
  if (avg >= 60) return 2;
  return 1;
}

// Each Academic Term generates its own independent transcript. Defaults to
// the active term; pass ?termId=<id> to view a historical term's transcript
// (nothing here ever writes, so this is safe for anyone with view access).
//
// Phase 9 — period-scoped transcripts. Pass BOTH ?learningInstanceId=<id>
// and ?academicPeriodId=<id> together to instead view a transcript
// deterministically scoped to one specific run's one specific academic
// period (Semester 1/2 or Term 1/2/3) — as opposed to the default behavior
// above, which spans every module the learner is enrolled in for a given
// school-wide Academic Term, potentially across several different runs.
// The requested period must already be linked to a school-wide Academic
// Term (learning_instance_academic_periods.academic_term_id, set by an
// admin via PATCH .../academic-periods/:periodId) — every assessment-record
// table this engine reads from is keyed by that global term_id, and this
// deliberately never GUESSES which term a period "must" mean when no link
// has been configured, per this task's back-compat rules.
// Phase 10 — self-service catalog for the period-scoped transcript
// selector (learner/parent UI has no access to GET /api/learning-instances,
// which is staff-permission-gated). Returns only this learner's own
// Learning Instances that have an academic structure configured, each with
// its academicPeriods (id/name/sequence) — exactly what the UI needs to
// build a "Learning Instance -> Semester/Term" picker, and nothing else
// about the instance (targets, payment config internals, etc). No access
// restriction gate here (same as the payments listing) — a restricted
// learner/parent should still be able to see which periods exist.
router.get("/:userId/transcript-options", requireAuth, requireSelfParentOrStaff("userId"), (req, res) => {
  if (req.user.role === "instructor" && !isLearnerAssignedToInstructor(req.user.id, req.params.userId)) {
    return res.status(403).json({ error: "This learner is outside your assigned scope." });
  }
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.userId);
  if (!user) return res.status(404).json({ error: "Not found." });
  const instances = getLearnerLearningInstances(req.params.userId).map((instance) => ({
    id: instance.id,
    name: instance.name,
    status: instance.status,
    academicPeriods: (instance.academicPeriods || []).map((p) => ({
      id: p.id,
      name: p.name,
      sequence: p.sequence,
      academicTermId: p.academicTermId,
    })),
  }));
  res.json({ learningInstances: instances });
});

router.get("/:userId/transcript", requireAuth, requireSelfParentOrStaff("userId"), requireActiveAccess("userId"), (req, res) => {
  if (req.user.role === "instructor" && !isLearnerAssignedToInstructor(req.user.id, req.params.userId)) {
    return res.status(403).json({ error: "This learner is outside your assigned scope." });
  }
  const user = db.prepare("SELECT id, name, campus, class_id, is_adult FROM users WHERE id = ?").get(req.params.userId);
  if (!user) return res.status(404).json({ error: "Not found." });

  const { learningInstanceId, academicPeriodId } = req.query;
  const periodScoped = !!(learningInstanceId || academicPeriodId);

  let term, instance = null, period = null, courseIds;

  if (periodScoped) {
    if (!learningInstanceId || !academicPeriodId) {
      return res.status(400).json({ error: "Both learningInstanceId and academicPeriodId are required to view a period-scoped transcript." });
    }
    instance = getLearningInstanceById(learningInstanceId);
    if (!instance) return res.status(404).json({ error: "Learning Instance not found." });
    period = getAcademicPeriodById(learningInstanceId, academicPeriodId);
    if (!period) return res.status(404).json({ error: "Academic period not found for this Learning Instance." });
    if (!period.academicTermId) {
      return res.status(409).json({
        error: "This academic period isn't linked to an Academic Term yet — an admin must link it before a period-scoped transcript can be generated.",
      });
    }
    term = getTermById(period.academicTermId);
    if (!term) return res.status(404).json({ error: "Academic term not found." });

    // The period's own applicable targets (Phase 5), intersected with what
    // this learner is actually enrolled/placed in (Phase 5's
    // getLearnerActiveTargetsInPeriod) — never "every module the learner
    // happens to be enrolled in anywhere", which is the default (non-period)
    // path just below.
    const activeTargets = getLearnerActiveTargetsInPeriod(period.id, req.params.userId);
    const enrolledCourseIds = new Set(
      db.prepare("SELECT course_id FROM enrollments WHERE user_id = ?").all(req.params.userId).map((r) => r.course_id)
    );
    const courseIdSet = new Set();
    activeTargets.forEach((t) => {
      if (t.courseId) courseIdSet.add(t.courseId);
      else if (t.programmeId) {
        db.prepare("SELECT id FROM courses WHERE programme_id = ?")
          .all(t.programmeId)
          .forEach((m) => { if (enrolledCourseIds.has(m.id)) courseIdSet.add(m.id); });
      }
    });
    courseIds = [...courseIdSet].filter((mid) => enrolledCourseIds.has(mid));
  } else {
    // ABRS v2.2 Compliance Remediation. Two legitimate paths here, neither
    // of which is "an independently-selected institution-wide active
    // term":
    //   1. An explicit ?termId= — the caller (admin/parent) intentionally
    //      naming a specific, already-known Academic Term entity to
    //      review (e.g. a legacy term that predates the Learning
    //      Instance/Academic Period model). This is an explicit choice of
    //      a known id, not a silently-applied default, so it's preserved
    //      exactly as before.
    //   2. No termId given (the common "my transcript" case, and every
    //      existing caller's default) — term is no longer defaulted to
    //      whatever term happens to be globally active. Each enrolled
    //      module's row instead resolves its OWN Academic Term from ITS
    //      OWN Active Programme Run's current Academic Period
    //      (resolveConstitutionalTermIdForCourse, below in rows.map) —
    //      exactly the same per-Run chain the period-scoped path above
    //      uses, just applied per module instead of to one pre-selected
    //      Run. `term` stays null here and is filled in afterward, once
    //      every row's resolved term is known, purely for the response's
    //      display header (see mixedAcademicTerms below).
    if (req.query.termId) {
      term = getTermById(req.query.termId);
      if (!term) return res.status(404).json({ error: "Academic term not found." });
    } else {
      term = null;
    }
    courseIds = db.prepare("SELECT course_id FROM enrollments WHERE user_id = ?").all(req.params.userId).map((r) => r.course_id);
  }
  // id/title/programme_id in one pass — programme_id (nullable — see
  // migrate.js's "legacy/global Builders Lab module" convention) is what
  // lets each row show which Programme its Module belongs to, not just
  // which Learning Instance.
  const courseRows = db.prepare("SELECT id, title, programme_id FROM courses").all();
  const courseById = new Map(courseRows.map((m) => [m.id, m]));
  const programmeNameById = new Map(db.prepare("SELECT id, name FROM programmes").all().map((p) => [p.id, p.name]));
  const titleFor = (mid) => (courseById.get(mid) || {}).title || mid;

  const weights = transcriptWeights();
  // Stage 4F: transcriptEngine.moduleResult() always works in raw
  // percentages (0-100) internally — that's what the Total/Grade math,
  // retake eligibility, and the Certificate Engine all key off, and none
  // of that changes here. The transcript *display*, though, is meant to
  // show each component as points out of its own weight (10/20/70,
  // matching transcriptWeights) rather than a raw percentage — e.g. an
  // 80% Tests score at the default 10% weight reads as 8/10, not 80.
  // Converting once, right here at the transcript response boundary
  // (never in transcriptEngine.js, and not again in the frontend), is
  // what keeps this from being silently double-converted.
  const toWeightedScore = (rawPercent, weight) => (rawPercent != null ? Math.round(((rawPercent * weight) / 100) * 10) / 10 : null);

  const rows = courseIds.map((mid) => {
    // ABRS v2.2 Compliance Remediation: period-scoped and explicit-termId
    // requests use the single `term` already resolved above (uniformly,
    // by explicit caller choice). The default view has no single `term`
    // — each module resolves its own Academic Term from its own Active
    // Programme Run's current Academic Period (never a shared
    // institution-wide default), so two modules on different Runs with
    // different calendars are never incorrectly coerced onto the same
    // term.
    const rowTermId = term ? term.id : resolveConstitutionalTermIdForCourse(mid);
    const r = moduleResult(req.params.userId, mid, rowTermId, periodScoped ? instance.id : undefined);
    // Which Learning Instance(s) actually produced this row's data — read
    // from the underlying records themselves (grades/examination_attempts/
    // ca_attempts/assignment_submissions), never guessed. `null` here means
    // this module's records predate Learning Instances (or none is
    // configured for it) — not an error, just no run to label yet. If the
    // records disagree (a genuine cross-run mix), `mixed: true` and every
    // contributing run is listed explicitly rather than picking one.
    const label = getCourseInstanceLabel(req.params.userId, mid, rowTermId);
    const moduleRow = courseById.get(mid);
    return {
      courseId: mid,
      title: titleFor(mid),
      programmeId: moduleRow ? moduleRow.programme_id : null,
      programmeName: moduleRow && moduleRow.programme_id ? programmeNameById.get(moduleRow.programme_id) || null : null,
      tests: toWeightedScore(r.tests, weights.tests),
      midterm: toWeightedScore(r.midterm, weights.midterm),
      endOfTerm: toWeightedScore(r.endOfTerm, weights.endOfTerm),
      testsMax: weights.tests,
      midtermMax: weights.midterm,
      endOfTermMax: weights.endOfTerm,
      total: r.total != null ? Math.round(r.total * 10) / 10 : null,
      grade: r.grade,
      interpretation: r.interpretation,
      // "Completion information where available" — a module with a
      // computed Total has been graded/completed for this term; the
      // Learning Instance's own status (e.g. "completed") is surfaced too
      // via learningInstanceStatus below, when one run cleanly applies.
      completed: r.total != null,
      learningInstanceId: label.instance ? label.instance.id : null,
      learningInstanceName: label.instance ? (label.instance.name || label.instance.programmeName || label.instance.courseTitle || "Unnamed run") : null,
      learningInstanceStatus: label.instance ? label.instance.status : null,
      mixedLearningInstances: !!label.mixed,
      // Only populated when mixed — every run whose records fed into this
      // row, so the transcript can list them explicitly instead of ever
      // implying a single clean run when there wasn't one.
      contributingLearningInstances: label.mixed ? label.instances.map((i) => ({ id: i.id, name: i.name || i.programmeName || i.courseTitle || "Unnamed run", status: i.status })) : null,
      // Which Academic Term this specific row was actually resolved
      // against — always present so the default (non-period-scoped) view
      // stays fully transparent even when different modules land on
      // different terms (see mixedAcademicTerms below).
      academicTermId: rowTermId || null,
    };
  });

  // ABRS v2.2 Compliance Remediation — the default (non-period-scoped,
  // no-explicit-termId) view has no single, pre-selected `term`; derive
  // one for display purposes ONLY from what the rows above actually
  // resolved, never from an institution-wide default. If every row that
  // resolved a term agrees, use it for the header exactly like the
  // explicit/period-scoped paths. If rows disagree (genuinely different
  // Programme Runs with different calendars) or none resolved at all,
  // `term` stays null and `mixedAcademicTerms` tells the caller why the
  // header fields are empty — never silently picks one.
  let mixedAcademicTerms = false;
  if (!term) {
    const resolvedTermIds = [...new Set(rows.map((r) => r.academicTermId).filter(Boolean))];
    if (resolvedTermIds.length === 1) {
      term = getTermById(resolvedTermIds[0]);
    } else if (resolvedTermIds.length > 1) {
      mixedAcademicTerms = true;
    }
  }

  // Total Raw Score: transcript-only cumulative statistic — the sum of every
  // module's Total for this term. Deliberately NOT used to derive any
  // module's Grade (see utils/transcriptEngine.js — Highest Grade is derived
  // from Highest Score, never from this cumulative figure).
  const totals = rows.map((r) => r.total).filter((v) => v != null);
  const totalRawScore = totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) * 10) / 10 : null;
  const overallAverage = totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : null;
  const stars = starsFromAverage(overallAverage);

  const branding = getSetting("branding", { logoPath: "/images/DTH.jpg", signaturePath: null, adminSignatureName: "" });

  const primaryEnrollmentForTranscript = db
    .prepare("SELECT participation_structure FROM programme_enrollments WHERE user_id = ? AND is_primary = 1")
    .get(req.params.userId);
  const isIndividualTranscript = primaryEnrollmentForTranscript && primaryEnrollmentForTranscript.participation_structure === "individual_course";
  const className = isIndividualTranscript ? null : user.class_id ? (db.prepare("SELECT name FROM classes WHERE id = ?").get(user.class_id) || {}).name || null : null;
  const participationStructure = primaryEnrollmentForTranscript ? primaryEnrollmentForTranscript.participation_structure || null : null;

  // Attendance summary, scoped to this term.
  // ABRS v2.2 Compliance Remediation: for period-scoped and explicit-termId
  // requests, `term` is one deliberately-chosen id, applied uniformly
  // exactly as before. For the default view (no single `term`), a row
  // counts if it predates term-scoping (term_id IS NULL, same "legacy
  // record" rule used everywhere else in this engine) or if its own
  // stamped term_id matches what its own course's Active Programme Run
  // currently resolves to via the ownership chain — never a single
  // globally-selected term applied across every course indiscriminately.
  let attendanceRows;
  if (term) {
    attendanceRows = db
      .prepare(
        `SELECT status FROM attendance WHERE learner_id = ? AND (term_id = ? OR term_id IS NULL)
         ${periodScoped ? "AND (learning_instance_id = ? OR learning_instance_id IS NULL)" : ""}`
      )
      .all(req.params.userId, term.id, ...(periodScoped ? [instance.id] : []));
  } else {
    const courseTermIdCache = new Map();
    const resolveForCourse = (courseId) => {
      if (!courseId) return null;
      if (!courseTermIdCache.has(courseId)) courseTermIdCache.set(courseId, resolveConstitutionalTermIdForCourse(courseId));
      return courseTermIdCache.get(courseId);
    };
    attendanceRows = db
      .prepare("SELECT status, course_id, term_id FROM attendance WHERE learner_id = ?")
      .all(req.params.userId)
      .filter((a) => a.term_id == null || a.term_id === resolveForCourse(a.course_id));
  }
  const totalSessions = attendanceRows.length;
  const present = attendanceRows.filter((a) => a.status === "present").length;
  const late = attendanceRows.filter((a) => a.status === "late").length;
  const absent = attendanceRows.filter((a) => a.status === "absent").length;
  const attendanceRate = totalSessions ? Math.round(((present + late) / totalSessions) * 100) : null;
  const attendance = { totalSessions, present, late, absent, attendanceRate };

  res.json({
    learner: user,
    academicYear: term ? term.year_name : null,
    academicTerm: term ? term.name : null,
    termId: term ? term.id : null,
    // ABRS v2.2 Compliance Remediation — true only for the default view
    // when the learner's enrolled modules resolved to more than one
    // distinct Academic Term via their respective Programme Runs (e.g.
    // modules from two different Runs on different calendars). The
    // per-row `academicTermId` on each entry in `rows` always identifies
    // exactly which term that row itself was resolved against.
    mixedAcademicTerms,
    // Phase 9 — present (non-null) only for a period-scoped transcript, so
    // existing consumers of the default (non-period) shape see no change.
    learningInstanceId: periodScoped ? instance.id : null,
    learningInstanceName: periodScoped ? (instance.name || null) : null,
    academicPeriodId: periodScoped ? period.id : null,
    academicPeriodName: periodScoped ? period.name : null,
    className,
    participationStructure,
    attendance,
    rows,
    weights,
    totalRawScore,
    overallAverage,
    stars,
    // "Overall Performance" — plain-language label from the same
    // Grade/Interpretation scheme, based on the overall average.
    overallPerformance: overallAverage != null ? gradeFor(overallAverage).interpretation : null,
    branding,
    issued: new Date().toISOString().slice(0, 10),
  });
});

module.exports = router;
