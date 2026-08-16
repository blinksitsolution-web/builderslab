// ============================================================
// Sponsor Bulk Registration engine.
//
// Implements Parts 1-5 & 7 of the Sponsor Bulk Registration remediation:
// a system-generated Excel template, upload validation, a registration
// preview priced by the ONE constitutional Pricing Engine (§15), and an
// idempotent, transactional commit that reuses the exact same
// account-creation / registration / enrollment pipeline individual
// coordinator registration already uses (routes/users.js), rather than a
// second, parallel one (§2.1 Single Ownership).
//
// What this file deliberately does NOT do:
//   - It does not compute a price anywhere. Every payable amount comes
//     from utils/fees.js's registrationBreakdown(), which is itself a
//     thin adapter over utils/pricingEngine.js (the one Pricing Engine,
//     §15.13) — using it here instead of pricingEngine directly means the
//     batch preview total is computed by the *exact same* function the
//     coordinator's later combined payment (POST /api/payments/:id/initiate)
//     will use, so the previewed total and the amount actually charged
//     can never diverge into two competing answers.
//   - It does not create a second payment path. Committing a batch only
//     creates learner accounts + pending_payment programme_enrollments
//     rows, exactly like routes/users.js's per-child flow already does.
//     Payment itself, and the automatic post-payment provisioning
//     (utils/paymentActivation.js), are the existing pipeline, untouched.
// ============================================================

const XLSX = require("xlsx");
const crypto = require("crypto");
const { v4: uuid } = require("uuid");
const bcrypt = require("bcryptjs");
const db = require("../db/db");
const { nextStudentCode } = require("./studentCode");
const { registrationBreakdown } = require("./fees");
const pricingEngine = require("./pricingEngine");
const {
  getLearningInstanceById,
  getInstanceTargets,
  activateEnrollmentCurriculum,
  deriveEnrollmentOperationalSnapshot,
} = require("./learningInstances");
const { getOfferingTypeForProgramme, programmeAllowsAudience } = require("./offeringTypeSettings");
const { resolveCampusByName } = require("./campusResolution");
const { resolveEntryClassForChild, generateChildPassword } = require("../routes/users");

// ---------------------------------------------------------------------
// Part 1 — the registration schema. Both the downloadable template and
// the upload parser/validator read from this ONE array, so a future
// registration field change (add/rename/remove a column) is made here
// once and is automatically reflected on both sides (§2.2).
// ---------------------------------------------------------------------
const TEMPLATE_FIELDS = [
  { key: "learnerType", header: "Learner Type (child or adult)", required: true },
  { key: "name", header: "Full Name", required: true },
  { key: "email", header: "Email (required for adult learners)", required: false },
  { key: "phone", header: "Phone", required: false },
  { key: "age", header: "Age (child learners, 3-21)", required: false },
  { key: "campus", header: "Campus", required: false },
  { key: "schoolName", header: "School Name (child learners)", required: false },
  { key: "ownRoboticsKit", header: "Owns Robotics Kit (Y/N)", required: false },
  { key: "educationLevel", header: "Education Level (adult: Senior High / Tertiary / None)", required: false },
  { key: "existingLearnerRef", header: "Existing Learner Email or Student ID (leave blank if new)", required: false },
];

function fileHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------
// Template generation (Part 1) — always built from TEMPLATE_FIELDS above,
// never a static file on disk, so it can never drift out of sync with
// what the validator below actually accepts.
// ---------------------------------------------------------------------
function buildTemplateWorkbook() {
  const headers = TEMPLATE_FIELDS.map((f) => f.header);
  const sample = TEMPLATE_FIELDS.map((f) => (f.key === "learnerType" ? "child" : ""));
  const sheet = XLSX.utils.aoa_to_sheet([headers, sample]);
  sheet["!cols"] = headers.map((h) => ({ wch: Math.max(18, Math.min(48, h.length + 2)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Learners");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ---------------------------------------------------------------------
// Upload parsing
// ---------------------------------------------------------------------
function parseUploadedWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const headerToKey = new Map(TEMPLATE_FIELDS.map((f) => [f.header.trim().toLowerCase(), f.key]));
  return raw.map((rawRow, idx) => {
    const row = { __rowNumber: idx + 2 }; // +2: header row is row 1, data starts row 2
    Object.entries(rawRow).forEach(([header, value]) => {
      const key = headerToKey.get(String(header).trim().toLowerCase());
      if (key) row[key] = typeof value === "string" ? value.trim() : value;
    });
    TEMPLATE_FIELDS.forEach((f) => {
      if (row[f.key] === undefined) row[f.key] = "";
    });
    return row;
  });
}

// ---------------------------------------------------------------------
// Part 2 — validation. Returns { rows, errors, duplicateRowNumbers }.
// `rows` carries every parsed row annotated with its resolved learnerType
// and any per-row errors; nothing is written to the database here.
// ---------------------------------------------------------------------
function normalizeYesNo(value) {
  const v = String(value || "").trim().toLowerCase();
  if (["y", "yes", "true", "1"].includes(v)) return true;
  if (["n", "no", "false", "0", ""].includes(v)) return false;
  return null; // invalid
}

function validateBatch({ sponsor, learningInstance, programme, rows }) {
  const errors = []; // { rowNumber, message }
  const seenKeys = new Map(); // dedupe key -> first rowNumber
  const duplicateRowNumbers = new Set();

  const annotated = rows.map((row) => {
    const rowErrors = [];
    const learnerType = String(row.learnerType || "").trim().toLowerCase();
    if (!["child", "adult"].includes(learnerType)) {
      rowErrors.push("Learner Type must be 'child' or 'adult'.");
    }
    if (!row.name || !String(row.name).trim()) {
      rowErrors.push("Full Name is required.");
    }

    if (learnerType === "adult") {
      // Email is only required for a brand-new adult account — an
      // existingLearnerRef row already identifies the account (by its
      // existing email or student ID), so no separate Email column value
      // is needed for it.
      if (!row.existingLearnerRef && (!row.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(row.email)))) {
        rowErrors.push("A valid Email is required for adult learners.");
      }
      if (row.educationLevel && !["Senior High", "Tertiary", "None"].includes(String(row.educationLevel).trim())) {
        rowErrors.push("Education Level must be Senior High, Tertiary, or None.");
      }
    } else if (learnerType === "child") {
      if (row.age !== "" && row.age !== undefined && row.age !== null) {
        const ageNum = Number(row.age);
        if (!Number.isInteger(ageNum) || ageNum < 3 || ageNum > 21) {
          rowErrors.push("Age must be a whole number between 3 and 21.");
        }
      }
      if (row.ownRoboticsKit !== "" && normalizeYesNo(row.ownRoboticsKit) === null) {
        rowErrors.push("Owns Robotics Kit must be Y or N.");
      }
      if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(row.email))) {
        rowErrors.push("Email, if provided for a child learner, must be a valid email address.");
      }
    }

    // Constitutional validation failure: the selected Programme Run's
    // Programme must actually accept this audience (§ programmeAllowsAudience).
    if (["child", "adult"].includes(learnerType) && programme) {
      const audienceKind = learnerType === "adult" ? "adult" : "parent-learner";
      if (!programmeAllowsAudience(programme, audienceKind)) {
        rowErrors.push(`This Programme Run doesn't accept ${learnerType} learners.`);
      }
    }

    // Campus (§3 / §2.1): the spreadsheet column is free text a coordinator
    // typed or pasted, so it must resolve against the canonical campuses
    // table rather than being trusted verbatim — an unrecognized value
    // (typo, different casing/spacing than the canonical record, or a
    // campus that doesn't exist) must surface as a row error here, not
    // silently write a value that later orphans the learner from every
    // campus-scoped admin's view (utils/rbac.js campusScopeFor()).
    let resolvedCampus = null;
    if (row.campus && String(row.campus).trim()) {
      resolvedCampus = resolveCampusByName(row.campus);
      if (!resolvedCampus) {
        rowErrors.push(`Campus "${String(row.campus).trim()}" doesn't match any existing campus — check spelling or leave blank.`);
      }
    }

    // Duplicate rows within the file — keyed by existing-learner reference
    // when given (that's the authoritative identity), otherwise by
    // learnerType+name+email.
    const dedupeKey = row.existingLearnerRef
      ? `ref:${String(row.existingLearnerRef).trim().toLowerCase()}`
      : `new:${learnerType}:${String(row.name).trim().toLowerCase()}:${String(row.email || "").trim().toLowerCase()}`;
    if (seenKeys.has(dedupeKey)) {
      duplicateRowNumbers.add(row.__rowNumber);
      rowErrors.push(`Duplicate of row ${seenKeys.get(dedupeKey)} in this file.`);
    } else {
      seenKeys.set(dedupeKey, row.__rowNumber);
    }

    // Duplicate learner account — a NEW adult learner's email must not
    // already exist as an account (that's an existing learner and belongs
    // in the Existing Learner Email/Student ID column instead).
    if (!row.existingLearnerRef && learnerType === "adult" && row.email) {
      const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(String(row.email).toLowerCase().trim());
      if (existing) {
        rowErrors.push("An account with this email already exists — enter it under 'Existing Learner Email or Student ID' instead.");
      }
    }

    rowErrors.forEach((message) => errors.push({ rowNumber: row.__rowNumber, message }));

    return {
      ...row,
      learnerType,
      // Canonical campus name (or null) — used at insert time instead of
      // the raw spreadsheet text so users.campus always matches
      // campuses.name exactly, per utils/campusResolution.js.
      campus: resolvedCampus ? resolvedCampus.name : row.campus,
      valid: rowErrors.length === 0,
      rowErrors,
    };
  });

  return { rows: annotated, errors, duplicateRowNumbers: Array.from(duplicateRowNumbers) };
}

// ---------------------------------------------------------------------
// Existing-learner resolution — matches by email or student_code.
// ---------------------------------------------------------------------
function findExistingLearner(ref) {
  if (!ref) return null;
  const value = String(ref).trim();
  return (
    db.prepare("SELECT * FROM users WHERE role = 'learner' AND (email = ? OR student_code = ?)").get(value.toLowerCase(), value) || null
  );
}

function learnerHasProgrammeRegistration(userId, programmeId) {
  return !!db.prepare("SELECT id FROM programme_enrollments WHERE user_id = ? AND programme_id = ?").get(userId, programmeId);
}

function learnerMissingCourseIds(userId, targetCourseIds) {
  if (!targetCourseIds.length) return [];
  const enrolled = new Set(db.prepare("SELECT course_id FROM enrollments WHERE user_id = ?").all(userId).map((r) => r.course_id));
  return targetCourseIds.filter((id) => !enrolled.has(id));
}

// ---------------------------------------------------------------------
// Part 3 — Registration Preview. Categorises every valid row and prices
// the batch using registrationBreakdown() (the constitutional Pricing
// Engine, §15) — the SAME function the eventual combined payment charges.
// Nothing here is written to the database.
// ---------------------------------------------------------------------
function buildPreview({ sponsor, coordinator, learningInstance, programme, entryClass, targetCourseIds, validRows }) {
  const categories = {
    newLearners: [],
    existingAttached: [],
    existingNotAttached: [],
    alreadyRegistered: [],
    alreadyEnrolled: [],
    needsRegistrationOnly: [],
    needsEnrollmentOnly: [],
    skipped: [], // { rowNumber, name, reason }
  };

  const chargeable = []; // rows that will need a NEW pending registration payment

  validRows.forEach((row) => {
    const existing = row.existingLearnerRef ? findExistingLearner(row.existingLearnerRef) : null;

    if (!existing) {
      categories.newLearners.push({ rowNumber: row.__rowNumber, name: row.name });
      chargeable.push(row);
      return;
    }

    const attached = existing.sponsor_id === sponsor.id;
    if (attached) categories.existingAttached.push({ rowNumber: row.__rowNumber, name: row.name, userId: existing.id });
    else if (existing.sponsor_id) {
      categories.skipped.push({ rowNumber: row.__rowNumber, name: row.name, reason: `Already sponsored by another organization.` });
      return;
    } else {
      categories.existingNotAttached.push({ rowNumber: row.__rowNumber, name: row.name, userId: existing.id });
    }

    const registered = learnerHasProgrammeRegistration(existing.id, programme.id);
    const missingCourses = learnerMissingCourseIds(existing.id, targetCourseIds);

    if (registered) categories.alreadyRegistered.push({ rowNumber: row.__rowNumber, name: row.name });
    if (registered && missingCourses.length === 0) {
      categories.alreadyEnrolled.push({ rowNumber: row.__rowNumber, name: row.name });
      categories.skipped.push({ rowNumber: row.__rowNumber, name: row.name, reason: "Already registered and enrolled in this Programme Run." });
      return;
    }
    if (!registered) {
      categories.needsRegistrationOnly.push({ rowNumber: row.__rowNumber, name: row.name });
      chargeable.push(row);
    } else if (missingCourses.length) {
      categories.needsEnrollmentOnly.push({ rowNumber: row.__rowNumber, name: row.name, missingCourses });
    }
  });

  // Sibling-rank volume discounts (registrationBreakdown -> the one
  // Pricing Engine) are ranked across EVERY pending_payment learner under
  // this coordinator at charge time — not just this batch's own rows —
  // because that's exactly the population POST /api/payments/:id/initiate
  // combines into one charge. Previewing this batch's rows in isolation
  // would rank them 1..N starting from "full rate", when in reality
  // they'll be appended after whatever's already pending and may land on
  // more (or fewer) discounted ranks. Prepending the coordinator's
  // existing pending learners, in the same joined_date/rowid order the
  // real charge uses, keeps the previewed total truthful to what will
  // actually be charged, without recomputing anything the Engine already
  // owns.
  //
  // Every entry here is marked sponsored (this batch's own rows always
  // are; a coordinator's other pending learners are marked from their
  // actual sponsor_id, not assumed) so registrationBreakdown correctly
  // never applies the sibling/multi-child Discount Policy to any of them
  // — that policy is for a paying parent's own children, not a Sponsor
  // Account's learners.
  const existingPending = coordinator
    ? db
        .prepare(
          "SELECT name, campus, school_name as schoolName, own_robotics_kit as ownRoboticsKit, class_id as classId, sponsor_id as sponsorId FROM users WHERE parent_id = ? AND role = 'learner' AND status = 'pending_payment' ORDER BY joined_date ASC, rowid ASC"
        )
        .all(coordinator.id)
    : [];

  const combinedList = [
    ...existingPending.map((r) => ({ name: r.name, campus: r.campus, schoolName: r.schoolName, ownRoboticsKit: !!r.ownRoboticsKit, classId: r.classId, sponsored: !!r.sponsorId })),
    ...chargeable.map((r) => ({
      name: r.name,
      campus: r.campus || null,
      schoolName: r.schoolName || null,
      ownRoboticsKit: normalizeYesNo(r.ownRoboticsKit) === true,
      classId: entryClass ? entryClass.id : null,
      sponsored: true,
    })),
  ];

  const { breakdown, totalGHS } = registrationBreakdown(combinedList);
  const existingPendingGHS = breakdown.slice(0, existingPending.length).reduce((sum, b) => sum + b.amountGHS, 0);
  const batchBreakdown = breakdown.slice(existingPending.length);
  const batchPayableGHS = totalGHS - existingPendingGHS;

  return {
    categories,
    pricing: {
      breakdown: batchBreakdown,
      totalPayableGHS: batchPayableGHS,
      // Present for transparency only — the payment endpoint always
      // combines everything pending under this coordinator into one
      // charge, so if there were already unpaid learners before this
      // batch, that's the number actually debited, not totalPayableGHS
      // alone. Zero when the coordinator had nothing else pending.
      existingPendingGHS,
      combinedChargeGHS: totalGHS,
      currency: "GHS",
      chargeableCount: chargeable.length,
    },
  };
}

// ---------------------------------------------------------------------
// Part 5 / Part 4 / Part 7 — commit. Transactional and idempotent: if the
// batch row is already 'committed', its stored commit_result_json is
// returned unchanged rather than re-processing anything (re-uploading /
// re-submitting the same batch can never double-create records).
// ---------------------------------------------------------------------
function nextLearnerEmail(name, studentCode) {
  const firstName = (String(name).split(" ")[0] || "learner").toLowerCase().replace(/[^a-z0-9]/g, "") || "learner";
  const codeDigits = studentCode.replace(/^DTL-\d\d/, "").replace(/-/g, "");
  return `${firstName}${codeDigits}@learners.dalijaytechhub.online`;
}

function createSponsoredLearnerRow({ row, sponsor, coordinator, entryClass, learningInstance, targetCourseIds }) {
  const learnerId = uuid();
  const password = generateChildPassword();
  const hash = bcrypt.hashSync(password, 12);
  const studentCode = nextStudentCode();
  const isAdult = row.learnerType === "adult";
  const email = isAdult ? String(row.email).toLowerCase().trim() : nextLearnerEmail(row.name, studentCode);

  db.prepare(
    `INSERT INTO users (id, role, name, email, password_hash, phone, campus, school_name, parent_id, status, payment_status, joined_date, class_id, student_code, own_robotics_kit, age, education_level, is_adult, sponsor_id, balance_owed_ghs, temp_password_plaintext)
     VALUES (@id, 'learner', @name, @email, @password_hash, @phone, @campus, @school_name, @parent_id, 'pending_payment', 'unpaid', date('now'), @class_id, @student_code, @own_robotics_kit, @age, @education_level, @is_adult, @sponsor_id, 0, @temp_password_plaintext)`
  ).run({
    id: learnerId,
    name: row.name,
    email,
    password_hash: hash,
    phone: row.phone || coordinator.phone || null,
    campus: row.campus ? String(row.campus).trim() : isAdult ? "Adult / self-paced" : null,
    school_name: !isAdult && row.schoolName ? String(row.schoolName).trim() : null,
    parent_id: coordinator.id,
    class_id: entryClass ? entryClass.id : null,
    student_code: studentCode,
    own_robotics_kit: normalizeYesNo(row.ownRoboticsKit) ? 1 : 0,
    age: !isAdult && row.age !== "" && row.age !== undefined && row.age !== null ? Number(row.age) : null,
    education_level: isAdult ? (["Senior High", "Tertiary", "None"].includes(row.educationLevel) ? row.educationLevel : "None") : null,
    is_adult: isAdult ? 1 : 0,
    sponsor_id: sponsor.id,
    temp_password_plaintext: password,
  });

  // §17/§20.2 — every Enrollment-writing path resolves its operational
  // context through the ONE canonical resolver
  // (utils/learningInstances.js's deriveEnrollmentOperationalSnapshot),
  // exactly as routes/auth.js and routes/enrolments.js already do. Sponsor
  // Bulk Registration has no per-row Operational Group selection (every
  // row in a batch shares one Programme Run/entry Class, mirroring the
  // Kids STEM default-entry-class flow this reuses), so operationalGroupId
  // is never requested here — never a second, ad hoc computation of
  // Delivery Mode/Campus/Academic Period/Course Group that could disagree
  // with what the same entry Class + Run produces via any other
  // registration path.
  const operationalSnapshot = deriveEnrollmentOperationalSnapshot({
    classRow: entryClass,
    instanceId: learningInstance.id,
    courseIds: targetCourseIds,
  });
  const pricingSnapshot = pricingEngine.buildPricingSnapshot({
    learningInstanceId: learningInstance.id,
    classId: entryClass ? entryClass.id : null,
    operationalGroupId: operationalSnapshot.operationalGroupId,
    userId: learnerId,
    legacyAdjustmentContext: {
      campus: row.campus ? String(row.campus).trim() : isAdult ? "Adult / self-paced" : null,
      school_name: !isAdult && row.schoolName ? String(row.schoolName).trim() : null,
      own_robotics_kit: normalizeYesNo(row.ownRoboticsKit),
    },
  });
  const financialPolicySnapshot = pricingEngine.buildFinancialPolicySnapshot({ learningInstanceId: learningInstance.id });
  db.prepare(
    `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id, sponsor_id, requested_course_ids, delivery_mode, campus_id, academic_period_id, course_group_id, operational_group_id, pricing_snapshot, financial_policy_snapshot)
     VALUES (?, ?, ?, ?, 1, 'pending_payment', 'unpaid', date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    learnerId,
    learningInstance.programme_id,
    entryClass ? entryClass.id : null,
    learningInstance.id,
    sponsor.id,
    JSON.stringify(targetCourseIds),
    operationalSnapshot.deliveryMode,
    operationalSnapshot.campusId,
    operationalSnapshot.academicPeriodId,
    operationalSnapshot.courseGroupId,
    operationalSnapshot.operationalGroupId,
    pricingSnapshot,
    financialPolicySnapshot
  );

  return { learnerId, studentCode, email, password };
}

function attachExistingLearnerToSponsor(userId, sponsor) {
  if (sponsor.max_learners != null) {
    const sponsoredCount = db.prepare("SELECT COUNT(*) c FROM users WHERE sponsor_id = ? AND role = 'learner'").get(sponsor.id).c;
    if (sponsoredCount >= sponsor.max_learners) {
      throw Object.assign(new Error(`${sponsor.name} has reached its limit of ${sponsor.max_learners} sponsored learner(s).`), { skip: true });
    }
  }
  db.prepare("UPDATE users SET sponsor_id = ? WHERE id = ?").run(sponsor.id, userId);
}

function registerExistingLearner({ userId, sponsor, entryClass, learningInstance, targetCourseIds }) {
  // Same canonical resolver as createSponsoredLearnerRow above — see that
  // function's comment. An existing learner being newly registered into
  // this Run through the sponsor must end up with an Enrollment record
  // indistinguishable in shape from a brand-new sponsored learner's.
  const operationalSnapshot = deriveEnrollmentOperationalSnapshot({
    classRow: entryClass,
    instanceId: learningInstance.id,
    courseIds: targetCourseIds,
  });
  const pricingSnapshot = pricingEngine.buildPricingSnapshot({
    learningInstanceId: learningInstance.id,
    classId: entryClass ? entryClass.id : null,
    operationalGroupId: operationalSnapshot.operationalGroupId,
    userId,
    // Existing learner — their own campus/school_name/own_robotics_kit
    // already on file (unlike createSponsoredLearnerRow above, there's no
    // fresh signup `row` to read these from here).
    legacyAdjustmentContext: db.prepare("SELECT campus, school_name, own_robotics_kit FROM users WHERE id = ?").get(userId) || {},
  });
  const financialPolicySnapshot = pricingEngine.buildFinancialPolicySnapshot({ learningInstanceId: learningInstance.id });
  db.prepare(
    `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id, sponsor_id, requested_course_ids, delivery_mode, campus_id, academic_period_id, course_group_id, operational_group_id, pricing_snapshot, financial_policy_snapshot)
     VALUES (?, ?, ?, ?, 0, 'pending_payment', 'unpaid', date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    userId,
    learningInstance.programme_id,
    entryClass ? entryClass.id : null,
    learningInstance.id,
    sponsor.id,
    JSON.stringify(targetCourseIds),
    operationalSnapshot.deliveryMode,
    operationalSnapshot.campusId,
    operationalSnapshot.academicPeriodId,
    operationalSnapshot.courseGroupId,
    operationalSnapshot.operationalGroupId,
    pricingSnapshot,
    financialPolicySnapshot
  );
}

function commitBatch({ batch, sponsor, coordinator, learningInstance, programme, entryClass, targetCourseIds, validRows }) {
  if (batch.status === "committed") {
    return JSON.parse(batch.commit_result_json || "{}");
  }

  const result = {
    learnersCreated: [],
    sponsorshipAssociationsCreated: [],
    registrationsCreated: [],
    enrollmentsGranted: [],
    skipped: [],
  };

  const tx = db.transaction(() => {
    validRows.forEach((row) => {
      const existing = row.existingLearnerRef ? findExistingLearner(row.existingLearnerRef) : null;

      if (!existing) {
        // Part 4 — brand new learner.
        const created = createSponsoredLearnerRow({ row, sponsor, coordinator, entryClass, learningInstance, targetCourseIds });
        result.learnersCreated.push({ rowNumber: row.__rowNumber, name: row.name, ...created });
        result.registrationsCreated.push({ rowNumber: row.__rowNumber, userId: created.learnerId });
        return;
      }

      if (existing.sponsor_id && existing.sponsor_id !== sponsor.id) {
        result.skipped.push({ rowNumber: row.__rowNumber, name: row.name, reason: "Already sponsored by another organization." });
        return;
      }

      if (!existing.sponsor_id) {
        try {
          attachExistingLearnerToSponsor(existing.id, sponsor);
          result.sponsorshipAssociationsCreated.push({ rowNumber: row.__rowNumber, userId: existing.id });
        } catch (e) {
          if (e.skip) {
            result.skipped.push({ rowNumber: row.__rowNumber, name: row.name, reason: e.message });
            return;
          }
          throw e;
        }
      }

      const registered = learnerHasProgrammeRegistration(existing.id, programme.id);
      const missingCourses = learnerMissingCourseIds(existing.id, targetCourseIds);

      if (registered && missingCourses.length === 0) {
        result.skipped.push({ rowNumber: row.__rowNumber, name: row.name, reason: "Already registered and enrolled in this Programme Run." });
        return;
      }

      if (!registered) {
        // Reuse the existing learner account (Part 4) — create the
        // registration only, exactly the shape createSponsoredLearnerRow
        // uses for a brand-new account.
        registerExistingLearner({ userId: existing.id, sponsor, entryClass, learningInstance, targetCourseIds });
        result.registrationsCreated.push({ rowNumber: row.__rowNumber, userId: existing.id });
      } else if (missingCourses.length) {
        // Already an active, paid registration in this Programme Run —
        // no new payment is owed, so grant the missing Course(s) directly
        // through the same Enrollment Activation pipeline a successful
        // payment would call (utils/learningInstances.js), rather than
        // creating a second pending_payment row for nothing to actually pay.
        const granted = activateEnrollmentCurriculum(existing.id, entryClass ? entryClass.id : null, missingCourses, learningInstance.id);
        result.enrollmentsGranted.push({ rowNumber: row.__rowNumber, userId: existing.id, courseIds: granted });
      }
    });

    db.prepare(
      "UPDATE sponsor_bulk_batches SET status = 'committed', commit_result_json = ?, committed_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(result), batch.id);
  });
  tx();

  return result;
}

module.exports = {
  TEMPLATE_FIELDS,
  fileHash,
  buildTemplateWorkbook,
  parseUploadedWorkbook,
  validateBatch,
  buildPreview,
  commitBatch,
  findExistingLearner,
};
