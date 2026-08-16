const fs = require("fs");
const path = require("path");
const { v4: uuid } = require("uuid");
const db = require("./db");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

// ============================================================
// Course Group upgrade-path rename. MUST run before the Module -> Course
// rename directly below: this frees up the name `courses` (the OLD
// grouping-layer table, pre-existing on any database old enough to have
// it) by renaming it to `course_groups` first. Only then is it safe for
// the Module -> Course rename to claim `courses` for the primary
// curriculum unit — doing it in the other order would crash with "table
// courses already exists" the moment a database has both an old `modules`
// table AND an old `courses` grouping table at once (exactly the shape any
// pre-existing production database has). A brand-new database has neither
// old name, so this block is a no-op for it.
{
  const courseGroupsAlreadyExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='course_groups'")
    .get();
  const oldCoursesTableExists =
    !courseGroupsAlreadyExists &&
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='courses'").get();
  if (oldCoursesTableExists) {
    db.exec("ALTER TABLE courses RENAME TO course_groups");
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='course_class_modules'").get()) {
      db.exec("ALTER TABLE course_class_modules RENAME TO course_group_courses");
      db.exec("ALTER TABLE course_group_courses RENAME COLUMN course_id TO course_group_id");
    }
    // modules.course_id / programme_enrollments.course_id (the grouping FK)
    // are renamed here too, while the base table is still called `modules`
    // — the Module -> Course rename block below will fold module_id ->
    // course_id in general afterward, but this specific column (a
    // reference to the *grouping* table, not the module's own identity)
    // must land on course_group_id, not course_id, so it isn't swept up
    // and misnamed by that more general rename.
    const modulesColsForGroupRename = db.prepare("PRAGMA table_info(modules)").all().map((c) => c.name);
    if (modulesColsForGroupRename.includes("course_id")) {
      db.exec("ALTER TABLE modules RENAME COLUMN course_id TO course_group_id");
    }
    const peColsForGroupRename = db.prepare("PRAGMA table_info(programme_enrollments)").all().map((c) => c.name);
    if (peColsForGroupRename.includes("course_id")) {
      db.exec("ALTER TABLE programme_enrollments RENAME COLUMN course_id TO course_group_id");
    }
    console.log("✅ Renamed legacy courses/course_class_modules/modules.course_id/programme_enrollments.course_id to course_groups/course_group_courses/*.course_group_id (data preserved).");
  }
}

// ============================================================
// Module -> Course rename. schema.sql (executed right below) now defines
// the primary curriculum unit as `courses` (module_id -> course_id)
// directly, per the required academic hierarchy: Institution -> Learning
// Offering Type -> Programme -> Programme Level -> Programme Run ->
// Academic Structure -> Academic Period -> Course -> Lesson. This MUST run
// before db.exec(schema) below: schema.sql's CREATE TABLE IF NOT EXISTS
// courses(...) would otherwise silently create a brand-new EMPTY `courses`
// table alongside an existing database's still-`modules`-named table,
// leaving all its real data (attendance, grades, exams, notes, projects,
// certificates, instructor assignments, enrolments) orphaned under the old
// name. Renamed in place instead — same ids, same rows, zero data loss —
// and only fires on a database that still has the pre-rename shape; a
// brand-new database never does, so this block is a no-op for it.
{
  const hasOldModulesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='modules'").get();
  if (hasOldModulesTable) {
    db.exec("ALTER TABLE modules RENAME TO courses");
    const courseIdRenames = [
      ["enrollments", "module_id", "course_id"],
      ["progress", "module_id", "course_id"],
      ["unlocks", "module_id", "course_id"],
      ["grades", "module_id", "course_id"],
      ["projects", "module_id", "course_id"],
      ["notes", "module_id", "course_id"],
      ["ai_quiz_cache", "module_id", "course_id"],
      ["attendance", "module_id", "course_id"],
      ["course_topics", "module_id", "course_id"],
      ["examinations", "module_id", "course_id"],
      ["continuous_assessments", "module_id", "course_id"],
      ["retake_attempts", "module_id", "course_id"],
      ["issued_certificates", "module_id", "course_id"],
      ["learning_instances", "module_id", "course_id"],
      ["learning_instance_targets", "module_id", "course_id"],
    ];
    for (const [table, oldCol, newCol] of courseIdRenames) {
      const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      if (!exists) continue; // table not created yet on a very old DB — later CREATE TABLE IF NOT EXISTS below will make it with the new name directly
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (cols.includes(oldCol)) {
        db.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
      }
    }
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instructor_modules'").get()) {
      db.exec("ALTER TABLE instructor_modules RENAME TO instructor_courses");
      const icCols = db.prepare("PRAGMA table_info(instructor_courses)").all().map((c) => c.name);
      if (icCols.includes("module_id")) db.exec("ALTER TABLE instructor_courses RENAME COLUMN module_id TO course_id");
    }
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='programme_enrollments'").get()) {
      const peCols = db.prepare("PRAGMA table_info(programme_enrollments)").all().map((c) => c.name);
      if (peCols.includes("requested_module_ids")) {
        db.exec("ALTER TABLE programme_enrollments RENAME COLUMN requested_module_ids TO requested_course_ids");
      }
    }
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_instance_targets'").get()) {
      // SQLite can't ALTER a CHECK constraint in place, and the old CHECK's
      // target_type literal is still 'module' even after the column rename
      // above (renaming module_id -> course_id only rewrites the COLUMN
      // NAME reference inside the CHECK expression, not the unrelated
      // string VALUE 'module') — so a plain UPDATE here would immediately
      // fail that CHECK. Rebuild instead: rename -> recreate fresh (with
      // target_type IN ('programme','course')) -> copy rows across,
      // translating the value as we go -> drop old. learning_instance_targets
      // is defined inline further below in this same file (not schema.sql),
      // so its new shape is recreated inline here rather than via
      // db.exec(schema) — this exact CREATE TABLE is kept in lockstep with
      // the one below since both must agree on the table's final shape.
      db.exec("ALTER TABLE learning_instance_targets RENAME TO learning_instance_targets_old_coursechk");
      db.exec(`
CREATE TABLE learning_instance_targets (
  id                   TEXT PRIMARY KEY,
  learning_instance_id TEXT NOT NULL REFERENCES learning_instances(id) ON DELETE CASCADE,
  target_type          TEXT NOT NULL CHECK (target_type IN ('programme', 'course')),
  programme_id         TEXT REFERENCES programmes(id),
  course_id            TEXT REFERENCES courses(id),
  is_primary           INTEGER NOT NULL DEFAULT 0,
  instance_status      TEXT NOT NULL DEFAULT 'upcoming',
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (target_type = 'programme' AND programme_id IS NOT NULL AND course_id IS NULL)
    OR (target_type = 'course' AND course_id IS NOT NULL AND programme_id IS NULL)
  )
);`);
      db.exec(`
        INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, course_id, is_primary, instance_status, created_at)
        SELECT id, learning_instance_id, CASE WHEN target_type = 'module' THEN 'course' ELSE target_type END, programme_id, course_id, is_primary, instance_status, created_at
        FROM learning_instance_targets_old_coursechk
      `);
      db.exec("DROP TABLE learning_instance_targets_old_coursechk");
    }
    console.log("✅ Renamed legacy modules/module_id (and instructor_modules, requested_module_ids, target_type='module') to courses/course_id/instructor_courses/requested_course_ids/target_type='course' across every dependent table (data preserved).");
  }
}

db.exec(schema);

// Safe to re-run: adds columns that older databases (created before this
// script was updated) won't have yet. SQLite has no "ADD COLUMN IF NOT
// EXISTS", so we just swallow the "duplicate column" error.
function tryAlter(sql) {
  try {
    db.exec(sql);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

// ============================================================
// v10 — Learning Offering architecture fix: `classes.name` used to be
// declared column-level UNIQUE (a leftover from before Foundation/Framework/
// Skyline had any programme/offering-type context at all). That constraint
// is enforced by SQLite regardless of `programme_id`, so it silently made it
// impossible for two different Learning Offering Types/Programmes to ever
// both have a Learning Group with the same name — e.g. a second programme's
// "Weekday" batch, or any other offering type reusing "Foundation" — the
// INSERT would fail with a UNIQUE constraint error even though the rows
// belong to completely independent programmes. That's the opposite of what
// "Programmes or modules with identical names under different Learning
// Offering Types must remain completely independent" requires.
//
// Fixed by rebuilding the table with the constraint scoped to
// (programme_id, name) instead of just (name) — same real duplicate-name
// protection *within* a programme (already checked in routes/classes.js),
// but no cross-programme interference. This uses the safe "swap in a new
// table" pattern (build classes_v10 -> copy rows -> DROP the old classes ->
// rename classes_v10 to classes) rather than SQLite's ALTER TABLE RENAME,
// specifically so no other table's stored foreign key text (users.class_id,
// notes.class_id, course_topics.class_id, examinations.class_id,
// instructor_classes.class_id, payments.class_id, ...) ever gets rewritten
// to point at a temporary name — every one of those keeps referencing
// "classes" throughout, since that name is only briefly absent, never
// renamed away. foreign_keys is toggled off only for the swap itself (SQLite
// forbids toggling it inside a transaction), and PRAGMA foreign_key_check
// is run immediately after as a hard safety check.
{
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='classes'").get();
  if (existing && /UNIQUE/i.test(existing.sql) && !/UNIQUE\s*\(\s*programme_id\s*,\s*name\s*\)/i.test(existing.sql)) {
    const cols = db.prepare("PRAGMA table_info(classes)").all();
    const colDefs = cols
      .map((c) => {
        let def = `${c.name} ${c.type}`;
        if (c.pk) def += " PRIMARY KEY";
        else if (c.notnull) def += " NOT NULL";
        return def;
      })
      .join(", ");
    const colNames = cols.map((c) => c.name).join(", ");

    db.pragma("foreign_keys = OFF");
    try {
      const rebuild = db.transaction(() => {
        db.exec(`CREATE TABLE classes_v10 (${colDefs})`);
        db.exec(`INSERT INTO classes_v10 (${colNames}) SELECT ${colNames} FROM classes`);
        db.exec("DROP TABLE classes");
        db.exec("ALTER TABLE classes_v10 RENAME TO classes");
      });
      rebuild();
    } finally {
      db.pragma("foreign_keys = ON");
    }
    const brokenRefs = db.prepare("PRAGMA foreign_key_check").all();
    if (brokenRefs.length) {
      throw new Error(`classes table rebuild left dangling foreign keys: ${JSON.stringify(brokenRefs)}`);
    }
    console.log("✅ Migrated classes table: name is no longer globally unique (now scoped per-programme via idx_classes_programme_name).");
  }
}

tryAlter("ALTER TABLE users ADD COLUMN avatar_path TEXT");
tryAlter("ALTER TABLE notes ADD COLUMN file_path TEXT");
tryAlter("ALTER TABLE users ADD COLUMN class_id TEXT REFERENCES classes(id)");
tryAlter("ALTER TABLE users ADD COLUMN student_code TEXT");
tryAlter("ALTER TABLE users ADD COLUMN is_adult INTEGER NOT NULL DEFAULT 0");
tryAlter("ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'"); // note | assignment | video_lesson
tryAlter("ALTER TABLE notes ADD COLUMN video_url TEXT");
tryAlter("ALTER TABLE notes ADD COLUMN topic TEXT");
tryAlter("ALTER TABLE notes ADD COLUMN class_id TEXT REFERENCES classes(id)");
tryAlter("ALTER TABLE course_topics ADD COLUMN class_id TEXT REFERENCES classes(id)");
tryAlter("ALTER TABLE course_topics ADD COLUMN completed INTEGER NOT NULL DEFAULT 0");
tryAlter("ALTER TABLE course_topics ADD COLUMN completed_date TEXT");
tryAlter("ALTER TABLE payments ADD COLUMN payment_status_label TEXT"); // 'owing' | 'paid_full' | 'paid_part'
tryAlter("ALTER TABLE users ADD COLUMN own_robotics_kit INTEGER NOT NULL DEFAULT 0");
tryAlter("ALTER TABLE users ADD COLUMN education_level TEXT"); // adults only: 'Senior High' | 'Tertiary' | 'None'
tryAlter("ALTER TABLE users ADD COLUMN balance_owed_ghs REAL NOT NULL DEFAULT 0");
tryAlter("ALTER TABLE campuses ADD COLUMN is_partner INTEGER NOT NULL DEFAULT 0");
// ---- Public Website CMS: richer Campus profile (location/partner school
// name/image/contact) so the landing page's Campuses section can be fully
// admin-managed instead of showing just a name. -----------------------------
tryAlter("ALTER TABLE campuses ADD COLUMN location TEXT");
tryAlter("ALTER TABLE campuses ADD COLUMN partner_school_name TEXT");
tryAlter("ALTER TABLE campuses ADD COLUMN image_path TEXT");
tryAlter("ALTER TABLE campuses ADD COLUMN contact_phone TEXT");
tryAlter("ALTER TABLE campuses ADD COLUMN contact_email TEXT");
tryAlter("ALTER TABLE campuses ADD COLUMN contact_address TEXT");
// ---- Public Website CMS: News & Updates light upgrade (featured/category/
// author/video) — publish state stays the existing `published` flag. -------
tryAlter("ALTER TABLE blog_posts ADD COLUMN featured INTEGER NOT NULL DEFAULT 0");
tryAlter("ALTER TABLE blog_posts ADD COLUMN category TEXT");
tryAlter("ALTER TABLE blog_posts ADD COLUMN author TEXT");
tryAlter("ALTER TABLE blog_posts ADD COLUMN video_url TEXT");
tryAlter("ALTER TABLE examinations ADD COLUMN assigned_learner_ids TEXT");

// ---- widen examinations.term_type to accept 'retake' -----------------------
// SQLite can't ALTER a CHECK constraint, so on databases created before this
// change we rebuild the table (rename -> recreate from schema.sql -> copy
// rows -> drop old). Existing midterm/end_of_term rows and their attempts are
// preserved untouched; examination_attempts references examinations.id, which
// doesn't change.
{
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='examinations'").get();
  if (existing && !/retake/i.test(existing.sql)) {
    db.exec("ALTER TABLE examinations RENAME TO examinations_old_v3");
    db.exec(schema); // schema.sql defines the widened examinations table; other CREATE TABLE IF NOT EXISTS statements are no-ops
    db.exec(`
      INSERT INTO examinations (id, course_id, class_id, title, term_type, questions, created_by, created_at)
      SELECT id, course_id, class_id, title, term_type, questions, created_by, created_at FROM examinations_old_v3
    `);
    db.exec("DROP TABLE examinations_old_v3");
    console.log("✅ Migrated examinations table: term_type now accepts 'retake'.");
  }
}

// ---- repair a dangling FK left behind by the rename above ------------------
// SQLite's ALTER TABLE RENAME auto-rewrites *other* tables' stored FK text to
// match the new name, so `examination_attempts`/`retake_attempts` (which
// reference examinations.id) ended up permanently pointing at the
// already-dropped `examinations_old_v3` instead of `examinations`. Harmless
// until something deletes a row from a table involved in the schema-wide FK
// graph (e.g. `users`), at which point SQLite errors with "no such table:
// examinations_old_v3". Self-healing and safe to re-run — only touches a
// table if its stored schema still shows the stale reference.
["examination_attempts", "retake_attempts"].forEach((table) => {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!row || !/examinations_old_v3/i.test(row.sql)) return;
  const oldCols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_dangling_fk_v6`);
  db.exec(schema); // recreates `table` fresh from schema.sql, correctly referencing `examinations`
  tryAlter(`ALTER TABLE ${table} ADD COLUMN term_id TEXT REFERENCES academic_terms(id)`); // restores the v5 column if this table had it
  const newCols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const shared = oldCols.filter((c) => newCols.includes(c));
  db.exec(`INSERT INTO ${table} (${shared.join(", ")}) SELECT ${shared.join(", ")} FROM ${table}_dangling_fk_v6`);
  db.exec(`DROP TABLE ${table}_dangling_fk_v6`);
  console.log(`✅ Repaired a dangling foreign key on ${table} left by an earlier migration.`);
});

// ---- Admin portal enhancements (payments/ledger, adult learners) ----------
// Which calendar month (e.g. '2026-07') a monthly payment covers. Optional —
// only meaningful for type = 'monthly'; termly/registration leave it null.
tryAlter("ALTER TABLE payments ADD COLUMN payment_month TEXT");

// Numeric mark alongside the existing letter grade — additive, nullable.
tryAlter("ALTER TABLE projects ADD COLUMN mark REAL");
// 'gemini' | 'fallback' — existing rows default to 'fallback' so they get
// regenerated via Gemini the next time their lesson is opened.
tryAlter("ALTER TABLE ai_quiz_cache ADD COLUMN source TEXT NOT NULL DEFAULT 'fallback'");
// JSON array of learner IDs covered by one combined multi-ward registration charge.
tryAlter("ALTER TABLE payments ADD COLUMN learner_ids TEXT");
// video_lesson AI processing: pending | processing | completed | failed.
// Existing video lessons default to 'pending' so they get processed once,
// via instructor/admin retry, without ever calling AI from a learner route.
tryAlter("ALTER TABLE notes ADD COLUMN ai_status TEXT NOT NULL DEFAULT 'pending'");
tryAlter("ALTER TABLE notes ADD COLUMN ai_transcript TEXT");
tryAlter("ALTER TABLE notes ADD COLUMN ai_error TEXT");
tryAlter("ALTER TABLE notes ADD COLUMN ai_error_detail TEXT");
tryAlter("ALTER TABLE notes ADD COLUMN transcript_version INTEGER NOT NULL DEFAULT 0");
tryAlter("ALTER TABLE notes ADD COLUMN summary_version INTEGER NOT NULL DEFAULT 0");
// AI Provider Management: multi-provider metadata, additive.
tryAlter("ALTER TABLE ai_quiz_cache ADD COLUMN provider TEXT");
tryAlter("ALTER TABLE ai_quiz_cache ADD COLUMN model TEXT");
tryAlter("ALTER TABLE ai_quiz_cache ADD COLUMN transcript_version INTEGER");
tryAlter("ALTER TABLE ai_quiz_cache ADD COLUMN summary_version INTEGER");

// ---- classes (Foundation / Framework / Skyline) ----------------------------
const classCount = db.prepare("SELECT COUNT(*) as n FROM classes").get().n;
if (classCount === 0) {
  const insertClass = db.prepare("INSERT INTO classes (id, name, sort_order) VALUES (?, ?, ?)");
  insertClass.run(uuid(), "Foundation", 1);
  insertClass.run(uuid(), "Framework", 2);
  insertClass.run(uuid(), "Skyline", 3);
  console.log("✅ Seeded classes: Foundation, Framework, Skyline.");
}

// ---- backfill: every existing minor learner defaults to Foundation --------
// Scoped to the Kids STEM offering type's own programme wherever that
// context already exists (i.e. any migrate() run after the Unified Learning
// Architecture tables further below have been created at least once), so
// this never risks matching some *other* programme's same-named class now
// that duplicate Learning Group names across programmes are allowed (see
// the v10 classes-table fix above). On a brand-new database's very first
// migrate() run — before those tables exist at all — there is only ever the
// one just-seeded "Foundation" row anyway, so the plain fallback below is
// equally correct at that point.
let foundation;
const offeringTypesTableExists = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_offering_types'")
  .get();
if (offeringTypesTableExists) {
  foundation = db
    .prepare(
      `SELECT c.id FROM classes c
       JOIN programmes p ON p.id = c.programme_id
       JOIN learning_offering_types t ON t.id = p.offering_type_id
       WHERE t.slug = 'kids_stem'
       ORDER BY c.sort_order ASC LIMIT 1`
    )
    .get();
}
if (!foundation) {
  foundation = db.prepare("SELECT id FROM classes ORDER BY sort_order ASC LIMIT 1").get();
}
if (foundation) {
  db.prepare(
    "UPDATE users SET class_id = ? WHERE role = 'learner' AND is_adult = 0 AND class_id IS NULL"
  ).run(foundation.id);
}

// ---- backfill: unique student codes for every learner without one ---------
const { nextStudentCode } = require("../utils/studentCode");
const missingCodeLearners = db.prepare("SELECT id FROM users WHERE role = 'learner' AND (student_code IS NULL OR student_code = '') ORDER BY created_at ASC").all();
missingCodeLearners.forEach((u) => {
  db.prepare("UPDATE users SET student_code = ? WHERE id = ?").run(nextStudentCode(), u.id);
});

// ---- default reference data (only inserted the first time) ----------------
const campusCount = db.prepare("SELECT COUNT(*) as n FROM campuses").get().n;
if (campusCount === 0) {
  const insertCampus = db.prepare("INSERT INTO campuses (id, name, active) VALUES (?, ?, 1)");
  insertCampus.run(uuid(), "Woodbridge International School");
  insertCampus.run(uuid(), "Morning Glory International School");
}

const courseCount = db.prepare("SELECT COUNT(*) as n FROM courses").get().n;
if (courseCount === 0) {
  const insertCourse = db.prepare(
    "INSERT INTO courses (id, title, blurb, ages, weeks, sequence, is_open) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  // Required order: Hardware & Software -> Programming & Scratching -> IoT & Robotics -> Graphic Design.
  // AI Essentials and Web Development are electives (no fixed sequence).
  insertCourse.run("HW-05", "Basic Hardware & Software", "How computers actually work — assembly, troubleshooting and OS fundamentals.", "10+", 6, 1, 1);
  insertCourse.run("PRG-01", "Programming & Scratching", "The foundation of digital logic — block-based coding and introductory text programming.", "6+", 8, 2, 1);
  insertCourse.run("IOT-02", "IoT & Robotics", "Writing code that interacts with the physical world using Arduino, sensors and motors.", "8+", 12, 3, 0);
  insertCourse.run("GFX-06", "Graphic Design", "Telling stories visually — layout, branding and digital illustration.", "9+", 8, 4, 0);
  insertCourse.run("AI-03", "AI Essentials", "Demystifying AI and machine learning — how it thinks, and how to use it ethically.", "9+", 4, null, 0);
  insertCourse.run("WEB-04", "Web Development", "Building real websites from scratch with HTML, CSS and JavaScript.", "10+", 10, null, 0);
}

const paymentAccountCount = db.prepare("SELECT COUNT(*) as n FROM payment_accounts").get().n;
if (paymentAccountCount === 0) {
  const insertAcct = db.prepare("INSERT INTO payment_accounts (id, network, account_number, account_name, active) VALUES (?, ?, ?, ?, 1)");
  insertAcct.run(uuid(), "MTN", "024 000 0000", "Dalijay Tech Hub");
  insertAcct.run(uuid(), "Vodafone", "050 000 0000", "Dalijay Tech Hub");
  insertAcct.run(uuid(), "AirtelTigo", "027 000 0000", "Dalijay Tech Hub");
  console.log("ℹ️  Seeded placeholder payment account numbers — update these from Admin → Settings before going live.");
}

const storyCount = db.prepare("SELECT COUNT(*) as n FROM success_stories").get().n;
if (storyCount === 0) {
  const insertStory = db.prepare(
    "INSERT INTO success_stories (id, name, role, quote, avatar_path, highlighted, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  insertStory.run(uuid(), "Enyimnyam Bamfo-Kwakye", "Aspiring AI Engineer", "This platform completely changed my life in tech. The hands-on projects gave me an insightful experience.", null, 0, 1);
  insertStory.run(uuid(), "Nhyiraba Sackitey", "Aspiring Game Developer", "As a beginner, I was nervous and doubtful of my capabilities. Thanks to this platform, I've gained real mastery and confidence.", null, 1, 2);
  insertStory.run(uuid(), "Elikem Dalike", "Aspiring Software Engineer", "The community support is unmatched. Whenever I got stuck, mentors and fellow learners were there to help.", null, 0, 3);
}

function seedSetting(key, value) {
  const existing = db.prepare("SELECT key FROM site_settings WHERE key = ?").get(key);
  if (!existing) db.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
}
seedSetting("hero", {
  eyebrow: "// From Consumers to Creators",
  title: "Become a Builder today.",
  lead: "39% of today's workplace skills will be transformed or made obsolete by AI, automation and robotics before your child enters the workforce (World Economic Forum, Future of Jobs Report). The Builders' Lab trains ages 6 and up — hands-on, right inside your school's own ICT lab.",
});
seedSetting("fees", { registrationGHS: Number(process.env.REGISTRATION_FEE_GHS) || 350, monthlyGHS: Number(process.env.MONTHLY_FEE_GHS) || 180 });
seedSetting("branding", { logoPath: "/images/DTH.jpg", signaturePath: null, adminSignatureName: "Lawson Dalikey-Dotsey, Founder" });
seedSetting("contact", {
  facebook: "Dalijay Tech Hub",
  tiktok: "DalijayTech_Hub",
  whatsapp: "(+233) 560 640 517",
  phone: "(+233) 542 947 685",
  email: "info@dalijaytechhub.online",
  website: "www.dalijaytechhub.online",
});
// Configurable per-assessment-type weights. Not used by any current grading
// or transcript calculation yet — stored purely so a future transcript
// enhancement can read them. New assessment types can be added to this
// object later without any schema change (it's just JSON in site_settings).
seedSetting("assessmentWeights", {
  aiQuiz: 10,
  continuousAssessment: 20,
  assignment: 10,
  project: 15,
  midtermExamination: 15,
  endOfTermExamination: 25,
  retakeExamination: 25,
});

// ============================================================
// v5 additions — Academic Session, Term & Calendar Engine.
// Every academic-record table gets a nullable term_id (nullable so the
// ALTER itself can never fail on non-empty tables; existing rows are then
// explicitly backfilled below to the seeded "current" term rather than left
// null, since retake/promotion/transcript logic all key off term_id).
// ============================================================
tryAlter("ALTER TABLE grades ADD COLUMN term_id TEXT REFERENCES academic_terms(id)");
tryAlter("ALTER TABLE projects ADD COLUMN term_id TEXT REFERENCES academic_terms(id)");
tryAlter("ALTER TABLE payments ADD COLUMN term_id TEXT REFERENCES academic_terms(id)");
tryAlter("ALTER TABLE attendance ADD COLUMN term_id TEXT REFERENCES academic_terms(id)");
tryAlter("ALTER TABLE examinations ADD COLUMN term_id TEXT REFERENCES academic_terms(id)");
tryAlter("ALTER TABLE examination_attempts ADD COLUMN term_id TEXT REFERENCES academic_terms(id)");
tryAlter("ALTER TABLE continuous_assessments ADD COLUMN term_id TEXT REFERENCES academic_terms(id)");
tryAlter("ALTER TABLE ca_attempts ADD COLUMN term_id TEXT REFERENCES academic_terms(id)");
tryAlter("ALTER TABLE assignment_submissions ADD COLUMN term_id TEXT REFERENCES academic_terms(id)");
tryAlter("ALTER TABLE course_topics ADD COLUMN term_id TEXT REFERENCES academic_terms(id)");
tryAlter("ALTER TABLE notes ADD COLUMN term_id TEXT REFERENCES academic_terms(id)");
tryAlter("ALTER TABLE progress ADD COLUMN term_id TEXT REFERENCES academic_terms(id)");
// Numeric assignment mark alongside the existing letter grade — same
// additive pattern already used for projects.mark, so Assignments can be
// combined numerically into the "Tests" transcript bucket.
tryAlter("ALTER TABLE assignment_submissions ADD COLUMN mark REAL");
// Learner's current academic year, for promotion/graduation tracking —
// separate from term_id above, which marks which term a *record* belongs to.
tryAlter("ALTER TABLE users ADD COLUMN current_academic_year_id TEXT REFERENCES academic_years(id)");

// ---- seed the first Academic Year + Term, if none exist yet ---------------
// This runs once, on the very first migrate after upgrading to v5. Every
// pre-existing academic record (created before terms existed) is backfilled
// to this seeded term so historical data stays queryable and nothing that
// already filters/joins on term_id silently drops rows.
{
  const yearCount = db.prepare("SELECT COUNT(*) as n FROM academic_years").get().n;
  const backfillTables = [
    "grades",
    "projects",
    "payments",
    "attendance",
    "examinations",
    "examination_attempts",
    "continuous_assessments",
    "ca_attempts",
    "assignment_submissions",
    "course_topics",
    "notes",
    "progress",
  ];
  if (yearCount === 0) {
    const yearId = uuid();
    const termId = uuid();
    const now = new Date();
    // Ghana school years typically run Sept–Aug; label by calendar year the
    // year *starts* in, which is a safe default an admin can rename later.
    const yearName = `${now.getFullYear()}/${now.getFullYear() + 1}`;
    db.prepare("INSERT INTO academic_years (id, name, is_active) VALUES (?, ?, 1)").run(yearId, yearName);
    db.prepare(
      "INSERT INTO academic_terms (id, academic_year_id, name, sort_order, is_active) VALUES (?, ?, 'Term 1', 1, 1)"
    ).run(termId, yearId);
    console.log(`✅ Seeded initial Academic Year "${yearName}" and active "Term 1".`);

    // Backfill every existing academic-record row into this term so nothing
    // predating the Academic Term Engine is orphaned.
    backfillTables.forEach((table) => {
      db.prepare(`UPDATE ${table} SET term_id = ? WHERE term_id IS NULL`).run(termId);
    });
    db.prepare("UPDATE users SET current_academic_year_id = ? WHERE role = 'learner' AND current_academic_year_id IS NULL").run(yearId);
  } else {
    // Later migrate() runs (after the first): backfill any rows created by
    // other code paths that haven't been updated yet to stamp term_id
    // themselves. Uses whichever term is currently active, so this is a
    // no-op once every route sets term_id on insert.
    const activeTerm = db.prepare("SELECT id FROM academic_terms WHERE is_active = 1").get();
    if (activeTerm) {
      backfillTables.forEach((table) => {
        db.prepare(`UPDATE ${table} SET term_id = ? WHERE term_id IS NULL`).run(activeTerm.id);
      });
      const activeYear = db.prepare("SELECT academic_year_id FROM academic_terms WHERE id = ?").get(activeTerm.id);
      if (activeYear) {
        db.prepare(
          "UPDATE users SET current_academic_year_id = ? WHERE role = 'learner' AND current_academic_year_id IS NULL"
        ).run(activeYear.academic_year_id);
      }
    }
  }
}

// ---- transcript assessment weights (Tests 10% / Midterm 20% / End of Term
// 70%) — configurable by admins without a code change, per the new grading
// scheme. Kept as its own setting key, separate from the existing
// `assessmentWeights` (which governs how AI Quiz/CA/Assignment/Project
// combine *inside* the "Tests" bucket, and is left untouched below).
seedSetting("transcriptWeights", { tests: 10, midterm: 20, endOfTerm: 70 });

// ---- grading scheme (score band -> grade -> interpretation) — configurable
// by admins without a code change. 'E' and 'F' both interpret as Retake,
// matching the Retake Workflow's eligibility rule.
seedSetting("gradingScheme", [
  { min: 95, max: 100, grade: "A+", interpretation: "Mastery" },
  { min: 90, max: 94.99, grade: "A", interpretation: "Approaching Mastery" },
  { min: 85, max: 89.99, grade: "B+", interpretation: "Advanced" },
  { min: 80, max: 84.99, grade: "B", interpretation: "Proficient" },
  { min: 60, max: 79.99, grade: "C", interpretation: "Approaching Proficiency" },
  { min: 50, max: 59.99, grade: "D", interpretation: "Developing" },
  { min: 40, max: 49.99, grade: "E", interpretation: "Retake" },
  { min: 0, max: 39.99, grade: "F", interpretation: "Retake" },
]);

console.log("✅ Database migrated at", process.env.DB_PATH || "server/data/builderslab.db");

// ============================================================
// v6 additions — Certificate Engine (replaces the old ad-hoc
// buildCertificate() in routes/certificates.js). Three tables, deliberately
// separated per the spec: templates (layout/fields/placeholders/validation),
// campus branding (per-campus visual identity), and issued certificates
// (immutable — editing a template or branding profile must never change a
// certificate that's already been issued, so issued rows store a full
// snapshot rather than references).
// ============================================================
db.exec(`
CREATE TABLE IF NOT EXISTS certificate_templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,   -- module_completion | graduation | honor | recognition
  is_active     INTEGER NOT NULL DEFAULT 1,
  title         TEXT NOT NULL DEFAULT 'Certificate of Completion',
  body          TEXT NOT NULL DEFAULT '',
  footer        TEXT,
  date_format   TEXT NOT NULL DEFAULT 'DD MMMM YYYY',
  number_format TEXT NOT NULL DEFAULT 'CERT-{campus}-{year}-{seq}',
  fields        TEXT NOT NULL DEFAULT '[]',  -- JSON array: which of the template's fields are shown
  placeholders  TEXT NOT NULL DEFAULT '[]',  -- JSON array: which {{placeholders}} this template exposes
  show_academic_stats INTEGER NOT NULL DEFAULT 0, -- award certs default OFF: no modules/grades/transcript stats unless explicitly configured
  skills_config TEXT,             -- JSON: how Skills Acquired are configured for this template
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campus_branding_profiles (
  id                    TEXT PRIMARY KEY,
  campus_name           TEXT NOT NULL UNIQUE REFERENCES campuses(name),
  partner_school_name   TEXT,
  institution_name       TEXT NOT NULL DEFAULT 'Dalijay Tech Hub',
  institution_logo_path  TEXT,
  partner_logo_path      TEXT,
  signature_path         TEXT,
  authorized_signatory    TEXT,
  footer                  TEXT,
  theme_colours           TEXT,   -- JSON {primary, secondary, accent}
  background_image_path   TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Immutable once inserted: application code must never UPDATE a row here
-- (only certificates.js's revoke endpoint may flip is_revoked, which is a
-- status flag, not an edit to the certificate's content). template_snapshot
-- and branding_snapshot are full JSON copies taken at issue time, so later
-- edits to the template/branding profile never alter an issued certificate.
CREATE TABLE IF NOT EXISTS issued_certificates (
  id                  TEXT PRIMARY KEY,
  certificate_number  TEXT NOT NULL UNIQUE,
  template_id         TEXT NOT NULL REFERENCES certificate_templates(id),
  learner_id          TEXT NOT NULL REFERENCES users(id),
  campus_name         TEXT NOT NULL,
  academic_year_id    TEXT REFERENCES academic_years(id),
  term_id             TEXT REFERENCES academic_terms(id),
  course_id           TEXT,       -- set for Course Completion certificates
  data                TEXT NOT NULL,   -- JSON: every resolved placeholder value at issue time
  template_snapshot   TEXT NOT NULL,   -- JSON copy of the template as it existed at issue time
  branding_snapshot   TEXT NOT NULL,   -- JSON copy of the campus branding profile at issue time
  is_revoked          INTEGER NOT NULL DEFAULT 0,
  issued_by           TEXT NOT NULL REFERENCES users(id),
  issued_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issued_certs_learner ON issued_certificates(learner_id);
CREATE INDEX IF NOT EXISTS idx_issued_certs_template ON issued_certificates(template_id);
`);

// Seed the four spec'd templates on first run only (idempotent — checks
// existence by name so re-running migrate never duplicates them).
const templateDefaults = [
  {
    name: "Module Completion Certificate",
    type: "module_completion",
    title: "Certificate of Module Completion",
    body: "This certifies that {{student_name}} has successfully completed {{module_name}} with a grade of {{grade}}.",
    placeholders: ["student_name", "module_name", "completion_date", "certificate_number", "grade", "campus", "partner_school", "issue_date"],
    showStats: 1,
  },
  {
    name: "Graduation Certificate",
    type: "graduation",
    title: "Certificate of Graduation",
    body: "This certifies that {{student_name}} has graduated from {{course_name}} at {{campus}}.",
    placeholders: ["student_name", "course_name", "completion_date", "certificate_number", "highest_score", "highest_grade", "highest_interpretation", "campus", "partner_school", "issue_date"],
    showStats: 1,
  },
  {
    name: "Certificate of Honor",
    type: "honor",
    title: "Certificate of Honor",
    body: "Awarded to {{student_name}} in recognition of outstanding achievement.",
    placeholders: ["student_name", "certificate_number", "campus", "partner_school", "issue_date"],
    showStats: 0,
  },
  {
    name: "Certificate of Recognition",
    type: "recognition",
    title: "Certificate of Recognition",
    body: "Awarded to {{student_name}} in recognition of their contribution.",
    placeholders: ["student_name", "certificate_number", "campus", "partner_school", "issue_date"],
    showStats: 0,
  },
];
templateDefaults.forEach((t) => {
  const exists = db.prepare("SELECT id FROM certificate_templates WHERE name = ?").get(t.name);
  if (!exists) {
    db.prepare(
      `INSERT INTO certificate_templates (id, name, type, title, body, placeholders, show_academic_stats)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(uuid(), t.name, t.type, t.title, t.body, JSON.stringify(t.placeholders), t.showStats);
  }
});

// Seed one branding profile per existing campus, defaulting to whatever the
// legacy single-branding `site_settings.branding` setting already had, so
// certificates issued right after upgrading look the same as before —
// nothing visually breaks on day one.
{
  const legacyBranding = (() => {
    const row = db.prepare("SELECT value FROM site_settings WHERE key = 'branding'").get();
    try { return row ? JSON.parse(row.value) : {}; } catch (e) { return {}; }
  })();
  const campusRows = db.prepare("SELECT name FROM campuses").all();
  campusRows.forEach((c) => {
    const exists = db.prepare("SELECT id FROM campus_branding_profiles WHERE campus_name = ?").get(c.name);
    if (!exists) {
      db.prepare(
        `INSERT INTO campus_branding_profiles (id, campus_name, institution_logo_path, signature_path, authorized_signatory)
         VALUES (?, ?, ?, ?, ?)`
      ).run(uuid(), c.name, legacyBranding.logoPath || null, legacyBranding.signaturePath || null, legacyBranding.adminSignatureName || null);
    }
  });
}

console.log("✅ Certificate Engine tables ready (templates, branding profiles, issued certificates).");

// ============================================================
// v7 additions — Unified Learning Architecture. Introduces the Learning
// Offering layer above the existing class/module data so the LMS can host
// Kids STEM (unchanged), Adult Professional Programmes, Corporate Training
// and Bootcamps without code changes for future offering types.
//
// Nothing existing is redefined: `classes` and `modules` gain nullable
// columns (existing rows keep working exactly as before), and three new
// tables hang off them. Foundation/Framework/Skyline are backfilled onto a
// seeded "Builders Lab" programme below so every current Kids STEM record
// keeps resolving through the same relationships going forward.
// ============================================================

// `classes` is the one internal Learning Group entity for every offering
// (per spec) — programme_id scopes it to a programme, display_label lets a
// specific group override the offering type's default label (e.g. a
// corporate group can be called "3-Day Workshop Cohort" instead of the
// generic "Training Group").
tryAlter("ALTER TABLE classes ADD COLUMN programme_id TEXT REFERENCES programmes(id)");
tryAlter("ALTER TABLE classes ADD COLUMN display_label TEXT");

// NULL programme_id = legacy/global Builders Lab module, exactly as today —
// this is what preserves all existing Kids STEM module behavior untouched.
tryAlter("ALTER TABLE courses ADD COLUMN programme_id TEXT REFERENCES programmes(id)");

db.exec(`
-- Admin-manageable catalogue of offering types. Seeded with the four spec'd
-- types below; admins can add more later purely through data (no code
-- change), which is what "future Learning Offering Types" requires.
CREATE TABLE IF NOT EXISTS learning_offering_types (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,   -- e.g. 'Kids STEM Programme'
  slug                  TEXT NOT NULL UNIQUE,   -- e.g. 'kids_stem'
  description           TEXT,
  requires_parent       INTEGER NOT NULL DEFAULT 0,   -- kids offerings link parents to learners; adult/corporate do not
  learning_group_label  TEXT NOT NULL DEFAULT 'Class', -- default display name for this offering's Learning Groups (Class | Batch | Cohort | Training Group)
  is_active             INTEGER NOT NULL DEFAULT 1,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The organization level that only Corporate Training uses (MTN Ghana, etc).
-- default_report_output_mode is the client-wide default for what a training
-- programme produces; an individual programme may override it.
CREATE TABLE IF NOT EXISTS corporate_clients (
  id                          TEXT PRIMARY KEY,
  name                        TEXT NOT NULL UNIQUE,
  contact_name                TEXT,
  contact_email               TEXT,
  contact_phone               TEXT,
  logo_path                   TEXT,
  default_report_output_mode  TEXT NOT NULL DEFAULT 'certificate_only', -- certificate_only | attendance_only | transcript_and_certificate
  is_active                   INTEGER NOT NULL DEFAULT 1,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The actual course/offering a learner registers for. For Kids STEM this is
-- the single "Builders Lab" row (seeded below) that Foundation/Framework/
-- Skyline already point to. For Adults, one row per course (Robotics, Python
-- Programming, ...). For Corporate Training, one row per client engagement
-- (e.g. "Cybersecurity Awareness" under MTN Ghana), with duration_label
-- holding the configurable workshop length (One-Day Workshop, 3-Day
-- Workshop, Intensive Training, etc — free text, admin-defined).
CREATE TABLE IF NOT EXISTS programmes (
  id                        TEXT PRIMARY KEY,
  offering_type_id          TEXT NOT NULL REFERENCES learning_offering_types(id),
  corporate_client_id       TEXT REFERENCES corporate_clients(id),  -- set only for Corporate Training programmes
  name                      TEXT NOT NULL,
  duration_label            TEXT,      -- e.g. '3-Day Workshop', 'Evening Batch length', configurable per spec
  learning_group_label      TEXT,      -- overrides the offering type's default label for this programme's groups, if set
  report_output_mode        TEXT,      -- NULL = inherit from corporate_clients.default_report_output_mode; else certificate_only | attendance_only | transcript_and_certificate
  is_active                 INTEGER NOT NULL DEFAULT 1,
  sort_order                INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_programmes_offering_type ON programmes(offering_type_id);
CREATE INDEX IF NOT EXISTS idx_programmes_corporate_client ON programmes(corporate_client_id);
CREATE INDEX IF NOT EXISTS idx_classes_programme ON classes(programme_id);
-- Real, DB-enforced version of the "name unique within its own programme"
-- rule routes/classes.js already checks in application code — a backstop
-- against races/bugs, now that classes.name is no longer globally unique
-- (see the v10 migration above). NULL programme_id can't violate a UNIQUE
-- index in SQLite (NULLs are never considered equal to each other), which
-- only matters for the instant before the v7 backfill below runs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_programme_name ON classes(programme_id, name);
CREATE INDEX IF NOT EXISTS idx_courses_programme ON courses(programme_id);

-- A single concrete "run" of a Programme or a Module — e.g. "Robotics & IoT
-- — Jan 2026 Cohort", or one specific run of the "Advanced Python" module —
-- as distinct from the reusable Programme/Module definition itself, and
-- from a Class/Learning Group (a cohort *within* a run, e.g. Weekday vs
-- Weekend). This table is purely additive: nothing elsewhere in the app
-- creates, reads, or joins against it yet, and no existing table gained a
-- new column pointing at it — it's ready for whichever feature (scheduling,
-- registration windows, run-scoped reporting, etc.) needs it next.
--
-- Per the Learning Offering architecture, offering_type_id is always the
-- primary lookup context and is stored directly here rather than only
-- being derivable through programme_id/module_id — the same denormalized-
-- for-fast-scoping pattern programmes/classes/modules already use.
--
-- ARCHITECTURE NOTE (ABRS v2.1 §7): this table is the literal database
-- implementation of the "Programme Run" business entity. "Programme Run"
-- is the preferred business term used throughout the constitutional
-- specification and should be preferred in all new code comments, admin
-- UI copy, and API documentation; "Learning Instance" / learning_instances
-- remains the implementation/table name for now (see ABRS v2.1 Roadmap
-- Phase 1) and both names refer to exactly one entity — there is no
-- conceptual difference between them. Do not introduce a second,
-- differently-named table or concept for "Programme Run" — this table IS
-- it. See server/docs/GLOSSARY.md for the full business-term ↔
-- implementation-term cross-reference.
CREATE TABLE IF NOT EXISTS learning_instances (
  id                TEXT PRIMARY KEY,
  offering_type_id  TEXT NOT NULL REFERENCES learning_offering_types(id),
  programme_id      TEXT REFERENCES programmes(id),
  course_id         TEXT REFERENCES courses(id),
  name              TEXT,   -- e.g. "Jan 2026 Cohort" — optional; a run doesn't always need its own display name
  start_date        TEXT,   -- ISO 'YYYY-MM-DD'
  end_date          TEXT,   -- ISO 'YYYY-MM-DD'
  status            TEXT NOT NULL DEFAULT 'upcoming'
                       CHECK (status IN ('upcoming', 'active', 'completed', 'archived', 'cancelled')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  -- Exactly one of programme_id/course_id: a Learning Instance is one run of
  -- *either* a Programme or a Course — never neither, and never both at
  -- once (a run of the whole programme and a run of just one of its
  -- courses are two different rows, not one row with both set).
  CHECK (
    (programme_id IS NOT NULL AND course_id IS NULL)
    OR (programme_id IS NULL AND course_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_learning_instances_offering_type ON learning_instances(offering_type_id);
CREATE INDEX IF NOT EXISTS idx_learning_instances_programme ON learning_instances(programme_id);
CREATE INDEX IF NOT EXISTS idx_learning_instances_course ON learning_instances(course_id);
CREATE INDEX IF NOT EXISTS idx_learning_instances_status ON learning_instances(status);
-- ABRS v2.2 amendment (concurrent Programme Runs): this schema used to
-- enforce "only one Active Learning Instance per Programme/Course"
-- system-wide via a partial UNIQUE index here. That's no longer correct —
-- a Programme legitimately needs multiple concurrent Active Runs (e.g. a
-- Sept 2026 School A run and a later-subscribing School B run, each with
-- its own Academic Calendar/Periods, each independently completing on its
-- own timeline) — see idx_lit_one_active_per_programme/_course below
-- (the actual current, per-Run-target enforcement point) for what
-- replaced this. The old indexes are dropped explicitly below for
-- databases that already have them (see the "drop legacy one-active-run
-- backstop" block near the end of this file); intentionally not
-- recreated here.
`);

// Seed the four spec'd offering types on first run only (idempotent by slug).
const offeringTypeDefaults = [
  { name: "Kids STEM Programme", slug: "kids_stem", requiresParent: 1, groupLabel: "Class", sortOrder: 0,
    description: "Foundation/Framework/Skyline and children's bootcamps." },
  { name: "Adult Professional Programme", slug: "adult_professional", requiresParent: 0, groupLabel: "Batch", sortOrder: 1,
    description: "Courses adults register for directly, e.g. Robotics, Python Programming, Web Development, AI & Machine Learning." },
  { name: "Corporate Training", slug: "corporate_training", requiresParent: 0, groupLabel: "Training Group", sortOrder: 2,
    description: "Organization-sponsored training delivered to a corporate client's participants." },
  { name: "Bootcamp", slug: "bootcamp", requiresParent: 0, groupLabel: "Cohort", sortOrder: 3,
    description: "Short-form intensive offerings (holiday, weekend, one-day, multi-day) for any audience." },
];
const offeringTypeIdBySlug = {};
offeringTypeDefaults.forEach((t) => {
  const existing = db.prepare("SELECT id FROM learning_offering_types WHERE slug = ?").get(t.slug);
  if (existing) {
    offeringTypeIdBySlug[t.slug] = existing.id;
  } else {
    const id = uuid();
    db.prepare(
      `INSERT INTO learning_offering_types (id, name, slug, description, requires_parent, learning_group_label, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, t.name, t.slug, t.description, t.requiresParent, t.groupLabel, t.sortOrder);
    offeringTypeIdBySlug[t.slug] = id;
  }
});

// Seed the "Builders Lab" programme under Kids STEM and backfill it onto
// Foundation/Framework/Skyline (and any other existing class rows that have
// no programme_id yet) so every existing Kids STEM record keeps resolving
// through the new Learning Offering relationships without any data change.
{
  const kidsTypeId = offeringTypeIdBySlug["kids_stem"];
  let buildersLab = db.prepare("SELECT id FROM programmes WHERE name = ? AND offering_type_id = ?").get("Builders Lab", kidsTypeId);
  let buildersLabId;
  if (buildersLab) {
    buildersLabId = buildersLab.id;
  } else {
    buildersLabId = uuid();
    db.prepare(
      `INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Builders Lab', 0)`
    ).run(buildersLabId, kidsTypeId);
  }
  db.prepare("UPDATE classes SET programme_id = ? WHERE programme_id IS NULL").run(buildersLabId);
  db.prepare("UPDATE courses SET programme_id = ? WHERE programme_id IS NULL").run(buildersLabId);
}

console.log("✅ Unified Learning Architecture tables ready (offering types, corporate clients, programmes).");

// ============================================================
// v8 additions — scope payments to Academic Year/Term/Learning Offering/
// Learning Group per spec, and extend the Certificate Engine with the two
// remaining spec'd template types (Corporate Training, Bootcamp). All
// additive/nullable — existing payment and certificate rows are untouched.
// ============================================================
tryAlter("ALTER TABLE payments ADD COLUMN academic_year_id TEXT REFERENCES academic_years(id)");
tryAlter("ALTER TABLE payments ADD COLUMN term_id TEXT REFERENCES academic_terms(id)");
tryAlter("ALTER TABLE payments ADD COLUMN programme_id TEXT REFERENCES programmes(id)");
tryAlter("ALTER TABLE payments ADD COLUMN class_id TEXT REFERENCES classes(id)"); // Learning Group the payment belongs to

const corporateBootcampTemplateDefaults = [
  {
    name: "Corporate Training Certificate",
    type: "corporate_training",
    title: "Certificate of Training",
    body: "This certifies that {{student_name}} has successfully completed {{programme_name}} delivered on behalf of {{corporate_client_name}}.",
    placeholders: ["student_name", "programme_name", "corporate_client_name", "completion_date", "certificate_number", "campus", "partner_school", "issue_date"],
    showStats: 0, // corporate defaults to attendance/participation framing, not academic stats, unless the admin configures transcript_and_certificate
  },
  {
    name: "Bootcamp Certificate",
    type: "bootcamp",
    title: "Certificate of Completion",
    body: "This certifies that {{student_name}} has successfully completed {{programme_name}}.",
    placeholders: ["student_name", "programme_name", "completion_date", "certificate_number", "campus", "partner_school", "issue_date"],
    showStats: 0,
  },
];
corporateBootcampTemplateDefaults.forEach((t) => {
  const exists = db.prepare("SELECT id FROM certificate_templates WHERE name = ?").get(t.name);
  if (!exists) {
    db.prepare(
      `INSERT INTO certificate_templates (id, name, type, title, body, placeholders, show_academic_stats)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(uuid(), t.name, t.type, t.title, t.body, JSON.stringify(t.placeholders), t.showStats);
  }
});

console.log("✅ Payments scoped to Academic Year/Term/Programme/Learning Group; Corporate Training & Bootcamp certificate templates seeded.");

// ============================================================
// v9 — Learning Offering Type Settings. Admins can now fully configure a
// Learning Offering Type's behaviour (enrollment, academic structure,
// assessments, academic records, payments, certificates, AI, visibility)
// from Admin → Learning Offering Types, with zero source-code changes for
// future types. `settings` holds the full configurable behaviour as JSON
// (see server/src/utils/offeringTypeSettings.js for the schema/defaults);
// `icon`/`color` are simple display fields for the admin UI and public site.
// `requires_parent`/`sort_order`/`is_active` (added in the original table)
// are untouched and stay in sync with settings.enrollment.parentAccountRequired
// for any legacy code path still reading the plain column directly.
// ============================================================
tryAlter("ALTER TABLE learning_offering_types ADD COLUMN icon TEXT");
tryAlter("ALTER TABLE learning_offering_types ADD COLUMN color TEXT DEFAULT '#8B5E3C'");
tryAlter("ALTER TABLE learning_offering_types ADD COLUMN settings TEXT");

{
  const { serializeSettings } = require("../utils/offeringTypeSettings");
  // Per-type defaults mirroring the spec's worked examples (Kids STEM,
  // Adult Professional, Corporate Training, Bootcamp). Only applied to rows
  // that don't have settings yet, so re-running never clobbers admin edits.
  const behaviourBySlug = {
    kids_stem: {
      enrollment: { parentAccountRequired: "yes", selfRegistrationAllowed: false, instructorApprovalRequired: false, legacyAlwaysSelfRegistrable: true },
      academicStructure: { usesAcademicTerm: "yes", usesPromotion: true, legacyRequiresCourseSelectionAtRegistration: true },
      academicRecords: { generateTranscript: "yes" },
      payments: { registrationFee: true, termFees: true, installmentsAllowed: true },
      ai: { transcriptRequired: true },
    },
    adult_professional: {
      enrollment: { parentAccountRequired: "no", selfRegistrationAllowed: true, instructorApprovalRequired: false },
      academicStructure: { usesAcademicTerm: "optional", usesPromotion: false },
      academicRecords: { generateTranscript: "yes" },
      payments: { registrationFee: true, programmeFee: true, installmentsAllowed: true },
    },
    corporate_training: {
      enrollment: { parentAccountRequired: "no", selfRegistrationAllowed: false, instructorApprovalRequired: true },
      academicStructure: { usesAcademicTerm: "no", usesPromotion: false },
      academicRecords: { generateTranscript: "optional", generateAttendanceReport: true },
      payments: { registrationFee: false, workshopFee: true },
      visibility: { displayOnPublicWebsite: false, displayInParentPortal: false },
      // ABRS v2.1 Phase 4 audit fix (Category 2 — see
      // HARDCODED_IDENTIFIER_AUDIT.md): Corporate Training's Enrol button
      // routing to a contact/enquiry destination instead of self-service
      // registration used to be a `slug === "corporate_training"` check in
      // client/src/pages/public/publicUtils.js. enrolDestination is
      // already a fully generic, admin-editable field every offering type
      // has (see OfferingTypeLandingPanel.jsx) — this just seeds Corporate
      // Training's own sensible default value for it, same as any other
      // offering type's default is just an empty string. Once seeded, the
      // frontend no longer needs to know Corporate Training's identity at
      // all; it only reads this field.
      landing: { enrolDestination: "#contact" },
    },
    bootcamp: {
      enrollment: { parentAccountRequired: "optional", selfRegistrationAllowed: true, instructorApprovalRequired: false },
      // Bootcamp Course Library remediation: Bootcamp Programme Runs assign
      // their Courses through the run-scoped Activated Course mechanism
      // (learning_instance_courses), so Bootcamp opts into the v2 read path
      // here rather than via a hardcoded `slug === "bootcamp"` check
      // somewhere in routes. Every other Offering Type (including Builders'
      // Lab / Kids STEM) keeps the DEFAULT_SETTINGS `false` and its existing
      // behaviour untouched.
      academicStructure: { usesAcademicTerm: "optional", usesPromotion: false, activatedCoursesV2Enabled: true },
      academicRecords: { generateTranscript: "no", generateCertificates: true },
      payments: { registrationFee: false, bootcampFee: true },
    },
  };
  const icons = { kids_stem: "🧒", adult_professional: "🎓", corporate_training: "🏢", bootcamp: "🚀" };
  const colors = { kids_stem: "#E07A3E", adult_professional: "#2F6F5E", corporate_training: "#2E5A8B", bootcamp: "#8B3E5E" };
  const rows = db.prepare("SELECT id, slug, settings, icon FROM learning_offering_types").all();
  rows.forEach((row) => {
    if (!row.settings) {
      const overrides = behaviourBySlug[row.slug] || {};
      db.prepare("UPDATE learning_offering_types SET settings = ? WHERE id = ?").run(serializeSettings(overrides), row.id);
    }
    if (!row.icon) {
      db.prepare("UPDATE learning_offering_types SET icon = ?, color = ? WHERE id = ?").run(
        icons[row.slug] || "📘",
        colors[row.slug] || "#8B5E3C",
        row.id
      );
    }
  });
}

console.log("✅ Learning Offering Type Settings ready (enrollment, academic structure, assessments, records, payments, certificates, AI, visibility).");

// ============================================================
// v6 additions — RBAC Engine. Additive columns only (users.role's CHECK
// constraint is untouched — Campus Administrator uses the existing
// users.campus column for scoping and Corporate Coordinator is an
// admin-role account assigned the "Corporate Coordinator" Role Template,
// so no risky rebuild of the heavily-referenced users table is needed).
// ============================================================
tryAlter("ALTER TABLE users ADD COLUMN role_template_id TEXT REFERENCES role_templates(id)");
tryAlter("ALTER TABLE users ADD COLUMN custom_permissions TEXT"); // JSON array; NULL = use the template's permissions as-is
tryAlter("ALTER TABLE users ADD COLUMN corporate_client_id TEXT REFERENCES corporate_clients(id)");

{
  const { ensureDefaultRoleTemplatesAndSuperAdmin } = require("../utils/rbac");
  ensureDefaultRoleTemplatesAndSuperAdmin();
  console.log("✅ RBAC Engine ready (Role Templates, Access & Permissions, Super Administrator protection).");

  // Self-heal: any admin account with neither a role_template_id nor a
  // custom_permissions set has zero effective permissions (see
  // utils/rbac.js effectivePermissions/isSuperAdmin) — completely locked
  // out of its own Admin Portal, with no way to grant itself any
  // permission either, since Access & Permissions is itself gated. Every
  // admin created through POST /api/users/staff is required to pick one
  // of the two, so the only way to reach this state is the original
  // seed:admin bootstrap account predating that requirement (fixed
  // separately in seedAdmin.js, but that fix only helps brand-new
  // installs — this backfill repairs any database that already has one
  // or more admins stuck in the zero-permission state). Defaults every
  // such account to the built-in Super Administrator template, the same
  // role the bootstrap admin has always been intended to have.
  const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator' AND is_system = 1").get();
  if (superAdminTemplate) {
    const strandedAdmins = db
      .prepare("SELECT id, name, email FROM users WHERE role = 'admin' AND role_template_id IS NULL AND custom_permissions IS NULL")
      .all();
    if (strandedAdmins.length) {
      const fix = db.prepare("UPDATE users SET role_template_id = ? WHERE id = ?");
      strandedAdmins.forEach((a) => fix.run(superAdminTemplate.id, a.id));
      console.log(
        `✅ RBAC Engine: granted the Super Administrator template to ${strandedAdmins.length} admin account(s) that had no Role Template or Custom Permission Set and were therefore locked out of every Admin Portal action (${strandedAdmins.map((a) => a.email).join(", ")}).`
      );
    }
  }
}

// ============================================================
// v7 additions — Public Website CMS (Landing Page).
// Every landing-page section becomes admin-manageable: new list-content
// tables (How It Works steps, FAQs, Gallery, Partners), a Campus <->
// Learning Offering Type link table ("Available Learning Offerings" per
// campus), and new site_settings keys (about/home/footer/enrolButton) using
// the same generic key/value store already used for hero/fees/contact.
// All additive — nothing existing is renamed, dropped, or restructured.
// ============================================================
db.exec(`
CREATE TABLE IF NOT EXISTS campus_offering_types (
  campus_id        TEXT NOT NULL REFERENCES campuses(id),
  offering_type_id TEXT NOT NULL REFERENCES learning_offering_types(id),
  PRIMARY KEY (campus_id, offering_type_id)
);

CREATE TABLE IF NOT EXISTS how_it_works_steps (
  id          TEXT PRIMARY KEY,
  icon        TEXT,
  image_path  TEXT,
  title       TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS faqs (
  id         TEXT PRIMARY KEY,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS gallery_images (
  id         TEXT PRIMARY KEY,
  image_path TEXT NOT NULL,
  caption    TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS partners (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  logo_path  TEXT,
  url        TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);
`);

// Seed the six "How enrolment works" steps that were previously hardcoded in
// index.html, so the CMS starts pre-populated with the site's real current
// copy instead of going blank — the admin edits from here on.
if (db.prepare("SELECT COUNT(*) as n FROM how_it_works_steps").get().n === 0) {
  const insertStep = db.prepare(
    "INSERT INTO how_it_works_steps (id, icon, image_path, title, description, sort_order, active) VALUES (?, ?, NULL, ?, ?, ?, 1)"
  );
  [
    ["01", "Register & pay registration fee", "Create a learner + parent account and pay securely via Mobile Money."],
    ["02", "Learn on campus, revise online", "Lessons run inside your school's ICT lab; every video, slide and PDF is also on the portal."],
    ["03", "Watch, quiz, build", "Each lesson unlocks the next only after it's watched in full and its quiz is passed."],
    ["04", "Submit projects for grading", "Upload photos or clips of finished builds — instructors grade and give feedback."],
    ["05", "Pay monthly, stay enrolled", "After registration, a simple monthly Mobile Money charge keeps access active."],
    ["06", "Receive your transcript", "Midterm and end-of-term transcripts — with your star rating — are generated automatically."],
  ].forEach(([mark, title, description], i) => insertStep.run(uuid(), mark, title, description, i));
}

// Seed new site_settings keys used by the redesigned landing page. Existing
// keys (hero/fees/branding/contact) are untouched.
seedSetting("about", {
  eyebrow: "// Who we are",
  title: "About Dalijay Tech Hub",
  body: "Dalijay Tech Hub runs The Builders' Lab — hands-on STEM, Robotics, IoT, Web Development and Graphic Design training delivered inside partner school ICT labs across Ghana, for kids and adults alike.",
  imagePath: null,
});
seedSetting("home", {
  introEyebrow: "// Inside our sessions",
  introTitle: "What a real Builders' Lab session looks like",
  statStripLeft: "100% — Hands-on curriculum",
  statStripSecond: "Mobile Money — Pay in minutes",
  statStripThird: "Parent portal — Track progress live",
  statStripFourth: "School-hosted — No extra commute",
  ctaTitle: "Ready to build the future?",
  ctaBody: "Registration takes five minutes and payment is by Mobile Money — no bank visit required.",
  howItWorksEyebrow: "// How enrolment works",
  howItWorksTitle: "From sign-up to certificate",
  campusesEyebrow: "// Where we build",
  campusesTitle: "Our partner campuses",
  campusesBody: "The Builders' Lab runs directly inside our partner schools' ICT labs — talk to us about hosting a Builders' Lab at your school.",
  storiesEyebrow: "// Our success stories",
  storiesTitle: "Discover our impact journey",
  newsEyebrow: "// From the Hub",
  newsTitle: "News & updates",
  offeringsEyebrow: "// What we offer",
  offeringsTitle: "Our Learning Offerings",
});
seedSetting("footer", {
  tagline: "Training kids and adults in STEM, Robotics, IoT, Web Development and Graphic Design — hosted inside partner school campuses across Takoradi.",
  copyrightText: "All rights reserved © 2026 Dalijay Tech Hub",
});
// Global "Enrol" button shown in the header / hero. `targetOfferingSlug`
// picks which Learning Offering Type's registration flow it opens — the
// per-offering-type Enrol button config (learning_offering_types.settings.landing)
// is used instead when a specific Featured Offering card is clicked.
seedSetting("enrolButton", {
  text: "Enrol now",
  targetOfferingSlug: "kids_stem",
  openBehavior: "same_tab", // same_tab | new_tab
  visible: true,
});

console.log("✅ Public Website CMS ready (About, Home, How It Works, FAQs, Gallery, Partners, Campus profiles, News light-upgrade, Enrol button).");

// ============================================================
// Bootcamp extension — richer programme metadata (public display,
// eligibility, registration windows) and per-Batch/Cohort fee overrides.
// Additive/nullable only, so every existing programme/class row keeps
// behaving exactly as before. Not restricted to the Bootcamp offering
// type — any programme can opt into these fields, per the "zero code
// change for new offering types" pattern used throughout this file.
// ============================================================
tryAlter("ALTER TABLE programmes ADD COLUMN image_path TEXT");
tryAlter("ALTER TABLE programmes ADD COLUMN long_description TEXT");
tryAlter("ALTER TABLE programmes ADD COLUMN projects TEXT"); // JSON array of strings, e.g. project(s) to be built
tryAlter("ALTER TABLE programmes ADD COLUMN eligibility_audience TEXT NOT NULL DEFAULT 'both'"); // adults | children | both
tryAlter("ALTER TABLE programmes ADD COLUMN starts_at TEXT");              // programme/bootcamp start date
tryAlter("ALTER TABLE programmes ADD COLUMN ends_at TEXT");                // programme/bootcamp end date
// registration_opens_at / registration_deadline / registration_force_closed /
// registration_force_open used to be added here as Programme-level
// Registration Window fields. That ownership has moved exclusively to the
// Programme Run (see the "Registration Window ownership consolidation"
// migration at the end of this file, which backfills any existing data
// from these columns onto each Programme's active Run and then drops
// them) — fresh installs from this point on never create them at all.

// Per-Batch/Cohort fee override — what lets a single Bootcamp support e.g. a
// Weekday batch and a Weekend batch with separate fees. NULL = fall back to
// the programme/offering-type/global fee resolution chain (utils/fees.js).
tryAlter("ALTER TABLE classes ADD COLUMN fee_ghs INTEGER");

console.log("✅ Bootcamp extension ready (programme dates/eligibility/media, per-Batch fee overrides).");

// ============================================================
// Public registration audit follow-up — store the Kids STEM learner age
// that register.html has always collected but never sent anywhere (no
// column existed to receive it). Nullable/additive: every existing learner
// row simply gets age = NULL, and every existing INSERT that doesn't pass
// an age keeps working unchanged. toPublicUser()/getFullUser() already
// spread the full row through, so this needs no further wiring for it to
// show up wherever a learner's user object is already returned.
// ============================================================
tryAlter("ALTER TABLE users ADD COLUMN age INTEGER");

console.log("✅ Learner age column ready (register.html's age field is now persisted).");

// ============================================================
// Registration rework — Campus vs School Name, and multi-programme
// enrolment for existing accounts.
// ============================================================

// The learner's *actual* school (free text), kept separate from `campus`
// (which Builders' Lab campus/partner location they're registered under —
// picked from the admin-managed `campuses` list). The existing partner-fee
// discount rule (utils/fees.js) now requires this to MATCH the selected
// Campus's name (and that campus be partner-flagged) before it applies,
// instead of trusting the Campus selection alone. Nullable/additive: every
// existing row simply gets school_name = NULL (no discount either way,
// same as before this column existed).
tryAlter("ALTER TABLE users ADD COLUMN school_name TEXT");

// Lets an existing account (parent or adult learner) enrol into an
// additional Programme without creating a new account, while every previous
// enrolment/payment stays exactly as it is. `users.class_id` continues to
// represent that account's ORIGINAL/primary programme placement (zero
// change for every existing flow — dashboard, grading, transcripts,
// attendance, etc. all keep reading it exactly as before); each *additional*
// programme a learner enrols into afterwards gets its own row here instead.
db.exec(`
CREATE TABLE IF NOT EXISTS programme_enrollments (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  programme_id    TEXT NOT NULL REFERENCES programmes(id),
  class_id        TEXT REFERENCES classes(id),
  is_primary      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment | active | completed | suspended
  payment_status  TEXT NOT NULL DEFAULT 'unpaid',
  joined_date     TEXT NOT NULL DEFAULT (date('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_programme_enrollments_user ON programme_enrollments(user_id)");

// Ties a payment to the specific additional-programme enrolment it's for
// (NULL for every pre-existing payment — those already apply to the
// account's primary enrolment via the legacy users.status/payment_status
// path, unchanged).
tryAlter("ALTER TABLE payments ADD COLUMN programme_enrollment_id TEXT REFERENCES programme_enrollments(id)");

// One-time backfill: represent every existing learner's current placement
// as their PRIMARY row in the new table, so "My Programmes" has something
// to show immediately and nothing about existing data is lost or altered —
// this only ever INSERTs, never touches users/classes/payments.
{
  const already = new Set(
    db.prepare("SELECT user_id FROM programme_enrollments WHERE is_primary = 1").all().map((r) => r.user_id)
  );
  const learners = db
    .prepare("SELECT id, class_id, status, payment_status, joined_date FROM users WHERE role = 'learner' AND class_id IS NOT NULL")
    .all();
  const insertPrimary = db.prepare(
    `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  );
  const classToProgramme = new Map(db.prepare("SELECT id, programme_id FROM classes").all().map((c) => [c.id, c.programme_id]));
  learners.forEach((l) => {
    if (already.has(l.id)) return;
    const programmeId = classToProgramme.get(l.class_id);
    if (!programmeId) return; // orphaned class_id — nothing sensible to backfill
    insertPrimary.run(uuid(), l.id, programmeId, l.class_id, l.status, l.payment_status, l.joined_date || null);
  });
}

console.log("✅ Multi-programme enrolment ready (school_name column, programme_enrollments table).");

// ============================================================
// v11 — Learning Instance integration: wires the learning_instances table
// (created in a previous session, CRUD added last session) into every
// record type that represents actual activity within a run — Enrolments,
// Payments, Attendance, Assessments (Examinations + Continuous Assessment),
// Results (grades), and Certificates. "Transcripts" has no table of its
// own (utils/transcriptEngine.js computes them by reading grades/
// examination_attempts/ca_attempts/attendance directly), so those records
// carrying learning_instance_id is what makes a transcript run-scoped —
// no separate transcripts table exists to alter.
//
// Every column below is a NULLABLE additive FK, same tryAlter pattern as
// every prior addition in this file — no existing row is deleted, no
// existing column is dropped or renamed, no NOT NULL is introduced (a
// record predating any Learning Instance for its Programme/Module simply
// has learning_instance_id = NULL, which is the truthful state: it never
// belonged to a run, because runs didn't exist yet).
// ============================================================
tryAlter("ALTER TABLE programme_enrollments ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");
tryAlter("ALTER TABLE payments ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");
tryAlter("ALTER TABLE attendance ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");
tryAlter("ALTER TABLE assignment_submissions ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");
tryAlter("ALTER TABLE examination_attempts ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");
tryAlter("ALTER TABLE ca_attempts ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");
tryAlter("ALTER TABLE grades ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");
tryAlter("ALTER TABLE issued_certificates ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");

db.exec(`
CREATE INDEX IF NOT EXISTS idx_programme_enrollments_learning_instance ON programme_enrollments(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_payments_learning_instance ON payments(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_attendance_learning_instance ON attendance(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_assignment_submissions_learning_instance ON assignment_submissions(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_examination_attempts_learning_instance ON examination_attempts(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_ca_attempts_learning_instance ON ca_attempts(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_grades_learning_instance ON grades(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_issued_certificates_learning_instance ON issued_certificates(learning_instance_id);
`);

// One-time best-effort backfill: for every EXISTING row that is currently
// unattached (learning_instance_id IS NULL) and whose Programme/Module
// currently resolves to exactly one ACTIVE Learning Instance, attach it.
// This deliberately does NOT try to guess which of several
// completed/cancelled/archived instances an old row "must have" belonged
// to — that would be fabricating history, not preserving it. A row stays
// NULL (meaning: "predates Learning Instances, or its run is ambiguous/not
// yet configured") rather than being force-matched to a guess. Only run
// once per row (idempotent: already-NULL rows with no active instance stay
// NULL every time this migration re-runs; already-attached rows are never
// touched again).
{
  const activeInstanceByProgramme = new Map(
    db.prepare("SELECT programme_id, id FROM learning_instances WHERE status = 'active' AND programme_id IS NOT NULL").all()
      .map((r) => [r.programme_id, r.id])
  );
  const activeInstanceByCourse = new Map(
    db.prepare("SELECT course_id, id FROM learning_instances WHERE status = 'active' AND course_id IS NOT NULL").all()
      .map((r) => [r.course_id, r.id])
  );
  const classProgramme = new Map(db.prepare("SELECT id, programme_id FROM classes").all().map((c) => [c.id, c.programme_id]));
  const courseProgramme = new Map(db.prepare("SELECT id, programme_id FROM courses").all().map((m) => [m.id, m.programme_id]));

  // Resolves a course to an instance id: the course's own active instance
  // if one exists, otherwise its parent Programme's active instance —
  // mirrors utils/learningInstances.js's getActiveInstanceIdForCourse at
  // runtime, kept as a local copy here since migrate.js runs before the
  // rest of the app's require graph is guaranteed usable standalone.
  function instanceForCourse(courseId) {
    if (!courseId) return null;
    if (activeInstanceByCourse.has(courseId)) return activeInstanceByCourse.get(courseId);
    const programmeId = courseProgramme.get(courseId);
    return programmeId ? activeInstanceByProgramme.get(programmeId) || null : null;
  }
  function instanceForProgramme(programmeId) {
    return programmeId ? activeInstanceByProgramme.get(programmeId) || null : null;
  }
  function instanceForClass(classId) {
    if (!classId) return null;
    return instanceForProgramme(classProgramme.get(classId));
  }

  const updProgEnrol = db.prepare("UPDATE programme_enrollments SET learning_instance_id = ? WHERE id = ?");
  db.prepare("SELECT id, programme_id FROM programme_enrollments WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = instanceForProgramme(r.programme_id);
    if (iid) updProgEnrol.run(iid, r.id);
  });

  // Legacy single-account payments (pre-dating this Programme/Class
  // dual-write on the payments row itself) often carry neither
  // programme_id nor class_id on the payment — the only place that
  // association ever lived was the paying learner's own users.class_id.
  // Falling back to the payer's account when the payment row itself is
  // silent keeps this backfill from leaving every such row permanently
  // unattached (and therefore invisible to every learning_instance_id-
  // scoped total: Payments Overview, the Admin Overview "Statistics by
  // ..." panel). Deliberately only tried as a last resort, and only
  // through the payer's OWN class_id: a combined multi-ward charge
  // (payment.user_id is the paying PARENT, who has no class_id) still
  // correctly falls through to staying unattached here — those payments
  // are only ever meant to surface per-instance via
  // fanOutCombinedRegistrationPayment's own per-learner rows, not via
  // this parent row.
  const payerClassId = new Map(db.prepare("SELECT id, class_id FROM users").all().map((u) => [u.id, u.class_id]));
  const updPayment = db.prepare("UPDATE payments SET learning_instance_id = ? WHERE id = ?");
  db.prepare("SELECT id, user_id, programme_id, class_id FROM payments WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = instanceForProgramme(r.programme_id) || instanceForClass(r.class_id) || instanceForClass(payerClassId.get(r.user_id));
    if (iid) updPayment.run(iid, r.id);
  });

  const updAttendance = db.prepare("UPDATE attendance SET learning_instance_id = ? WHERE id = ?");
  db.prepare("SELECT id, course_id FROM attendance WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = instanceForCourse(r.course_id);
    if (iid) updAttendance.run(iid, r.id);
  });

  const noteCourse = new Map(db.prepare("SELECT id, course_id FROM notes").all().map((n) => [n.id, n.course_id]));
  const updAssignSub = db.prepare("UPDATE assignment_submissions SET learning_instance_id = ? WHERE id = ?");
  db.prepare("SELECT id, note_id FROM assignment_submissions WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = instanceForCourse(noteCourse.get(r.note_id));
    if (iid) updAssignSub.run(iid, r.id);
  });

  const examCourse = new Map(db.prepare("SELECT id, course_id FROM examinations").all().map((x) => [x.id, x.course_id]));
  const updExamAttempt = db.prepare("UPDATE examination_attempts SET learning_instance_id = ? WHERE id = ?");
  db.prepare("SELECT id, examination_id FROM examination_attempts WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = instanceForCourse(examCourse.get(r.examination_id));
    if (iid) updExamAttempt.run(iid, r.id);
  });

  const caCourse = new Map(db.prepare("SELECT id, course_id FROM continuous_assessments").all().map((c) => [c.id, c.course_id]));
  const updCaAttempt = db.prepare("UPDATE ca_attempts SET learning_instance_id = ? WHERE id = ?");
  db.prepare("SELECT id, assessment_id FROM ca_attempts WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = instanceForCourse(caCourse.get(r.assessment_id));
    if (iid) updCaAttempt.run(iid, r.id);
  });

  const updGrade = db.prepare("UPDATE grades SET learning_instance_id = ? WHERE user_id = ? AND course_id = ?");
  db.prepare("SELECT user_id, course_id FROM grades WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = instanceForCourse(r.course_id);
    if (iid) updGrade.run(iid, r.user_id, r.course_id);
  });

  const usersClass = new Map(db.prepare("SELECT id, class_id FROM users").all().map((u) => [u.id, u.class_id]));
  const updCert = db.prepare("UPDATE issued_certificates SET learning_instance_id = ? WHERE id = ?");
  db.prepare("SELECT id, course_id, learner_id FROM issued_certificates WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = r.course_id ? instanceForCourse(r.course_id) : instanceForClass(usersClass.get(r.learner_id));
    if (iid) updCert.run(iid, r.id);
  });
}

console.log("✅ Learning Instance integration ready (learning_instance_id wired into enrolments, payments, attendance, assessments, results, certificates).");

// ============================================================
// v12 — Instructor Portal Learning Instance integration.
//
// v11 (above) wired learning_instance_id into every *attempt/activity* row
// (attendance, examination_attempts, ca_attempts, grades, ...). It did not
// touch the *content/definition* records an instructor authors — Notes,
// Video Lessons, Monthly Topics, Examinations, and Continuous Assessments
// themselves (as opposed to a learner's attempt at one) — so those still
// had no way to say which run they were created for. This block closes
// that gap, the same nullable-additive-FK pattern as v11.
//
// Also adds notes.ai_quiz_enabled: AI quiz generation used to run
// unconditionally for every video lesson (and on-demand for every note) —
// this column makes it an explicit instructor opt-in, default OFF, per
// this milestone's "AI Quiz Behaviour" requirement. Existing rows default
// to 0 (disabled) rather than 1, so nothing that was already relying on an
// AI quiz silently keeps one without the instructor explicitly turning it
// back on for that lesson — see routes/notes.js, which intentionally does
// NOT auto-generate on migration; an instructor who wants a previously
// auto-generated quiz to keep working simply re-saves the note with the
// checkbox on.
// ============================================================
tryAlter("ALTER TABLE notes ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");
tryAlter("ALTER TABLE notes ADD COLUMN ai_quiz_enabled INTEGER NOT NULL DEFAULT 0");
// Notes/Video Lessons/Assignments previously had no publish state at all —
// a post went live to learners the instant it was created. This milestone's
// "Instructor Content Ownership" section requires Publish/Unpublish as
// first-class actions. Defaults to 1 (published) so every EXISTING row's
// learner-facing visibility is completely unchanged by this migration —
// only new/edited posts going forward actually exercise the unpublished
// state, via the instructor explicitly choosing it.
tryAlter("ALTER TABLE notes ADD COLUMN published INTEGER NOT NULL DEFAULT 1");
tryAlter("ALTER TABLE course_topics ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");
tryAlter("ALTER TABLE examinations ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");
tryAlter("ALTER TABLE continuous_assessments ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");

db.exec(`
CREATE INDEX IF NOT EXISTS idx_notes_learning_instance ON notes(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_course_topics_learning_instance ON course_topics(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_examinations_learning_instance ON examinations(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_continuous_assessments_learning_instance ON continuous_assessments(learning_instance_id);
`);

// Same best-effort, no-guessing backfill policy as v11: only attach an
// existing content row to a Learning Instance when its Course currently
// resolves to exactly one ACTIVE run. A row with no resolvable active
// instance stays NULL ("predates Learning Instances for this Course").
{
  const activeInstanceByCourse = new Map(
    db.prepare("SELECT course_id, id FROM learning_instances WHERE status = 'active' AND course_id IS NOT NULL").all()
      .map((r) => [r.course_id, r.id])
  );
  const activeInstanceByProgramme = new Map(
    db.prepare("SELECT programme_id, id FROM learning_instances WHERE status = 'active' AND programme_id IS NOT NULL").all()
      .map((r) => [r.programme_id, r.id])
  );
  const courseProgramme = new Map(db.prepare("SELECT id, programme_id FROM courses").all().map((m) => [m.id, m.programme_id]));
  function instanceForCourse(courseId) {
    if (!courseId) return null;
    if (activeInstanceByCourse.has(courseId)) return activeInstanceByCourse.get(courseId);
    const programmeId = courseProgramme.get(courseId);
    return programmeId ? activeInstanceByProgramme.get(programmeId) || null : null;
  }

  const updNote = db.prepare("UPDATE notes SET learning_instance_id = ? WHERE id = ?");
  db.prepare("SELECT id, course_id FROM notes WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = instanceForCourse(r.course_id);
    if (iid) updNote.run(iid, r.id);
  });
  const updTopic = db.prepare("UPDATE course_topics SET learning_instance_id = ? WHERE id = ?");
  db.prepare("SELECT id, course_id FROM course_topics WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = instanceForCourse(r.course_id);
    if (iid) updTopic.run(iid, r.id);
  });
  const updExam = db.prepare("UPDATE examinations SET learning_instance_id = ? WHERE id = ?");
  db.prepare("SELECT id, course_id FROM examinations WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = instanceForCourse(r.course_id);
    if (iid) updExam.run(iid, r.id);
  });
  const updCa = db.prepare("UPDATE continuous_assessments SET learning_instance_id = ? WHERE id = ?");
  db.prepare("SELECT id, course_id FROM continuous_assessments WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = instanceForCourse(r.course_id);
    if (iid) updCa.run(iid, r.id);
  });
}

console.log("✅ Instructor Portal Learning Instance integration ready (notes/video lessons/topics/examinations/continuous assessments tagged; AI quiz generation is now opt-in).");

// ============================================================
// v13 — close the "AI Quiz / Project scores are untagged" gap flagged in
// FIX_NOTES_admin_learning_instance_integration_continuation.md: a
// transcript's "Tests" component can draw from progress.quiz_score (AI
// Quiz) and projects.mark, and neither table had a learning_instance_id
// column, so those two contributions were invisible to the mixed-run
// detector in utils/learningInstances.js's distinctInstanceIdsForCourse
// (see routes/progress.js and routes/projects.js for where these are now
// resolved and stored at write time — same nullable-additive-FK, no-
// guessing-on-historical-rows pattern as v11/v12).
// ============================================================
tryAlter("ALTER TABLE progress ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");
tryAlter("ALTER TABLE projects ADD COLUMN learning_instance_id TEXT REFERENCES learning_instances(id)");

db.exec(`
CREATE INDEX IF NOT EXISTS idx_progress_learning_instance ON progress(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_projects_learning_instance ON projects(learning_instance_id);
`);

// Same best-effort, only-when-unambiguous backfill as v11/v12.
{
  const activeInstanceByCourse = new Map(
    db.prepare("SELECT course_id, id FROM learning_instances WHERE status = 'active' AND course_id IS NOT NULL").all()
      .map((r) => [r.course_id, r.id])
  );
  const activeInstanceByProgramme = new Map(
    db.prepare("SELECT programme_id, id FROM learning_instances WHERE status = 'active' AND programme_id IS NOT NULL").all()
      .map((r) => [r.programme_id, r.id])
  );
  const courseProgramme = new Map(db.prepare("SELECT id, programme_id FROM courses").all().map((m) => [m.id, m.programme_id]));
  function instanceForCourse(courseId) {
    if (!courseId) return null;
    if (activeInstanceByCourse.has(courseId)) return activeInstanceByCourse.get(courseId);
    const programmeId = courseProgramme.get(courseId);
    return programmeId ? activeInstanceByProgramme.get(programmeId) || null : null;
  }

  const updProgress = db.prepare("UPDATE progress SET learning_instance_id = ? WHERE user_id = ? AND course_id = ? AND lesson_id = ?");
  db.prepare("SELECT user_id, course_id, lesson_id FROM progress WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = instanceForCourse(r.course_id);
    if (iid) updProgress.run(iid, r.user_id, r.course_id, r.lesson_id);
  });
  const updProject = db.prepare("UPDATE projects SET learning_instance_id = ? WHERE id = ?");
  db.prepare("SELECT id, course_id FROM projects WHERE learning_instance_id IS NULL").all().forEach((r) => {
    const iid = instanceForCourse(r.course_id);
    if (iid) updProject.run(iid, r.id);
  });
}

console.log("✅ AI Quiz / Project score Learning Instance coverage ready (progress.learning_instance_id, projects.learning_instance_id).");

// ============================================================
// v14 — Learner/Parent Access Restriction Engine: admin-controlled override
// on top of the existing users.status/payment_status columns (see
// utils/accessControl.js). Safe to re-run on an existing database — these
// are purely additive, nullable/defaulted columns; every existing row keeps
// exactly the effective access it has today (access_override defaults to 0,
// so nothing changes for any account until an admin explicitly sets one).
// ============================================================
tryAlter("ALTER TABLE users ADD COLUMN access_override INTEGER NOT NULL DEFAULT 0");
tryAlter("ALTER TABLE users ADD COLUMN access_override_reason TEXT");
tryAlter("ALTER TABLE users ADD COLUMN access_override_expires_at TEXT");

console.log("✅ Access Restriction Engine ready (users.access_override/access_override_reason/access_override_expires_at).");

// ============================================================
// v15 — Examination & Continuous Assessment controls: optional closing
// date/time, optional timed attempts, and tab/window-switch violation
// tracking. Purely additive/nullable-or-defaulted columns, same tryAlter
// pattern as every migration above — every existing examination/CA and every
// existing attempt row keeps behaving exactly as it does today:
//   - closes_at is NULL by default -> no calendar deadline, unchanged.
//   - timed_enabled defaults to 0 -> no attempt-duration limit, unchanged.
//   - every attempt row created before this migration already has a real
//     score/answers from the old single-step submit flow, so it is left as
//     status='submitted' (the DEFAULT) — it was already a completed
//     attempt and must keep displaying/behaving as one.
//   - violation_count defaults to 0, ended_reason stays NULL for old rows
//     (they ended by ordinary submission, which needs no reason recorded).
//
// New attempts go through an explicit start -> (violation)* -> submit
// lifecycle so a page refresh/reopen cannot reset the timer or the
// violation count (both are persisted here, not in client state), and a
// second tab/window violation cannot be undone by any client action.
// ============================================================
tryAlter("ALTER TABLE examinations ADD COLUMN closes_at TEXT"); // ISO datetime; NULL = no closing deadline
tryAlter("ALTER TABLE examinations ADD COLUMN timed_enabled INTEGER NOT NULL DEFAULT 0");
tryAlter("ALTER TABLE examinations ADD COLUMN duration_minutes INTEGER"); // only meaningful when timed_enabled=1

tryAlter("ALTER TABLE continuous_assessments ADD COLUMN closes_at TEXT");
tryAlter("ALTER TABLE continuous_assessments ADD COLUMN timed_enabled INTEGER NOT NULL DEFAULT 0");
tryAlter("ALTER TABLE continuous_assessments ADD COLUMN duration_minutes INTEGER");

// started_at: when the learner actually began the attempt (timer start).
// deadline_at: the effective deadline computed AT START TIME from
// closes_at/duration_minutes (see utils/assessmentTiming.js) — frozen onto
// the attempt itself so it survives refreshes and can't be extended by
// reopening the page. status: 'in_progress' | 'submitted' | 'expired' |
// 'violation'. ended_reason: 'submitted' | 'closing_date' | 'expired' |
// 'violation' | NULL (pre-migration rows / not yet ended).
tryAlter("ALTER TABLE examination_attempts ADD COLUMN started_at TEXT");
tryAlter("ALTER TABLE examination_attempts ADD COLUMN deadline_at TEXT");
tryAlter("ALTER TABLE examination_attempts ADD COLUMN status TEXT NOT NULL DEFAULT 'submitted'");
tryAlter("ALTER TABLE examination_attempts ADD COLUMN violation_count INTEGER NOT NULL DEFAULT 0");
tryAlter("ALTER TABLE examination_attempts ADD COLUMN ended_reason TEXT");

tryAlter("ALTER TABLE ca_attempts ADD COLUMN started_at TEXT");
tryAlter("ALTER TABLE ca_attempts ADD COLUMN deadline_at TEXT");
tryAlter("ALTER TABLE ca_attempts ADD COLUMN status TEXT NOT NULL DEFAULT 'submitted'");
tryAlter("ALTER TABLE ca_attempts ADD COLUMN violation_count INTEGER NOT NULL DEFAULT 0");
tryAlter("ALTER TABLE ca_attempts ADD COLUMN ended_reason TEXT");

console.log("✅ Examination/CA closing-date, timed-attempt and tab-violation controls ready.");

// ============================================================
// Combined parent multi-ward registration charges (routes/payments.js
// POST /:userId/initiate, type='registration' + account.role='parent')
// are recorded as ONE payments row against the PARENT's user_id, tagged
// only with `learner_ids` (JSON array of covered learner ids) — it never
// carried a programme_id/class_id/learning_instance_id, because it can
// cover several wards across different Programmes/runs at once.
//
// That meant this payment was invisible to every per-learner or
// per-Learning-Instance figure: Payments Overview (keyed off each
// learner's OWN user_id), and the Admin Overview "Statistics by Learning
// Offering Type / Programme / Module / Learning Instance" panel (summed
// off payments.learning_instance_id) — exactly the "I registered and paid,
// but Active runs / the stats panel don't reflect it" and "no financial
// statistics for Amounts generated through registrations" reports.
//
// Fix: `learner_breakdown` stores the per-learner amount this charge
// covered (JSON: [{id, amountGHS}]), captured once at charge time from
// the same registrationBreakdown() already computed for the total. Once
// the charge succeeds, utils/paymentActivation.js fans this out into one
// additional payments row PER learner — each carrying that learner's own
// user_id, amount, programme_id, class_id and learning_instance_id
// (resolved fresh at activation time) — so it plugs directly into every
// existing per-learner/per-instance query with no further changes there.
// The original combined row is kept as-is (unchanged shape) purely as the
// Paystack-reference-matching record for the webhook/verify/OTP flow;
// admin financial views exclude it via `learner_ids IS NULL` so its total
// is never double-counted against the new per-learner rows.
// ============================================================
tryAlter("ALTER TABLE payments ADD COLUMN learner_breakdown TEXT");
console.log("✅ Combined multi-ward registration payments now fan out to per-learner, per-Learning-Instance records.");

// ============================================================
// routes/exams.js's instructor "Create examination" Type dropdown ignored
// the Learning Offering Type Settings → Assessments → "Midterm Exams /
// End of Term Exams / Retake Exams" toggles entirely (always showed the
// classic set regardless), so turning them on/off in the Admin Portal had
// no effect on what instructors saw — exactly the "Type dropdown options
// don't show" / "still unresolved" report. Now that exams.js actually
// reads them (see allowedTermTypesForModule), every offering type that was
// seeded/created before this fix has all three sitting at the *old*
// default of `false` — which would make the Type dropdown empty for
// everyone the moment this ships. Backfill: any offering type whose
// stored settings still have all three at `false` (i.e. nobody has ever
// deliberately customized them — an admin who genuinely wants a bare
// dropdown would have to have set that explicitly since it doesn't match
// any prior on-disk default) gets them flipped to `true`, matching the
// classic Midterm/End Of Term/Retake behaviour every existing offering
// type already had in practice.
{
  const rows = db.prepare("SELECT id, slug, settings FROM learning_offering_types").all();
  const backfill = db.prepare("UPDATE learning_offering_types SET settings = ? WHERE id = ?");
  let touched = 0;
  rows.forEach((row) => {
    if (["corporate_training", "bootcamp"].includes(row.slug)) return; // Final-only by design, unaffected either way.
    let settings;
    try {
      settings = JSON.parse(row.settings || "{}");
    } catch (e) {
      settings = {};
    }
    const a = settings.assessments || {};
    if (a.midtermExams === false && a.endOfTermExams === false && a.retakeExams === false) {
      settings.assessments = { ...a, midtermExams: true, endOfTermExams: true, retakeExams: true };
      backfill.run(JSON.stringify(settings), row.id);
      touched++;
    }
  });
  if (touched) console.log(`✅ Backfilled Midterm/End Of Term/Retake Exams toggles to "on" for ${touched} pre-existing Learning Offering Type(s).`);
}

// ============================================================
// Adult Professional, Corporate Training and Bootcamp programmes run
// Learning Offering Type -> Programme -> Batch/Cohort, with no Module
// level at all (unlike Kids STEM's Programme -> Module -> Class shape) —
// the public registration flow (register.html's Adult/Parent-Learner
// "onAdultProgrammeChange"/"onParentOfferingChange" handlers) already goes
// straight from Programme to Batch/Cohort for every non-Kids-STEM offering
// type and never shows a Module picker. Their Learning Offering Type
// Settings row still had academicStructure.usesModules sitting at the
// generic default (`true`), which is simply wrong for these three and was
// never corrected — this backfill fixes that stored value so the setting
// finally reflects reality. (The instructor-portal content
// tools — Notes/Examinations/Attendance/Grading — still key off Module
// under the hood for every offering type today; giving those a genuine
// Module-free path for these three is a larger follow-up, not something
// this single settings correction can complete on its own.)
{
  const NO_MODULE_SLUGS = ["adult_professional", "corporate_training", "bootcamp"];
  const rows = db.prepare("SELECT id, slug, settings FROM learning_offering_types WHERE slug IN (?, ?, ?)").all(...NO_MODULE_SLUGS);
  const backfill = db.prepare("UPDATE learning_offering_types SET settings = ? WHERE id = ?");
  let touched = 0;
  rows.forEach((row) => {
    let settings;
    try {
      settings = JSON.parse(row.settings || "{}");
    } catch (e) {
      settings = {};
    }
    if (settings.academicStructure && settings.academicStructure.usesModules === false) return; // already correct
    settings.academicStructure = { ...(settings.academicStructure || {}), usesModules: false };
    backfill.run(JSON.stringify(settings), row.id);
    touched++;
  });
  if (touched) console.log(`✅ Corrected "Uses Modules" to off for ${touched} Adult Professional/Corporate Training/Bootcamp Learning Offering Type(s) (Programme → Batch/Cohort, no Module level).`);
}

// ============================================================
// Sponsorship (NGO / MP / corporate / individual sponsors covering a
// learner's fees) — foundation piece of a larger effort (see also: staff-
// mediated free/sponsored child intake without a parent account, and
// cohort-scoped module selection at registration — both deliberately NOT
// part of this pass; this lays the data model + admin CRUD they'll build
// on).
//
// `sponsors` mirrors `corporate_clients` (same shape: name/contact/
// active flag) rather than introducing a different pattern for what is,
// structurally, the same kind of "organization funding some learners"
// entity — reusing a proven shape instead of inventing a new one.
//
// `sponsor_id` is added to BOTH `users` (the common case: a sponsor
// covers a learner's whole account/primary enrolment) and
// `programme_enrollments` (the less common but real case: a learner
// self-pays their primary programme but a sponsor covers a *specific
// additional* programme enrolment — see routes/enrolments.js). Both
// reference the same `sponsors` row; nothing here assumes only one can
// be set.
//
// Deliberately does NOT introduce a new payment_status enum value or
// migrate any existing rows. Attaching a sponsor (see
// PATCH /api/users/:userId/sponsor) only records who is responsible for a
// learner's fees — it does not waive payment_status or touch
// balance_owed_ghs. There is no general sponsor-payment waiver; a
// sponsored learner is gated by the normal payment/status rules (see
// utils/accessControl.js) until a real payment is recorded, or the Hub
// separately grants an Access Override.
db.exec(`
CREATE TABLE IF NOT EXISTS sponsors (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  type          TEXT NOT NULL DEFAULT 'ngo', -- ngo | mp | corporate | individual | other
  contact_name  TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  notes         TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
tryAlter("ALTER TABLE users ADD COLUMN sponsor_id TEXT REFERENCES sponsors(id)");
tryAlter("ALTER TABLE programme_enrollments ADD COLUMN sponsor_id TEXT REFERENCES sponsors(id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_users_sponsor ON users(sponsor_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_programme_enrollments_sponsor ON programme_enrollments(sponsor_id)");
console.log("✅ Sponsorship foundation ready (sponsors table, users.sponsor_id, programme_enrollments.sponsor_id).");

// ------------------------------------------------------------
// Coordinator accounts (Part 3 of the sponsorship work, revised): rather
// than a coordinator self-registering and staff manually verifying and
// attaching a sponsor per child afterward, an admin now creates the
// coordinator's login directly (POST /api/users/coordinators) — identity
// is established at issuance, not verified after the fact — and hands
// the credentials over. Because the account is created with a known
// sponsor_id already attached, every child that coordinator adds via
// POST /:parentId/children is auto-sponsored (linked to that sponsor)
// immediately — not auto-paid; see routes/users.js for why —
// with no separate per-child staff action needed (see that route in
// routes/users.js).
//
// Two independent caps, both optional (NULL = unlimited):
//   - users.max_children: how many children THIS coordinator account may
//     add. Set per coordinator at creation time.
//   - sponsors.max_learners: how many learners TOTAL may ever be
//     attached to this sponsor, across every coordinator account tied to
//     it (an NGO might have several coordinators; the funding commitment
//     is org-wide, not per-login). Enforced both by the auto-sponsor path
//     above and by the manual PATCH /api/users/:userId/sponsor attach
//     action, so the cap can't be bypassed either way.
tryAlter("ALTER TABLE users ADD COLUMN max_children INTEGER");
tryAlter("ALTER TABLE sponsors ADD COLUMN max_learners INTEGER");
console.log("✅ Coordinator accounts ready (users.max_children, sponsors.max_learners).");

// ------------------------------------------------------------
// Coordinator scope: Kids STEM and Adult Professional/Corporate
// Training/Bootcamp are structurally different registrations (module
// checklist + default entry class vs Offering Type → Programme →
// Batch/Cohort picker, is_adult flag, no module requirement) — a
// coordinator now has an explicit scope deciding which they're allowed
// to register:
//   'child' — Kids STEM only (the original, default behavior — every
//             coordinator created before this migration behaves exactly
//             as before, since NULL is treated as 'child' everywhere
//             this is read)
//   'adult' — Adult/Corporate/Bootcamp-style programmes only
//   'both'  — coordinator picks per learner at registration time (see
//             POST /:parentId/children's learnerType param)
// NULL for every non-coordinator (ordinary parent) account — irrelevant
// there, since an ordinary parent can only ever add children regardless.
tryAlter("ALTER TABLE users ADD COLUMN coordinator_scope TEXT");
console.log("✅ Coordinator scope ready (users.coordinator_scope: child | adult | both).");

// ============================================================
// v17 — Delivery Mode (On-Campus vs Online). `classes` gains the two
// delivery-specific columns per the Unified Learning Architecture:
// delivery_mode ('ON_CAMPUS' | 'ONLINE') and campus_id (only meaningful
// for ON_CAMPUS). Both purely additive/nullable, same tryAlter pattern as
// every prior column in this file — every existing class (Foundation/
// Framework/Skyline, every pre-existing Adult/Bootcamp/Corporate batch)
// keeps delivery_mode = NULL, campus_id = NULL, and behaves exactly as
// before: registration/enrolment/fee/learning-instance resolution for a
// NULL-delivery_mode class is completely unaffected (see routes/auth.js's
// delivery-mode branch, which is only entered when the resolved class
// actually has a non-NULL delivery_mode).
//
// Deliberately NOT added to `learning_instances` or `programme_enrollments`
// — a Learning Instance is a run of a Programme/Module and already happily
// hosts multiple Classes/Learning Groups under one Active run (that's the
// entire reason Classes exist as their own level between Programme and
// enrolment); an ON_CAMPUS class and an ONLINE class under the same
// Programme can already both point at that Programme's one Active
// Learning Instance simultaneously with zero schema change here — the
// existing idx_learning_instances_one_active_per_programme constraint
// only limits how many Active runs one Programme may have, not how many
// delivery-mode classes may enrol into that one run. No uniqueness
// adjustment is required for online/on-campus to coexist under one
// Programme's single Active Learning Instance.
//
// campus_id intentionally carries no DB-level CHECK tying it to
// delivery_mode (SQLite's ADD COLUMN can't safely express a cross-column
// CHECK the way every other tryAlter column in this file avoids
// constraints beyond a plain FK) — that pairing (ON_CAMPUS requires a
// valid, active campus_id; ONLINE requires campus_id IS NULL) is validated
// in application code at the point a Class is created/edited
// (routes/classes.js) and again at registration time (routes/auth.js),
// matching how every other cross-field business rule in this codebase is
// enforced.
// ============================================================
tryAlter("ALTER TABLE classes ADD COLUMN delivery_mode TEXT"); // ON_CAMPUS | ONLINE | NULL (legacy/unspecified)
tryAlter("ALTER TABLE classes ADD COLUMN campus_id TEXT REFERENCES campuses(id)"); // only meaningful for ON_CAMPUS

db.exec(`
CREATE INDEX IF NOT EXISTS idx_classes_delivery_mode ON classes(delivery_mode);
CREATE INDEX IF NOT EXISTS idx_classes_campus ON classes(campus_id);
`);

console.log("✅ Delivery Mode ready (classes.delivery_mode, classes.campus_id — On-Campus vs Online; legacy classes/registrations unaffected).");

// ============================================================
// v18 — Currency-awareness foundation for `payments` (Step 1 of the
// Multi-Currency / International Learner Support architectural
// assessment). Purely additive: one nullable-by-default-but-populated
// column, no rename/redesign of any existing GHS fee configuration
// (site_settings.fees.*GHS, classes.fee_ghs, users.balance_owed_ghs all
// stay exactly as they are).
//
// `currency` defaults to 'GHS' via SQLite's ADD COLUMN ... DEFAULT, which
// (unlike a plain nullable column) backfills every existing row with the
// literal string 'GHS' at ALTER time, not just for future INSERTs. That's
// correct rather than a compromise: every historical payment in this
// system was, in fact, charged in Ghanaian Cedis — there's no reinterpretation
// happening, just making a previously-implicit fact into explicit data.
// New rows inserted through the existing Mobile Money flow (routes/
// payments.js, utils/paymentActivation.js) don't name `currency` in their
// INSERT column lists, so they also get 'GHS' automatically — the MoMo
// flow itself required zero code changes.
//
// No FX conversion, no exchange-rate storage, no per-country pricing here
// — left for a later task once an actual international payment provider
// path exists to populate a non-GHS currency in the first place.
// ============================================================
tryAlter("ALTER TABLE payments ADD COLUMN currency TEXT NOT NULL DEFAULT 'GHS'"); // ISO 4217, e.g. 'GHS'

console.log("✅ Payments currency column ready (payments.currency, defaults to 'GHS' — Ghana Mobile Money flow unaffected).");

// ============================================================
// v19 — Country-aware registration data (the international-learner
// follow-up to Step 1's payments-currency foundation). Purely additive:
// `users.country` is a plain nullable TEXT column with NO default and no
// backfill — historical accounts predate any capture of where a learner
// registered from, so leaving them NULL is the honest state rather than
// asserting 'GH' for every one of them the way payments.currency's
// backfill safely could (that column's history was provably 100% GHS;
// this one isn't provably 100% Ghana even though every existing
// registration went through the Ghana-only flow).
//
// Two-letter ISO 3166-1 alpha-2 codes (e.g. 'GH', 'US', 'GB') — the same
// representation real payment-provider country routing uses, so this is
// immediately reusable by the next (international-payment) task without
// another migration. New registrations explicitly write 'GH' (the UI's
// default selection) or the registrant's chosen code at INSERT time in
// routes/auth.js's resolveCountry() — never left to a schema-level
// default — so a pre-country cached frontend build that omits the field
// entirely still gets a correct 'GH' row, exactly like today.
// ============================================================
tryAlter("ALTER TABLE users ADD COLUMN country TEXT");
console.log("✅ users.country ready (nullable ISO 3166-1 alpha-2 code; NULL for every pre-existing account, never guessed).");

// ============================================================
// v20 — Sponsor/Coordinator credential visibility (Stage 4A). A learner
// created through POST /:parentId/children (both the Kids STEM and
// Adult-under-coordinator branches — see routes/users.js) gets an
// auto-generated password; before this, the plaintext was only ever in
// that one POST response and nowhere else — refresh the page, and it's
// gone forever even though the sponsor/coordinator still needs to hand
// it to the learner.
//
// This does NOT weaken the existing security model (only password_hash
// is ever checked at login — see routes/auth.js's bcrypt.compareSync
// call, untouched); it adds a narrow, deliberately time-boxed exception:
// the plaintext is kept ONLY until the learner's own first successful
// login (see routes/auth.js's /login handler, which clears this column
// right after that first successful bcrypt check), specifically so the
// sponsor/coordinator has a real window to view/print it. A learner who
// never logs in themselves (common for young children, whose sponsor/
// parent signs in on their behalf) simply keeps a visible credential
// until an admin/coordinator resets it.
//
// Nullable, no default, no backfill: every pre-existing learner predates
// this column and correctly has nothing to show (their original
// plaintext was already unrecoverable, and manufacturing one now would
// invalidate their real, working password).
// ============================================================
tryAlter("ALTER TABLE users ADD COLUMN temp_password_plaintext TEXT");
console.log("✅ users.temp_password_plaintext ready (nullable; cleared automatically at the learner's first successful login).");

// ============================================================
// v22 — Stage 4G: capture Town/City of residence alongside the existing
// `country` field. `country` (v19-ish, resolveCountry() in routes/auth.js)
// is untouched. `town` is a plain free-text field, deliberately separate
// from `campus` (a physical Builders' Lab site) and `school_name` (the
// learner's own school) — it answers "what town/city do you live in?",
// not "where do you attend". Nullable, so every pre-existing account
// (and any API caller that predates this field) keeps working exactly as
// before; only the registration forms require it going forward.
// ============================================================
tryAlter("ALTER TABLE users ADD COLUMN town TEXT");
console.log("✅ users.town ready (nullable; captured at registration alongside country).");

// ============================================================
// v21 — Duplicate-enrolment guard (Stage 4D). routes/enrolments.js's
// POST / already rejects a second active/pending_payment enrolment in
// the same programme with a 409 before inserting (application-level
// check). This adds the matching DB-level backstop: a partial UNIQUE
// index over (user_id, programme_id) restricted to the two "live"
// statuses, so even a second concurrent request (or any future insert
// path that forgets the app-level check) can't create a duplicate row.
// Completed/inactive/withdrawn enrolments are deliberately excluded so a
// learner can always be re-enrolled in a programme they previously left
// or finished.
// ============================================================
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_programme_enrollments_no_dup_active ON programme_enrollments(user_id, programme_id) WHERE status IN ('pending_payment','active')"
);
console.log("✅ Duplicate-enrolment guard ready (unique index on programme_enrollments for active/pending_payment rows).");

// ============================================================
// v23 — Stage 4C/4E: Multi-target Learning Instances. A Learning Instance
// was originally exactly one run of one Programme *or* one Module
// (learning_instances.programme_id/module_id, mutually exclusive via the
// table's CHECK constraint). Kids STEM registration must now show only
// Programmes/Modules that belong to a currently-Active run, and one run
// must be able to bundle several Programmes/Modules together (e.g. one
// "Jan 2026 Cohort" Learning Instance covering three Modules at once)
// instead of needing a separate Learning Instance per target.
//
// This is purely additive — learning_instances.programme_id/module_id and
// its CHECK/unique indexes are UNTOUCHED, so every existing reader of
// those columns (dashboard-stats, the admin list, instructor scoping,
// certificates/transcripts, etc.) keeps working exactly as before with
// zero code changes required elsewhere. `programme_id`/`module_id` now
// mean "this run's *primary* target" (still required at creation, exactly
// as today); learning_instance_targets is the new join table holding
// EVERY target a run serves, including that same primary target mirrored
// in row form (see the backfill below) plus any additional targets an
// admin attaches afterwards via POST /:id/targets.
//
// `instance_status` is a deliberate denormalized copy of the parent
// learning_instances.status (same "denormalized for fast/DB-enforced
// scoping" pattern this schema already uses for offering_type_id on
// programmes/classes/modules/learning_instances) — kept in sync by
// application code (routes/learningInstances.js) every time a run's
// status changes, specifically so a partial UNIQUE index can enforce
// "only one Active run may claim a given Programme/Module" at the DB
// level across ALL of a run's targets, not just its primary one — the
// same backstop idx_learning_instances_one_active_per_programme/_module
// already gave the single-target model, now correctly extended to cover
// secondary targets too.
db.exec(`
CREATE TABLE IF NOT EXISTS learning_instance_targets (
  id                   TEXT PRIMARY KEY,
  learning_instance_id TEXT NOT NULL REFERENCES learning_instances(id) ON DELETE CASCADE,
  target_type          TEXT NOT NULL CHECK (target_type IN ('programme', 'course')),
  programme_id         TEXT REFERENCES programmes(id),
  course_id            TEXT REFERENCES courses(id),
  is_primary           INTEGER NOT NULL DEFAULT 0, -- 1 for the target mirroring learning_instances.programme_id/course_id; can't be removed via DELETE /:id/targets/:targetId
  instance_status      TEXT NOT NULL DEFAULT 'upcoming', -- denormalized copy of the parent learning_instances.status; see note above
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (target_type = 'programme' AND programme_id IS NOT NULL AND course_id IS NULL)
    OR (target_type = 'course' AND course_id IS NOT NULL AND programme_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_lit_instance ON learning_instance_targets(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_lit_programme ON learning_instance_targets(programme_id);
CREATE INDEX IF NOT EXISTS idx_lit_course ON learning_instance_targets(course_id);
-- A given Programme/Course can only be attached to the same run once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lit_unique_programme_per_instance ON learning_instance_targets(learning_instance_id, programme_id) WHERE programme_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lit_unique_course_per_instance ON learning_instance_targets(learning_instance_id, course_id) WHERE course_id IS NOT NULL;
-- ABRS v2.2 amendment (concurrent Programme Runs): this schema used to
-- enforce, here, that only one Active run system-wide may claim a given
-- Programme/Course, across all of that run's targets. Deliberately
-- removed — see the matching note on idx_learning_instances_one_active_
-- per_programme/_course above. A Programme (or Course) may now have any
-- number of concurrently Active Runs; each carries its own independent
-- Academic Calendar/Periods, registration window, and Operational Groups.
-- Everything that previously *resolved* "the" single active run for a
-- Programme/Course (registration, fee preview, etc.) must now either
-- require an explicit disambiguator (an operationalGroupId or
-- learningInstanceId) when more than one Active Run exists, or fall back
-- to a documented default (most-recently-activated) — see
-- getActiveInstanceIdForProgramme/getActiveInstanceIdForCourse in
-- utils/learningInstances.js. The old indexes are dropped explicitly
-- below for databases that already have them; intentionally not
-- recreated here.
`);

// Backfill: every existing learning_instances row becomes exactly one
// learning_instance_targets row (its primary target), carrying over that
// row's current status — "their existing programme/module association
// must become an equivalent target association", with zero data loss and
// nothing guessed (the target type/id/status all come directly off the
// existing row). Safe to re-run: skipped per-row if already backfilled.
{
  const existingInstances = db.prepare("SELECT id, programme_id, course_id, status FROM learning_instances").all();
  const alreadyBackfilled = new Set(
    db.prepare("SELECT learning_instance_id FROM learning_instance_targets WHERE is_primary = 1").all().map((r) => r.learning_instance_id)
  );
  const insertTarget = db.prepare(
    `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, course_id, is_primary, instance_status)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  );
  let backfilled = 0;
  for (const li of existingInstances) {
    if (alreadyBackfilled.has(li.id)) continue;
    const targetType = li.programme_id ? "programme" : "course";
    insertTarget.run(uuid(), li.id, targetType, li.programme_id || null, li.course_id || null, li.status);
    backfilled += 1;
  }
  console.log(`✅ Multi-target Learning Instances ready (learning_instance_targets); backfilled ${backfilled} existing run(s) into their primary target row.`);
}

// v24 — Phase 3: Kids STEM registration catalogue is gated on active
// Learning Instances (see server/src/routes/modules.js GET /open and the
// matching final-validation checks in routes/auth.js/users.js/enrolments.js)
// — a Module/Course with no Active Learning Instance (Active Programme Run)
// cannot be selected at registration, and registration for a Programme with
// no Active Programme Run remains closed outright.
//
// IMPORTANT: this migration deliberately does NOT auto-create Learning
// Instances for already-open Modules. Programme Runs must only ever be
// created intentionally by an administrator — never inferred, never
// generated automatically, regardless of how many Modules/Courses are
// already open for self-enrolment. If a Programme has no Active Programme
// Run, the correct, intended behaviour is that registration simply reports
// there are currently no available registration opportunities, not that the
// system silently manufactures one on its behalf. An earlier draft of this
// migration did auto-create one Active Learning Instance per already-open
// Module; that draft was never shipped and has been removed rather than run.

// ============================================================
// v25 — Phase 4: Academic Structure per Learning Instance. Every Learning
// Instance may now declare its own academic structure — 'semester' (exactly
// 2 academic periods) or 'term' (exactly 3) — reusing the existing
// Academic Session/Term & Calendar Engine's naming conventions (Term 1/2/3)
// rather than inventing a parallel one, but scoped to the Learning
// Instance rather than school-wide: a Learning Instance's periods are its
// own run's Semester 1/2 or Term 1/2/3, independent of whatever the
// system-wide academic_terms "current term" happens to be at the time
// (that global concept stays exactly as-is — nothing here touches
// academic_years/academic_terms/academic_calendar_periods or any of their
// existing readers). `academic_term_id` is an OPTIONAL cross-reference an
// admin can set later to align a Learning Instance's period with the
// school-wide calendar for reporting; never inferred/guessed here.
//
// Purely additive: learning_instances.academic_structure is a new nullable
// column (existing rows: NULL — no structure configured, exactly the
// "don't force a guess onto historical data" rule this task was given
// under), and learning_instance_academic_periods is a brand new table with
// zero existing readers, so nothing else in the codebase changes behavior.
// ============================================================
tryAlter("ALTER TABLE learning_instances ADD COLUMN academic_structure TEXT CHECK (academic_structure IN ('semester','term'))");

db.exec(`
CREATE TABLE IF NOT EXISTS learning_instance_academic_periods (
  id                   TEXT PRIMARY KEY,
  learning_instance_id TEXT NOT NULL REFERENCES learning_instances(id) ON DELETE CASCADE,
  sequence             INTEGER NOT NULL,  -- 1-based; 1..2 for 'semester', 1..3 for 'term'
  name                 TEXT NOT NULL,     -- e.g. "Semester 1" / "Term 2" — admin-renameable
  academic_term_id     TEXT REFERENCES academic_terms(id), -- optional link to the school-wide calendar; NULL until an admin sets it
  start_date           TEXT,              -- yyyy-mm-dd, optional
  end_date             TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(learning_instance_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_li_academic_periods_instance ON learning_instance_academic_periods(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_li_academic_periods_term ON learning_instance_academic_periods(academic_term_id);
`);
console.log("✅ Academic Structure per Learning Instance ready (learning_instances.academic_structure, learning_instance_academic_periods).");

// ============================================================
// v26 — Phase 5: Period-specific target configuration. A Learning
// Instance's general target list (learning_instance_targets, Stage 4C/4E)
// says which Programmes/Modules a run serves *at all*; this adds which of
// those targets apply to *each specific academic period* (Phase 4's
// learning_instance_academic_periods) — deliberately NOT assumed to be
// "all of them" or "whatever the first period has". Each period starts
// with zero configured targets (see setAcademicStructure, Phase 4) and an
// admin must explicitly assign targets to every period that needs them,
// per this task's "do not assume later periods automatically inherit the
// first period's targets" rule.
//
// This is a pure association (join) table — it does NOT duplicate
// target identity (programme_id/module_id/target_type all still live
// only on learning_instance_targets); a period-target row only ever
// references an EXISTING learning_instance_targets row belonging to the
// same Learning Instance (enforced in application code, see
// utils/learningInstances.js's setPeriodTargets).
// ============================================================
db.exec(`
CREATE TABLE IF NOT EXISTS learning_instance_period_targets (
  id                              TEXT PRIMARY KEY,
  learning_instance_academic_period_id TEXT NOT NULL REFERENCES learning_instance_academic_periods(id) ON DELETE CASCADE,
  learning_instance_target_id     TEXT NOT NULL REFERENCES learning_instance_targets(id) ON DELETE CASCADE,
  created_at                      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(learning_instance_academic_period_id, learning_instance_target_id)
);
CREATE INDEX IF NOT EXISTS idx_li_period_targets_period ON learning_instance_period_targets(learning_instance_academic_period_id);
CREATE INDEX IF NOT EXISTS idx_li_period_targets_target ON learning_instance_period_targets(learning_instance_target_id);
`);
console.log("✅ Period-specific target configuration ready (learning_instance_period_targets).");

// ============================================================
// v27 — Phase 6: Period-specific payment requirements and enforcement.
// Each learning_instance_academic_periods row (Phase 4) may now declare a
// payment requirement that gates access to that period's content:
//   payment_mode        'full' | 'deposit' | NULL (NULL = no requirement
//                        configured for this period — access is never
//                        blocked on payment grounds for it, which is what
//                        keeps every existing/historical period, and every
//                        Learning Instance with no academic structure at
//                        all, working exactly as before this ships).
//   required_amount_ghs the GHS amount that must be paid (via the existing
//                        payments table, not a parallel system) before
//                        access is granted for this period — the FULL fee
//                        when mode = 'full', or just the deposit/
//                        installment when mode = 'deposit'. One field
//                        covers both: enforcement only ever needs "has at
//                        least this much been paid toward this period",
//                        and `payment_mode` exists purely to label that
//                        amount's meaning for the admin/learner UI (Phase
//                        7/10), not to change the comparison itself.
//
// payments.learning_instance_academic_period_id is the additive, nullable
// FK this task asked us to choose explicitly rather than repurposing
// term_id (the existing global Academic Term calendar column) or
// overloading learning_instance_id alone (which already exists and means
// "which run", not "which period of that run"). NULL on every historical
// payment row — no guessed period is ever assigned to old records, per the
// migration/back-compat rules this task was given under. A payment scoped
// to a period is auditable/distinguishable from a run's other, non-period
// payments (registration, additional-programme enrolment, etc.) by this
// column alone; no new payment type or table was introduced.
// ============================================================
tryAlter("ALTER TABLE learning_instance_academic_periods ADD COLUMN payment_mode TEXT CHECK (payment_mode IN ('full','deposit'))");
tryAlter("ALTER TABLE learning_instance_academic_periods ADD COLUMN required_amount_ghs REAL");
tryAlter("ALTER TABLE payments ADD COLUMN learning_instance_academic_period_id TEXT REFERENCES learning_instance_academic_periods(id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_payments_period ON payments(learning_instance_academic_period_id)");
console.log("✅ Period-specific payment requirements ready (learning_instance_academic_periods.payment_mode/required_amount_ghs, payments.learning_instance_academic_period_id).");

// ============================================================
// v28 — Phase 9: Period-scoped transcripts and certificates.
//
// issued_certificates.learning_instance_academic_period_id is an additive,
// nullable FK to learning_instance_academic_periods (same pattern as
// payments.learning_instance_academic_period_id from Phase 6 above) — NULL
// on every existing/historical certificate row (no guessed period is ever
// backfilled, per this task's back-compat rules) and only ever populated
// going forward when a certificate is issued for a period-aware Learning
// Instance run. This is what lets a later period's certificate for the
// same learner+module exist ALONGSIDE an earlier period's certificate
// instead of colliding with/overwriting it — see the /issue route's
// idempotency check in routes/certificates.js, which now includes this
// column as part of a certificate's identity.
//
// Transcript scoping itself (routes/grades.js, utils/transcriptEngine.js)
// needs no schema change: every assessment-record table involved already
// carries both learning_instance_id (Phase v11/v13/v14 above) and term_id
// (v5/pre-existing Academic Term columns), and an academic period optionally
// links to a school-wide academic_term via
// learning_instance_academic_periods.academic_term_id (Phase 4 above). A
// period-scoped transcript request resolves its term through that existing
// link and additionally filters every underlying query by
// learning_instance_id, rather than introducing a parallel/duplicate
// period-id column on every grades/progress/attempt table.
// ============================================================
tryAlter("ALTER TABLE issued_certificates ADD COLUMN learning_instance_academic_period_id TEXT REFERENCES learning_instance_academic_periods(id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_issued_certs_period ON issued_certificates(learning_instance_academic_period_id)");
console.log("✅ Period-scoped certificates ready (issued_certificates.learning_instance_academic_period_id).");

// ============================================================
// v29 — Builders' Lab architecture rationalization.
//
// Adds the Course layer between Programme and Module (Programme -> Course
// -> Module -> Lesson, per spec), a per-Class(level) curriculum mapping so
// one Course can present a different Module set at Foundation vs Framework
// vs Skyline, an explicit "participation structure" on enrolments/runs so
// the three Builders' Lab participation models (structured school-club
// journey / structured journey via another delivery arrangement /
// individual course) are queryable instead of only implied, and adds
// HYBRID to the existing ON_CAMPUS/ONLINE delivery-mode vocabulary
// (app-level only — classes.delivery_mode has never had a DB CHECK
// constraint, see routes/classes.js's DELIVERY_MODES array, so no schema
// change is needed for that part).
//
// Every piece here is purely additive:
//  - `course_groups` is a brand new table; nothing existing references it yet.
//  - `courses.course_group_id` is a new nullable column. Every existing
//    Course keeps course_group_id = NULL ("ungrouped/legacy", exactly like
//    every other nullable column this file has ever added) until an admin
//    explicitly assigns it to a Course Group — no Course is auto-assigned/
//    guessed into a Course Group by this migration, per the "don't
//    silently reinterpret historical records" rule this task is under.
//    Courses ungrouped under a Course Group keep working exactly as
//    before everywhere (Learning Instances/targets, enrolments, payments,
//    assessments, grades, transcripts, certificates, instructor
//    assignment all key off course_id directly, never course_group_id) —
//    Course Group is an organisational layer for curriculum/admin
//    purposes, not a new identity Courses must have to function.
//  - `course_group_courses` is a brand new join table with zero existing
//    readers.
//  - `programme_enrollments.participation_structure` and
//    `learning_instances.participation_structure` are new nullable
//    columns. Every existing row keeps NULL ("unspecified/legacy",
//    consistent with how academic_structure was introduced in v25) —
//    nothing is backfilled/guessed, since a historical row's original
//    participation model can't be reliably reconstructed and this task
//    explicitly forbids reinterpreting history.
// ============================================================

// (Course Group upgrade-path rename now lives at the very top of this
// file, run before the Module->Course rename below it — see there for why.)

// ARCHITECTURE NOTE (ABRS v2.1 §6, Appendix A-4/A-8 lineage): course_groups
// is an OPTIONAL curriculum-organization convenience sitting above Course —
// it is NOT a reintroduction of the retired Module layer (ABRS v2.1 §6:
// "The Module layer is permanently retired ... no future work may
// reintroduce a Module concept between Course and Lesson, under any
// name"). No operational workflow (enrolment, payment, assessment, grade,
// transcript, certificate, instructor assignment) may ever be made to
// require a Course to belong to a course_group — every one of those
// workflows keys off course_id directly today and must continue to do so.
// If a future change makes course_group_id non-nullable anywhere, or makes
// any operational query join through course_groups instead of courses,
// that change reintroduces a mandatory intermediate layer and is a
// constitutional violation requiring review before it ships.
db.exec(`
CREATE TABLE IF NOT EXISTS course_groups (
  id           TEXT PRIMARY KEY,
  programme_id TEXT NOT NULL REFERENCES programmes(id),
  name         TEXT NOT NULL,
  description  TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_course_groups_programme ON course_groups(programme_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_course_groups_programme_name ON course_groups(programme_id, name);
`);

tryAlter("ALTER TABLE courses ADD COLUMN course_group_id TEXT REFERENCES course_groups(id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_courses_course_group ON courses(course_group_id)");

// Maps which Module(s) of a Course Group apply at a given Class/level — e.g.
// "Robotics Engineering" (a Course Group) has Module A/B at Foundation,
// Module C/D at Framework, Module E/F at Skyline. A Module not listed here
// for any Class is simply not level-scoped (keeps applying everywhere its
// existing Learning-Instance/enrolment relationships already say it does)
// — this table only ever ADDS a level-scoping rule, it never restricts
// access on its own; access enforcement (routes/modules.js "/open" et al.)
// treats "no rows for this Course Group+Class" as "no extra restriction",
// the same back-compat posture every other additive table in this file
// takes.
db.exec(`
CREATE TABLE IF NOT EXISTS course_group_courses (
  id              TEXT PRIMARY KEY,
  course_group_id TEXT NOT NULL REFERENCES course_groups(id) ON DELETE CASCADE,
  class_id        TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  course_id       TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(course_group_id, class_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_cgc_group ON course_group_courses(course_group_id);
CREATE INDEX IF NOT EXISTS idx_cgc_class ON course_group_courses(class_id);
CREATE INDEX IF NOT EXISTS idx_cgc_course ON course_group_courses(course_id);
`);
{
  // Defensive rename-in-place for any database that already ran an earlier
  // version of this table with the pre-rename module_id column name.
  const cgcCols = db.prepare("PRAGMA table_info(course_group_courses)").all().map((c) => c.name);
  if (cgcCols.includes("module_id") && !cgcCols.includes("course_id")) {
    db.exec("ALTER TABLE course_group_courses RENAME COLUMN module_id TO course_id");
  }
}

// Participation structure — the three Builders' Lab models from the spec:
//   'structured_school_club' — Foundation -> Framework -> Skyline journey
//                               delivered through a School Club arrangement.
//   'structured_other'       — the same structured journey delivered another
//                               way (online / on-campus / hybrid, outside a
//                               School Club).
//   'individual_course'      — enrolled in one Course/Module only, for a
//                               defined Learning Instance/period, not the
//                               full structured journey.
// Stored on BOTH programme_enrollments (which structure this specific
// learner's journey-style enrolment is) and learning_instances (which
// structure(s) this run is configured/intended for, set by an admin) so
// registration can filter "active Learning Instances appropriate to that
// structure" per the spec, and Admin/Instructor views can see a learner's
// participation structure directly off their enrolment row.
//
// ARCHITECTURE NOTE (ABRS v2.1 Section 10, Appendix A-1 -- CRITICAL, known
// gap): Participation Structures are constitutionally defined as business
// configuration OWNED BY THE PROGRAMME (never by the Learning Offering
// Type, never by the Run) -- see ABRS v2.1 Section 10.1 for why. This
// fixed TEXT CHECK enum is a known, catalogued gap against that: adding a
// Participation Structure for a future Programme (Adult Professional,
// Corporate Training, Bootcamp) currently requires a schema migration and
// a code change here, instead of being a pure admin/config action. ABRS
// v2.1 Roadmap Phase 2 replaces this enum with a Programme-scoped
// configuration table WITHOUT turning Participation Structures into a new
// standalone entity type -- they remain Programme-owned configuration
// either way; only the storage shape changes. Do not add a fourth enum
// value here as a shortcut for a new Programme's needs -- that perpetuates
// exactly the gap this note flags.
tryAlter(
  "ALTER TABLE programme_enrollments ADD COLUMN participation_structure TEXT CHECK (participation_structure IN ('structured_school_club','structured_other','individual_course'))"
);
tryAlter(
  "ALTER TABLE learning_instances ADD COLUMN participation_structure TEXT CHECK (participation_structure IN ('structured_school_club','structured_other','individual_course'))"
);
db.exec("CREATE INDEX IF NOT EXISTS idx_programme_enrollments_participation_structure ON programme_enrollments(participation_structure)");
db.exec("CREATE INDEX IF NOT EXISTS idx_learning_instances_participation_structure ON learning_instances(participation_structure)");

// v30 — Enrollment Activation pipeline. Registration previously granted
// Module access (an `enrollments` row) immediately at account creation,
// before any payment/access decision was made — so an abandoned or
// never-paid registration still had live curriculum access. Registration
// should only ever express intent to enrol; curriculum access must be
// granted at Enrollment Activation (a successful payment via
// utils/paymentActivation.js, or an admin-granted Hub access override),
// reusing the exact Course/Class curriculum mechanism promotion already
// uses (utils/learningInstances.js's syncCourseCurriculumForClass).
//
// This column is that deferred intent: the raw module ids a learner
// picked at registration time (Kids STEM's module-selection step), stored
// on their primary programme_enrollments row instead of written straight
// to `enrollments`. NULL/empty for every pre-existing row and every
// non-Kids-STEM registration (nothing selected at registration for those)
// — a no-op, so nothing about an already-active learner's existing
// `enrollments` rows changes.
tryAlter("ALTER TABLE programme_enrollments ADD COLUMN requested_course_ids TEXT");

console.log("✅ Builders' Lab architecture ready (course_groups, courses.course_group_id, course_group_courses, participation_structure on programme_enrollments/learning_instances).");

// ============================================================
// v31 — Programme Run (learning_instances) becomes the single operational
// source of truth for Delivery Modes, Campuses, Fee configuration,
// Installments, Capacity and Instructor Assignment. Previously these lived
// on `classes` (Delivery Mode/Campus/Fee — see the v?? "Bootcamp extension"
// and HYBRID comments above) with no equivalent on the Programme Run at
// all. Per the architecture spec, operational configuration belongs to the
// Run; Classes (Foundation/Framework/Skyline, Weekday/Weekend, etc.) become
// purely academic-progression/identity entities going forward.
//
// This is additive-only and fully backward compatible:
//   - Every new column is nullable. NULL = "this Run hasn't configured its
//     own operational settings yet" — every existing Learning Instance in
//     every existing installation keeps behaving exactly as it does today,
//     because every resolver below only consults these columns *after*
//     checking for a Class-level value first (see utils/learningInstances.js
//     getInstanceOperationalConfig() / resolveClassOperationalConfig(), and
//     utils/fees.js's updated resolution chain).
//   - `classes.delivery_mode` / `classes.campus_id` / `classes.fee_ghs` are
//     NOT removed or renamed. They remain valid, meaningful per-Class
//     *overrides* — this is what still lets a Bootcamp's Weekday batch and
//     Weekend batch carry genuinely different fees/campuses under the same
//     Programme Run (a real, already-shipped capability this migration must
//     not break) — but they are no longer the primary place an admin
//     configures operational settings, and no longer the primary place
//     registration/enrolment/fee code reads them from. New code should
//     prefer the Programme Run's configuration; a Class-level value is now
//     a deliberate per-batch override layered on top of it, not the source
//     of truth itself.
//
// delivery_modes / campus_ids are stored as JSON arrays (a Run can be
// configured for more than one Delivery Mode / Campus — e.g. a Bootcamp
// Programme Run offered both On-Campus and Online, with two eligible
// campuses); NULL means "not yet configured at the Run level", the
// unaffected legacy state.
tryAlter("ALTER TABLE learning_instances ADD COLUMN delivery_modes TEXT"); // JSON array, e.g. '["ON_CAMPUS","ONLINE"]'
tryAlter("ALTER TABLE learning_instances ADD COLUMN campus_ids TEXT"); // JSON array of campuses.id, only meaningful for ON_CAMPUS/HYBRID
tryAlter("ALTER TABLE learning_instances ADD COLUMN fee_ghs INTEGER"); // Run-level default/base fee; NULL falls through to the existing chain
tryAlter("ALTER TABLE learning_instances ADD COLUMN installments_enabled INTEGER"); // tri-state: NULL = inherit from Offering Type settings, 0/1 = explicit Run override
tryAlter("ALTER TABLE learning_instances ADD COLUMN capacity INTEGER"); // max learners for this Run; NULL = uncapped (unchanged behaviour)
tryAlter("ALTER TABLE learning_instances ADD COLUMN instructor_id TEXT REFERENCES users(id)"); // the Run's assigned lead instructor
db.exec("CREATE INDEX IF NOT EXISTS idx_learning_instances_instructor ON learning_instances(instructor_id)");

// Enrollment must now persist enough operational context that future
// reporting never has to re-derive it from configuration that may have
// since changed (per spec: "every enrollment must know... Delivery Mode,
// Campus, Academic Structure, Academic Period, Course"). All four are
// nullable and populated best-effort at enrolment time (registration,
// POST /api/enrolments) from whatever was actually resolved for that
// learner then — never backfilled/guessed for historical rows, the same
// posture every other new nullable column in this file takes.
tryAlter("ALTER TABLE programme_enrollments ADD COLUMN delivery_mode TEXT");
tryAlter("ALTER TABLE programme_enrollments ADD COLUMN campus_id TEXT REFERENCES campuses(id)");
tryAlter("ALTER TABLE programme_enrollments ADD COLUMN academic_period_id TEXT REFERENCES learning_instance_academic_periods(id)");
tryAlter("ALTER TABLE programme_enrollments ADD COLUMN course_group_id TEXT REFERENCES course_groups(id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_programme_enrollments_campus ON programme_enrollments(campus_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_programme_enrollments_academic_period ON programme_enrollments(academic_period_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_programme_enrollments_course_group ON programme_enrollments(course_group_id)");

console.log("✅ Programme Run operational ownership ready (learning_instances.delivery_modes/campus_ids/fee_ghs/installments_enabled/capacity/instructor_id; programme_enrollments operational snapshot columns).");

// ============================================================
// v32 — Registration Window ownership moves to the Programme Run
// (learning_instances), completing the v31 Programme Run operational
// ownership migration for the one remaining piece called out in that
// migration's own header comment: registration opening/closing dates.
//
// This is additive-only and fully backward compatible, same posture as
// v31:
//   - Every new column is nullable (registration_opens_at/
//     registration_deadline) or defaults to 0 (registration_force_closed/
//     registration_force_open) — NULL/0 means "this Run hasn't configured
//     its own registration window yet", so every existing Learning
//     Instance in every existing installation is unaffected until an
//     admin explicitly sets one.
//   - `programmes.registration_opens_at` / `registration_deadline` /
//     `registration_force_closed` / `registration_force_open` /
//     `ends_at` are NOT removed, renamed, or stopped being written to.
//     They remain exactly as they are today and now serve purely as a
//     TEMPORARY FALLBACK for any Programme whose active Run hasn't been
//     given its own registration window yet — see
//     utils/learningInstances.js's resolveProgrammeRegistrationOpen(),
//     which is now the single resolver every registration validation
//     path (routes/auth.js, routes/enrolments.js,
//     routes/learningOfferings.js) calls instead of reaching for
//     utils/offeringTypeSettings.js's isProgrammeRegistrationOpen()
//     directly. isProgrammeRegistrationOpen() itself is untouched and
//     still used internally as exactly that fallback.
//   - Different Programme Runs of the same Programme (e.g. a completed
//     Jan cohort and an upcoming Jul cohort) can therefore carry genuinely
//     independent registration periods — resolveProgrammeRegistrationOpen()
//     always resolves through the Programme's current ACTIVE run, never a
//     historical one, matching the same "single Active run" rule the rest
//     of this architecture already enforces.
tryAlter("ALTER TABLE learning_instances ADD COLUMN registration_opens_at TEXT"); // ISO date; NULL = not configured at Run level yet (falls through to Programme fallback)
tryAlter("ALTER TABLE learning_instances ADD COLUMN registration_deadline TEXT"); // ISO date; NULL = not configured at Run level yet
tryAlter("ALTER TABLE learning_instances ADD COLUMN registration_force_closed INTEGER NOT NULL DEFAULT 0"); // admin manual close at the Run level, overrides dates
tryAlter("ALTER TABLE learning_instances ADD COLUMN registration_force_open INTEGER NOT NULL DEFAULT 0");   // admin manual reopen/extend at the Run level, overrides dates and force-closed

console.log("✅ Registration Window columns added to the Programme Run (learning_instances.registration_opens_at/registration_deadline/registration_force_closed/registration_force_open). NOTE: programmes.registration_* columns were retained here only as a temporary fallback at the time — see this file's later 'Registration Window ownership consolidation' migration, which backfills and permanently removes them.");

// ============================================================
// v33 — ABRS v2.1 Phase 1 audit, Category 1 fix (see
// server/docs/HARDCODED_IDENTIFIER_AUDIT.md): closes the five duplicated
// `slug === "kids_stem"` overrides (offeringTypeSettings.js,
// routes/enrolments.js, routes/learningOfferings.js, routes/users.js,
// client/src/pages/auth/RegisterPage.jsx) by giving both business rules
// they encoded a real configuration home —
// enrollment.legacyAlwaysSelfRegistrable and
// academicStructure.legacyRequiresCourseSelectionAtRegistration — instead
// of a literal identifier comparison baked into control flow (ABRS §2.2).
//
// The `behaviourBySlug.kids_stem` seed above (v9) already sets both flags
// `true` for brand-new databases. This block is the matching backfill for
// any pre-existing installation whose kids_stem row already has a
// `settings` JSON blob from before these two flags existed — same
// idempotent, additive, "never guess for other rows" posture as the
// usesModules backfill above.
// ============================================================
{
  const row = db.prepare("SELECT id, settings FROM learning_offering_types WHERE slug = 'kids_stem'").get();
  if (row) {
    let settings;
    try {
      settings = JSON.parse(row.settings || "{}");
    } catch (e) {
      settings = {};
    }
    const alreadyCorrect =
      settings.enrollment && settings.enrollment.legacyAlwaysSelfRegistrable === true &&
      settings.academicStructure && settings.academicStructure.legacyRequiresCourseSelectionAtRegistration === true;
    if (!alreadyCorrect) {
      settings.enrollment = { ...(settings.enrollment || {}), legacyAlwaysSelfRegistrable: true };
      settings.academicStructure = { ...(settings.academicStructure || {}), legacyRequiresCourseSelectionAtRegistration: true };
      db.prepare("UPDATE learning_offering_types SET settings = ? WHERE id = ?").run(JSON.stringify(settings), row.id);
      console.log("✅ Backfilled legacyAlwaysSelfRegistrable/legacyRequiresCourseSelectionAtRegistration = true onto the pre-existing Kids STEM Learning Offering Type (ABRS v2.1 Phase 1 audit, Category 1).");
    }
  }
}

// ============================================================
// v34 — ABRS v2.1 Roadmap Phase 2: Participation Structures become
// Programme-owned CONFIGURATION DATA instead of a fixed, code-level enum.
// Closes Appendix Item A-1 (CRITICAL).
//
// Per ABRS v2.1 §10 / §19 Phase 2, this is a database-only, additive-first
// migration. It does NOT change Participation Structures into a new
// standalone entity type — they remain business configuration owned by the
// Programme (§10.1) — only their *storage shape* changes, from a hardcoded
// `TEXT CHECK (... IN (...))` enum on programme_enrollments/
// learning_instances to structured, admin-editable rows a Programme owns.
//
// Two new tables, both purely additive:
//
//   1. `programme_participation_structures` — the Programme-owned
//      definition. One row per Participation Structure a Programme has
//      defined for itself (e.g. Builders' Lab's three: Structured School
//      Club, Structured Online Journey, Individual Course — §10.2). Adding
//      a fourth, for this or any future Programme, becomes an INSERT, not a
//      schema migration or a code change — closing the exact gap A-1
//      describes.
//
//   2. `learning_instance_participation_structures` — the join recording
//      which of a Programme's defined Participation Structures a given
//      Programme Run (learning_instances) has ACTIVATED for that delivery
//      (§10.1: "Programme Runs activate Participation Structures but never
//      define them"). This is deliberately a separate table from #1, not a
//      column on learning_instances, because a Run may activate more than
//      one Participation Structure at once (§10.1's example: "a full-year
//      Run might activate all three").
//
// Structural enforcement of §10.1's activation-not-definition rule: a
// trigger rejects any row in the join table whose participation structure
// does not belong to the same Programme as the Learning Instance it's
// being activated on — so it is impossible, at the database layer, for a
// Run to activate a Participation Structure belonging to a different
// Programme. This is the "enforced structurally" requirement called out in
// §19 Phase 2's Affected Entities list, and follows the same "enforce
// business rules at the database layer wherever possible" precedent
// Appendix A-5 already establishes as the reference example.
//
// Legacy enum columns (programme_enrollments.participation_structure,
// learning_instances.participation_structure — added in v29) are NOT
// altered, renamed, or dropped in this phase, per §19 Phase 2's explicit
// instruction ("Legacy enum columns become nullable, backfilled once, then
// deprecated — never dropped in this phase"). They were already nullable
// as of v29, so no column change is needed here; this migration only adds
// the doc-comment marking them deprecated-in-favour-of (below) and
// performs the one-time backfill into the new tables.
//
// Backend impact: NONE in this phase, by design (§19 Phase 2: "new tables
// are additive and unread by existing routes"). routes/auth.js,
// routes/enrolments.js, routes/learningInstances.js,
// routes/learningOfferings.js, and utils/learningInstances.js's
// PARTICIPATION_STRUCTURES/isValidParticipationStructure continue reading
// and writing the legacy enum columns exactly as before — cutting them
// over to read the new tables is Phase 3 (§19), not this phase.
// ============================================================
db.exec(`
CREATE TABLE IF NOT EXISTS programme_participation_structures (
  id                          TEXT PRIMARY KEY,
  programme_id                TEXT NOT NULL REFERENCES programmes(id),
  key                         TEXT NOT NULL, -- stable machine key; equals the legacy enum value where this row backfills one (structured_school_club / structured_other / individual_course), a fresh admin-chosen slug for any Participation Structure defined after this migration
  name                        TEXT NOT NULL, -- admin-editable display name, e.g. "Structured School Club"
  uses_programme_levels       INTEGER NOT NULL DEFAULT 0, -- §10.2 "Uses Programme Levels"
  uses_promotion              INTEGER NOT NULL DEFAULT 0, -- §10.2 "Uses Promotion"
  requires_course_selection   INTEGER NOT NULL DEFAULT 0, -- §10.2 "Course Selection"
  registrant_role             TEXT,   -- §10.2 "Registrant": who registers whom for this Participation Structure, e.g. 'parent' | 'self' | 'parent_or_self'
  uses_long_term_enrollment   INTEGER NOT NULL DEFAULT 0, -- §10.2: "Structured School Club additionally: uses long-term enrollment..."
  auto_assigns_entry_level    INTEGER NOT NULL DEFAULT 0, -- §10.2: "...and automatically assigns the configured Entry Level"
  is_active                   INTEGER NOT NULL DEFAULT 1, -- whether the Programme currently offers this Participation Structure at all (distinct from any one Run's activation of it, below)
  sort_order                  INTEGER NOT NULL DEFAULT 0,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(programme_id, key)
);
CREATE INDEX IF NOT EXISTS idx_pps_programme ON programme_participation_structures(programme_id);

-- Which of a Programme Run's own Programme's defined Participation
-- Structures that Run has activated (§10.1). Never a place to redefine or
-- alter a Participation Structure's behaviour — see the trigger below,
-- which enforces the same-Programme rule structurally.
CREATE TABLE IF NOT EXISTS learning_instance_participation_structures (
  id                          TEXT PRIMARY KEY,
  learning_instance_id        TEXT NOT NULL REFERENCES learning_instances(id) ON DELETE CASCADE,
  participation_structure_id  TEXT NOT NULL REFERENCES programme_participation_structures(id) ON DELETE CASCADE,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(learning_instance_id, participation_structure_id)
);
CREATE INDEX IF NOT EXISTS idx_lips_instance ON learning_instance_participation_structures(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_lips_structure ON learning_instance_participation_structures(participation_structure_id);

-- Structural enforcement (§10.1 / §19 Phase 2): a Run may only activate a
-- Participation Structure that belongs to that Run's own Programme.
CREATE TRIGGER IF NOT EXISTS trg_lips_same_programme_insert
BEFORE INSERT ON learning_instance_participation_structures
FOR EACH ROW
BEGIN
  SELECT CASE WHEN (
    (SELECT li.programme_id FROM learning_instances li WHERE li.id = NEW.learning_instance_id)
    IS NOT (SELECT pps.programme_id FROM programme_participation_structures pps WHERE pps.id = NEW.participation_structure_id)
  ) THEN RAISE(ABORT, 'learning_instance_participation_structures: participation structure must belong to the same Programme as the Learning Instance (ABRS v2.1 Section 10.1)')
  END;
END;
CREATE TRIGGER IF NOT EXISTS trg_lips_same_programme_update
BEFORE UPDATE OF learning_instance_id, participation_structure_id ON learning_instance_participation_structures
FOR EACH ROW
BEGIN
  SELECT CASE WHEN (
    (SELECT li.programme_id FROM learning_instances li WHERE li.id = NEW.learning_instance_id)
    IS NOT (SELECT pps.programme_id FROM programme_participation_structures pps WHERE pps.id = NEW.participation_structure_id)
  ) THEN RAISE(ABORT, 'learning_instance_participation_structures: participation structure must belong to the same Programme as the Learning Instance (ABRS v2.1 Section 10.1)')
  END;
END;
`);

console.log("✅ Participation Structures configuration tables ready (programme_participation_structures, learning_instance_participation_structures; ABRS v2.1 Phase 2, Appendix A-1).");

// v34 backfill — one configuration row per (Programme, legacy enum value)
// pair actually found in existing data, per §19 Phase 2's own verification
// checklist wording ("backfill produces exactly one configuration row per
// current enum value per Programme that uses it"). Nothing is guessed for
// a Programme that has never used a given value: only combinations that
// actually appear in programme_enrollments.participation_structure or
// learning_instances.participation_structure are backfilled — the same
// "never reinterpret/invent history" posture v29's own comment states for
// this column.
//
// The three possible keys are closed (the legacy CHECK constraint has only
// ever allowed these three — see v29 above), so their name/behaviour
// metadata is the one place this migration hardcodes business meaning; it
// is sourced directly from §10.2's table and is metadata for a *backfill*,
// not a runtime business-logic branch — Phase 3 is what cuts business
// logic over to read this table instead of the enum (§2.2 remains
// satisfied because no `if (participationStructure === "...")` is being
// added anywhere in application code by this migration).
{
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

  const pairs = db
    .prepare(
      `SELECT DISTINCT programme_id, participation_structure AS key FROM programme_enrollments
       WHERE programme_id IS NOT NULL AND participation_structure IS NOT NULL
       UNION
       SELECT DISTINCT programme_id, participation_structure AS key FROM learning_instances
       WHERE programme_id IS NOT NULL AND participation_structure IS NOT NULL`
    )
    .all();

  const insertPPS = db.prepare(
    `INSERT OR IGNORE INTO programme_participation_structures
       (id, programme_id, key, name, uses_programme_levels, uses_promotion, requires_course_selection, registrant_role, uses_long_term_enrollment, auto_assigns_entry_level, sort_order)
     VALUES (@id, @programmeId, @key, @name, @usesProgrammeLevels, @usesPromotion, @requiresCourseSelection, @registrantRole, @usesLongTermEnrollment, @autoAssignsEntryLevel, @sortOrder)`
  );
  const findPPS = db.prepare(
    `SELECT id FROM programme_participation_structures WHERE programme_id = ? AND key = ?`
  );

  let seededConfigCount = 0;
  for (const pair of pairs) {
    const meta = PARTICIPATION_STRUCTURE_METADATA[pair.key];
    if (!meta) continue; // defensive: legacy CHECK constraint guarantees this never happens today
    const existing = findPPS.get(pair.programme_id, pair.key);
    if (existing) continue;
    insertPPS.run({
      id: uuid(),
      programmeId: pair.programme_id,
      key: pair.key,
      name: meta.name,
      usesProgrammeLevels: meta.usesProgrammeLevels ? 1 : 0,
      usesPromotion: meta.usesPromotion ? 1 : 0,
      requiresCourseSelection: meta.requiresCourseSelection ? 1 : 0,
      registrantRole: meta.registrantRole,
      usesLongTermEnrollment: meta.usesLongTermEnrollment ? 1 : 0,
      autoAssignsEntryLevel: meta.autoAssignsEntryLevel ? 1 : 0,
      sortOrder: meta.sortOrder,
    });
    seededConfigCount += 1;
  }

  // Activation backfill: every pre-existing learning_instances row that
  // already names a participation_structure was, in effect, already
  // "activating" exactly that one structure (there was no way to express
  // more than one under the old enum column) — so the join row it implies
  // is backfilled 1:1, never guessed beyond what the legacy column already
  // recorded.
  const runsWithLegacyStructure = db
    .prepare(
      `SELECT id, programme_id, participation_structure AS key FROM learning_instances
       WHERE programme_id IS NOT NULL AND participation_structure IS NOT NULL`
    )
    .all();
  const insertActivation = db.prepare(
    `INSERT OR IGNORE INTO learning_instance_participation_structures (id, learning_instance_id, participation_structure_id) VALUES (?, ?, ?)`
  );
  let seededActivationCount = 0;
  for (const run of runsWithLegacyStructure) {
    const pps = findPPS.get(run.programme_id, run.key);
    if (!pps) continue; // defensive: the config backfill above always runs first and covers every pair this query can produce
    const result = insertActivation.run(uuid(), run.id, pps.id);
    if (result.changes > 0) seededActivationCount += 1;
  }

  if (seededConfigCount > 0 || seededActivationCount > 0) {
    console.log(
      `✅ Backfilled ${seededConfigCount} programme_participation_structures row(s) and ${seededActivationCount} learning_instance_participation_structures activation row(s) from legacy participation_structure enum data (ABRS v2.1 Phase 2).`
    );
  } else {
    console.log("✅ Participation Structures Phase 2 backfill: no legacy participation_structure data found yet — nothing to backfill (fresh database, or no registrations/Runs have set it yet).");
  }
}

// ============================================================
// v35 — ABRS v2.1 Roadmap Phase 3 (Checkpoint 3a — database + dual-write
// only; read-path cutover is Checkpoint 3b, not included here — see
// server/docs/PHASE3_ACTIVATED_COURSES_CHECKPOINT_3A_REPORT.md).
//
// Closes Appendix Item A-2 (HIGH) and A-4 (MEDIUM):
//
//   - A-2: today, "which Courses does this Programme Run offer" is
//     inferred from a combination of loosely related tables
//     (learning_instance_targets for the Run<->Course link,
//     instructor_courses for who teaches it — globally, not per-Run,
//     course_group_courses for level-scoping) rather than one table
//     matching §8's definition and §9's lifecycle states. This migration
//     adds that one table: `learning_instance_courses` (the Activated
//     Course, per §8 — "the association between a Programme Run and a
//     Course, plus run-specific operational configuration, nothing
//     more").
//   - A-4: an Individual Course participant's selected Courses are
//     currently stored as a JSON array on
//     programme_enrollments.requested_course_ids, not a joinable
//     association. This migration adds `programme_enrollment_courses`, a
//     normalized join, for queryability (reporting, per-course capacity,
//     per-course instructor visibility — A-4's own stated reasons).
//
// Per §19 Phase 3's own Database Impact wording ("migration of existing
// course-to-run association data into it where a clean mapping exists,
// with legacy sources retained, not dropped"):
//   - `learning_instance_courses` is backfilled from
//     `learning_instance_targets` rows that already name a `course_id` —
//     every existing Run<->Course link recorded there (primary or
//     secondary target) is a clean, unambiguous mapping, since that table
//     is already the single existing source of truth for "which
//     Courses/Programmes does this Run target."
//   - `programme_enrollment_courses` is backfilled by parsing every
//     pre-existing `programme_enrollments.requested_course_ids` JSON
//     array — again a clean 1:1 mapping of what a learner already
//     recorded choosing.
//   - Per-course instructor assignment (`instructor_courses` — global,
//     not Run-scoped) is deliberately NOT backfilled onto
//     `learning_instance_courses.instructor_id` here: unlike the two
//     mappings above, that would require this migration to make an
//     inference (which Run "owns" a given global instructor assignment)
//     that the source data doesn't actually record — the exact kind of
//     guessing this codebase's migrations consistently avoid. `instructor_id`
//     stays NULL for every backfilled row; assigning it is an explicit
//     admin action going forward (Checkpoint 3b).
//   - Neither `learning_instance_targets`, `instructor_courses`, nor
//     `programme_enrollments.requested_course_ids` is altered, renamed,
//     or stopped being written to. All three remain exactly as they are
//     today and are still what every existing route reads.
//
// Backend impact of this migration file alone: NONE — both tables start
// empty of application-written rows until the dual-write hooks in
// routes/learningInstances.js, utils/learningInstances.js, routes/auth.js
// (checkpoint 3a) start populating them going forward; see this
// checkpoint's implementation report for exactly which write paths were
// (and weren't) wired up, and why.
// ============================================================
db.exec(`
CREATE TABLE IF NOT EXISTS learning_instance_courses (
  id                                   TEXT PRIMARY KEY,
  learning_instance_id                 TEXT NOT NULL REFERENCES learning_instances(id) ON DELETE CASCADE,
  course_id                            TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status                               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')), -- §9 Active/Inactive axis. Hidden is layered on top (below); Compulsory/Optional is its own axis (below); Archived is derived from the parent learning_instances.status, never stored here (§9: "tied to the parent Programme Run").
  is_hidden                            INTEGER NOT NULL DEFAULT 0, -- §9 Hidden: Active-and-Hidden is valid; Inactive-and-Hidden is not observably different from plain Inactive (§9), so this flag is only meaningful when status='active'
  is_compulsory                        INTEGER NOT NULL DEFAULT 0, -- §9 Compulsory/Optional axis
  sort_order                           INTEGER NOT NULL DEFAULT 0, -- §8 "Display order"
  instructor_id                        TEXT REFERENCES users(id), -- §8 "Instructor assignment" — Run-scoped, distinct from the global instructor_courses table; NULL = not yet assigned at the Run level (falls back to instructor_courses' global assignment everywhere that still reads it)
  visible_class_ids                    TEXT, -- §8 "Programme Level visibility" — JSON array of classes.id; NULL = visible at every Programme Level (unchanged/unrestricted), same "NULL = not configured yet" convention as learning_instances.delivery_modes/campus_ids (v31)
  visible_participation_structure_ids  TEXT, -- §8 "Participation Structure visibility" — JSON array of programme_participation_structures.id; NULL = visible under every Participation Structure this Run has activated
  created_at                           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(learning_instance_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_lic_instance ON learning_instance_courses(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_lic_course ON learning_instance_courses(course_id);
CREATE INDEX IF NOT EXISTS idx_lic_instructor ON learning_instance_courses(instructor_id);

-- A-4: normalized Individual Course selection. One row per Course a
-- learner selected for their Individual Course enrolment, replacing the
-- JSON array (programme_enrollments.requested_course_ids stays, unread by
-- nothing new is required to keep reading it — see migration note above).
CREATE TABLE IF NOT EXISTS programme_enrollment_courses (
  id                          TEXT PRIMARY KEY,
  programme_enrollment_id     TEXT NOT NULL REFERENCES programme_enrollments(id) ON DELETE CASCADE,
  course_id                   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  learning_instance_course_id TEXT REFERENCES learning_instance_courses(id), -- best-effort link to the Activated Course this selection resolves against; NULL when the enrolment's Run hasn't activated that Course as a row yet (legacy data, or a Run predating Checkpoint 3a's dual-write)
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(programme_enrollment_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_pec_enrollment ON programme_enrollment_courses(programme_enrollment_id);
CREATE INDEX IF NOT EXISTS idx_pec_course ON programme_enrollment_courses(course_id);
`);

console.log("✅ Activated Courses tables ready (learning_instance_courses, programme_enrollment_courses; ABRS v2.1 Phase 3 Checkpoint 3a, Appendix A-2/A-4).");

// v35 backfill
{
  const legacyTargetsWithCourse = db
    .prepare("SELECT learning_instance_id, course_id FROM learning_instance_targets WHERE course_id IS NOT NULL")
    .all();
  const insertLIC = db.prepare(
    "INSERT OR IGNORE INTO learning_instance_courses (id, learning_instance_id, course_id) VALUES (?, ?, ?)"
  );
  let seededLIC = 0;
  for (const row of legacyTargetsWithCourse) {
    const result = insertLIC.run(uuid(), row.learning_instance_id, row.course_id);
    if (result.changes > 0) seededLIC += 1;
  }

  const legacyEnrollmentsWithCourses = db
    .prepare(
      "SELECT id, learning_instance_id, requested_course_ids FROM programme_enrollments WHERE requested_course_ids IS NOT NULL"
    )
    .all();
  const insertPEC = db.prepare(
    "INSERT OR IGNORE INTO programme_enrollment_courses (id, programme_enrollment_id, course_id, learning_instance_course_id) VALUES (?, ?, ?, ?)"
  );
  const findLIC = db.prepare(
    "SELECT id FROM learning_instance_courses WHERE learning_instance_id = ? AND course_id = ?"
  );
  let seededPEC = 0;
  for (const enrollment of legacyEnrollmentsWithCourses) {
    let courseIds;
    try {
      courseIds = JSON.parse(enrollment.requested_course_ids || "[]");
    } catch (e) {
      courseIds = [];
    }
    if (!Array.isArray(courseIds)) continue;
    for (const courseId of courseIds) {
      if (!courseId) continue;
      const lic = enrollment.learning_instance_id ? findLIC.get(enrollment.learning_instance_id, courseId) : null;
      const result = insertPEC.run(uuid(), enrollment.id, courseId, lic ? lic.id : null);
      if (result.changes > 0) seededPEC += 1;
    }
  }

  if (seededLIC > 0 || seededPEC > 0) {
    console.log(
      `✅ Backfilled ${seededLIC} learning_instance_courses row(s) from learning_instance_targets and ${seededPEC} programme_enrollment_courses row(s) from requested_course_ids JSON (ABRS v2.1 Phase 3 Checkpoint 3a).`
    );
  } else {
    console.log("✅ Activated Courses Phase 3 backfill: no legacy course-to-run or course-selection data found yet — nothing to backfill.");
  }
}

// ============================================================
// v36 — ABRS v2.1 Phase 4 (Frontend Implementation): closes the two
// remaining items from HARDCODED_IDENTIFIER_AUDIT.md the earlier Category
// 1 fix explicitly deferred (both LOW severity there, but in scope now
// that Phase 4's own objective is exactly "replace any remaining
// hardcoded-identifier assumptions in the registration and admin UI"):
//
//   - Category 2 (publicUtils.js): Corporate Training's Enrol-button
//     routing was a `slug === "corporate_training"` check. Fixed not by
//     adding a new flag but by backfilling this ONE offering type's
//     already-existing, already-generic `enrolDestination` field (every
//     offering type has always had this — see
//     offeringTypeSettings.js/OfferingTypeLandingPanel.jsx) with its
//     sensible default value. The `behaviourBySlug.corporate_training`
//     addition above only covers a brand-new database; this block
//     idempotently backfills the same value onto a pre-existing Corporate
//     Training row whose settings predate it, same pattern as every prior
//     settings backfill in this file (v33's is the closest precedent).
//   - Category 3 (AccountDetailDrawer.jsx): Participation Structure
//     display/edit labels were three `value === "..."` string comparisons.
//     Phase 2 already created the config table
//     (programme_participation_structures) this should read from instead,
//     but Phase 2's own backfill was deliberately conservative — it only
//     creates a config row for a (Programme, key) pair that already
//     appears in real enrolment/Run data, so a Programme that has simply
//     never yet had every one of its Participation Structures used even
//     once could be missing a row the admin UI still needs to offer as a
//     selectable option. This block ensures every Programme under the
//     kids_stem Learning Offering Type — the only type §10.2 defines
//     Participation Structures for today — has all three canonical rows,
//     regardless of which ones its own historical data happened to use.
//     (A brand-new Programme created after this migration under kids_stem,
//     or any future offering type that adopts Participation Structures,
//     won't get rows from this one-time backfill — there is still no admin
//     UI to define a Programme's own Participation Structures from
//     scratch; that remains a known follow-up, same gap noted in the
//     Phase 3 Checkpoint 3b report re: Activated Course admin tooling.)
// ============================================================
{
  // --- Category 2 backfill ---
  const corporateTrainingType = db.prepare("SELECT id, settings FROM learning_offering_types WHERE slug = 'corporate_training'").get();
  if (corporateTrainingType) {
    let settings;
    try {
      settings = JSON.parse(corporateTrainingType.settings || "{}");
    } catch (e) {
      settings = {};
    }
    const alreadySet = settings.landing && settings.landing.enrolDestination;
    if (!alreadySet) {
      settings.landing = { ...(settings.landing || {}), enrolDestination: "#contact" };
      db.prepare("UPDATE learning_offering_types SET settings = ? WHERE id = ?").run(JSON.stringify(settings), corporateTrainingType.id);
      console.log("✅ Backfilled enrolDestination = '#contact' onto the pre-existing Corporate Training Learning Offering Type (ABRS v2.1 Phase 4 audit, Category 2).");
    }
  }

  // --- Category 3 backfill ---
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
  const kidsStemProgrammes = db
    .prepare(
      `SELECT p.id FROM programmes p JOIN learning_offering_types t ON t.id = p.offering_type_id WHERE t.slug = 'kids_stem'`
    )
    .all();
  const insertPPS = db.prepare(
    `INSERT OR IGNORE INTO programme_participation_structures
       (id, programme_id, key, name, uses_programme_levels, uses_promotion, requires_course_selection, registrant_role, uses_long_term_enrollment, auto_assigns_entry_level, sort_order)
     VALUES (@id, @programmeId, @key, @name, @usesProgrammeLevels, @usesPromotion, @requiresCourseSelection, @registrantRole, @usesLongTermEnrollment, @autoAssignsEntryLevel, @sortOrder)`
  );
  let seededFullPPS = 0;
  kidsStemProgrammes.forEach((programme) => {
    Object.entries(PARTICIPATION_STRUCTURE_METADATA).forEach(([key, meta]) => {
      const result = insertPPS.run({
        id: uuid(),
        programmeId: programme.id,
        key,
        name: meta.name,
        usesProgrammeLevels: meta.usesProgrammeLevels ? 1 : 0,
        usesPromotion: meta.usesPromotion ? 1 : 0,
        requiresCourseSelection: meta.requiresCourseSelection ? 1 : 0,
        registrantRole: meta.registrantRole,
        usesLongTermEnrollment: meta.usesLongTermEnrollment ? 1 : 0,
        autoAssignsEntryLevel: meta.autoAssignsEntryLevel ? 1 : 0,
        sortOrder: meta.sortOrder,
      });
      if (result.changes > 0) seededFullPPS += 1;
    });
  });
  if (seededFullPPS > 0) {
    console.log(`✅ Backfilled ${seededFullPPS} additional programme_participation_structures row(s) so every kids_stem Programme has all three canonical Participation Structures available, regardless of historical usage (ABRS v2.1 Phase 4 audit, Category 3).`);
  } else {
    console.log("✅ Phase 4 Category 3 backfill: every kids_stem Programme already has all three canonical Participation Structures configured — nothing to backfill.");
  }
}

// ============================================================
// v37 — Admin Workflow Redesign checkpoint (Programme Definition +
// Participation Structure Administration): the missing admin CRUD
// surface for programme_participation_structures (§10, Appendix A-1)
// noted as a gap in the Phase 4 backfill comment above and in
// ADMIN_WORKFLOW_REDESIGN_CHECKPOINT1_REPORT.md now exists (see
// routes/learningOfferings.js). It needs one additive column this
// migration adds: `retired_at`, distinct from the existing `is_active`.
// Deactivate (is_active=0) is reversible — an admin can reactivate a
// Participation Structure they turned off by mistake or are pausing.
// Retire is not: it is a terminal state for a Participation Structure a
// Programme no longer offers going forward (its `key` stays taken —
// this table never deletes rows, matching every other soft-delete
// pattern in this codebase — and it can no longer be edited or
// reactivated once retired_at is set). NULL = never retired, the state
// of every row created before this migration and every row created by
// the earlier Phase 2/4 dual-write/backfill helpers.
// ============================================================
tryAlter("ALTER TABLE programme_participation_structures ADD COLUMN retired_at TEXT");
console.log("✅ programme_participation_structures.retired_at ready (ABRS v2.1 Admin Workflow Redesign checkpoint — Participation Structure Administration).");

// ============================================================
// v38 — Promotion Subsystem (ABRS v2.1 Section 12).
//
// Promotion is a distinct domain from Enrollment, Registration, and
// Academic Period progression (§12). This migration adds ONLY what §12
// requires: a Programme-owned, admin-configurable Promotion Policy
// (never a hardcoded threshold, per §2.2), a place to capture an
// instructor's promotion recommendation for a learner, and two nullable
// columns on the existing promotion_log table for audit traceability
// (which policy was evaluated at decision time; which prior log entry a
// reversal undoes). Nothing here touches courses, enrollments, or
// learning_instance_courses — per this checkpoint's explicit scope,
// Promotion never mutates a Course record, never introduces a
// learner-specific Course lifecycle state, and never archives a Course.
// "Newly eligible Courses become visible / previous-level Courses stop
// being current" is entirely a READ-TIME consequence of
// learning_instance_courses.visible_class_ids (§8, already implemented)
// evaluated against the learner's own users.class_id after Promotion
// changes it — no new Course-facing table or column is introduced here.
// ============================================================

// One Promotion Policy per Programme (§12: "the configured Promotion
// Policy of their Programme" — Programme-owned, same ownership pattern
// as Participation Structures in v33/v34). All threshold fields are
// nullable: NULL means "this criterion is not evaluated," never "0" or
// any other silently-inferred default — same "NULL = not configured yet,
// never guessed" convention used everywhere else in this file (§17.1).
// A Programme with no policy row at all is read as "no configured
// Promotion Policy" — every learner in it is eligibility-neutral (never
// blocked by a criterion nobody configured), so existing Programmes are
// completely unaffected until an admin explicitly opts one in.
db.exec(`
CREATE TABLE IF NOT EXISTS promotion_policies (
  id                              TEXT PRIMARY KEY,
  programme_id                    TEXT NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
  min_average_score                REAL,    -- 0-100, evaluated against transcriptEngine.moduleResult().total across the learner's current-level courses; NULL = not evaluated
  min_attendance_percent           REAL,    -- 0-100, evaluated against the attendance table for the same course set; NULL = not evaluated
  requires_instructor_recommendation INTEGER NOT NULL DEFAULT 0, -- if 1, a positive promotion_recommendations row is required
  is_active                        INTEGER NOT NULL DEFAULT 1,
  created_at                       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(programme_id)
);
CREATE INDEX IF NOT EXISTS idx_promotion_policies_programme ON promotion_policies(programme_id);

-- An instructor's recommendation for whether a specific learner should be
-- promoted out of their CURRENT class (Programme Level). Scoped to
-- (learner, class) rather than learner alone, so a stale recommendation
-- from a previous level never silently satisfies this checkpoint's policy
-- for a later one. Multiple rows may accumulate (an instructor can update
-- their mind); the eligibility engine always reads the most recent one.
CREATE TABLE IF NOT EXISTS promotion_recommendations (
  id            TEXT PRIMARY KEY,
  learner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id      TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  instructor_id TEXT NOT NULL REFERENCES users(id),
  recommends    INTEGER NOT NULL, -- 1 = recommends promotion, 0 = does not
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_promotion_recommendations_learner_class ON promotion_recommendations(learner_id, class_id);
`);

// promotion_log gains two nullable, additive columns:
//   policy_snapshot  — JSON of the exact criteria evaluated (or null if no
//                       policy was configured / this was an unconditional
//                       manual override) at the moment of the decision, so
//                       the audit trail is self-contained even if the
//                       Promotion Policy is edited later.
//   reversed_log_id  — self-reference: when a 'reversal' row undoes an
//                       earlier promotion, this points at the row it
//                       undoes. NULL for every non-reversal action.
tryAlter("ALTER TABLE promotion_log ADD COLUMN policy_snapshot TEXT");
tryAlter("ALTER TABLE promotion_log ADD COLUMN reversed_log_id TEXT REFERENCES promotion_log(id)");

console.log("✅ Promotion Subsystem tables ready (promotion_policies, promotion_recommendations; promotion_log.policy_snapshot/reversed_log_id — ABRS v2.1 Section 12).");

// ============================================================
// v39 — Operational Groups (ABRS v2.2 §11; resolves Appendix Item A-9).
//
// Names the second, non-progression purpose the `classes` table has been
// read for since v17/v31 (Delivery Mode, Campus, Fee overrides — see
// those migrations' comments) and gives it its own table, its own owner
// (Programme Run / learning_instances, per §8.2 and §19), and its own
// nullable-override field list, scoped EXACTLY to what §11.3
// constitutionally permits AND what the Programme Run itself already
// owns ("An Operational Group may not override, define, or introduce a
// field the Programme Run does not itself already own").
//
// §11.3 names twelve potentially-overridable fields. Cross-checked
// against §8.2/learning_instances' actual current ownership
// (delivery_modes, campus_ids, fee_ghs, capacity, instructor_id,
// registration_deadline — v31/v32), only six have a Run-owned field to
// override today: Tuition Fee -> fee_ghs, Capacity -> capacity (also
// serves "Maximum Enrollment" — one Run-level capacity concept, not two;
// a second, textually-different but practically-identical column would
// itself be duplicated ownership, which §2.1 forbids), Instructor ->
// instructor_id, Delivery Mode -> delivery_mode (single value, must be
// one of the Run's own delivery_modes), Campus -> campus_id (single
// value, must be one of the Run's own campus_ids), Closing Date
// (optional) -> registration_deadline. Venue, Schedule, Meeting Days,
// Meeting Times and Waitlist Capacity are NOT added as columns here,
// because the Programme Run does not yet own any of those five concepts
// anywhere in this codebase — adding them at the Operational Group level
// first would be introducing a new business concept via the child rather
// than the parent, which is a proposed constitutional amendment (§2.3),
// not something this migration is authorized to do.
//
// legacy_class_id is a nullable, backfill-only bookkeeping column (not a
// constitutional field) recording which pre-migration `classes` row this
// Operational Group's overrides were consolidated from.
// ============================================================
db.exec(`
CREATE TABLE IF NOT EXISTS operational_groups (
  id                TEXT PRIMARY KEY,
  learning_instance_id TEXT NOT NULL REFERENCES learning_instances(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  display_label     TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  fee_ghs           INTEGER,
  capacity          INTEGER,
  instructor_id     TEXT REFERENCES users(id),
  delivery_mode     TEXT,
  campus_id         TEXT REFERENCES campuses(id),
  registration_deadline TEXT,
  legacy_class_id   TEXT REFERENCES classes(id),
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_operational_groups_instance ON operational_groups(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_operational_groups_instructor ON operational_groups(instructor_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_groups_instance_name ON operational_groups(learning_instance_id, name);
`);

tryAlter("ALTER TABLE programme_enrollments ADD COLUMN operational_group_id TEXT REFERENCES operational_groups(id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_programme_enrollments_operational_group ON programme_enrollments(operational_group_id)");

// --- Backfill --------------------------------------------------------
{
  const overriddenClasses = db
    .prepare(
      `SELECT id, name, display_label, sort_order, programme_id, delivery_mode, campus_id, fee_ghs
       FROM classes
       WHERE programme_id IS NOT NULL
         AND (delivery_mode IS NOT NULL OR campus_id IS NOT NULL OR fee_ghs IS NOT NULL)`
    )
    .all();

  const insertGroup = db.prepare(
    `INSERT INTO operational_groups
       (id, learning_instance_id, name, display_label, sort_order, fee_ghs, instructor_id, delivery_mode, campus_id, legacy_class_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const findExisting = db.prepare(`SELECT id FROM operational_groups WHERE legacy_class_id = ? AND learning_instance_id = ?`);
  const backfillEnrollments = db.prepare(
    `UPDATE programme_enrollments SET operational_group_id = ?
     WHERE class_id = ? AND learning_instance_id = ? AND operational_group_id IS NULL`
  );

  overriddenClasses.forEach((cls) => {
    const activeInstance = db
      .prepare(
        `SELECT li.id FROM learning_instances li
         JOIN learning_instance_targets lit ON lit.learning_instance_id = li.id
         WHERE lit.programme_id = ? AND li.status = 'active'`
      )
      .get(cls.programme_id);
    if (!activeInstance) return;

    const already = findExisting.get(cls.id, activeInstance.id);
    const groupId = already ? already.id : uuid();
    const instructorRows = db.prepare("SELECT instructor_id FROM instructor_classes WHERE class_id = ?").all(cls.id);
    const instructorId = instructorRows.length === 1 ? instructorRows[0].instructor_id : null;

    if (!already) {
      insertGroup.run(
        groupId,
        activeInstance.id,
        cls.display_label || cls.name,
        cls.display_label,
        cls.sort_order || 0,
        cls.fee_ghs,
        instructorId,
        cls.delivery_mode,
        cls.campus_id,
        cls.id
      );
    }
    backfillEnrollments.run(groupId, cls.id, activeInstance.id);
  });

  console.log(`✅ Operational Groups ready (operational_groups table; programme_enrollments.operational_group_id; ${overriddenClasses.length} legacy Class-level override(s) inspected for backfill — ABRS v2.2 §11 / Appendix A-9).`);
}

// ============================================================
// v40 — Registration Window ownership consolidation (ABRS v2.2 §2.1/§8.2/
// §16 compliance remediation). Completes what v31/v32 started: those
// migrations moved Registration Window *reads* to prefer the Programme
// Run, but kept `programmes.registration_opens_at` / `registration_deadline`
// / `registration_force_closed` / `registration_force_open` alive as a
// "TEMPORARY FALLBACK" (v32's own words) for a Programme whose active Run
// hadn't been given its own window yet. That fallback was always meant to
// be temporary — the constitution names the Programme Run the sole owner
// of Registration Configuration (§8.2), and a second, competing set of
// columns on `programmes` is exactly the Single Ownership Principle
// violation §2.1 forbids ("if you can imagine two different admin
// screens... each having a legitimate reason to write the same fact").
//
// This migration is idempotent and safe to run on both fresh installs
// (where the four columns above were never created — see the "Bootcamp
// extension" block earlier in this file) and existing installs that still
// have them:
//
//   1. Backfill: for every Programme whose active Run has NOT yet
//      configured its own registration window (all four Run-level fields
//      still at their unconfigured default), and whose legacy Programme-
//      level columns hold real data, copy that data onto the Run. This is
//      the one-time migration the task's "preserve existing data" /
//      "migrate the existing Programme configuration once" requirement
//      calls for — after this, the Run is self-sufficient and no
//      inheritance from the Programme is needed or consulted anywhere in
//      the codebase (see utils/learningInstances.js
//      resolveProgrammeRegistrationOpen(), which no longer even looks at
//      the Programme's columns).
//   2. Drop the four Programme-level columns entirely — eliminating the
//      second owner at the schema level, not just in application code, so
//      no future code path can silently reintroduce the fallback by
//      querying `programmes` directly.
//
// Guarded by an explicit column-existence check (PRAGMA table_info)
// rather than tryAlter's "swallow duplicate column" trick, since
// DROP COLUMN's failure mode on a column that's already gone is "no such
// column", not "duplicate column" — a different error tryAlter wouldn't
// catch.
{
  const programmeCols = db.prepare("PRAGMA table_info(programmes)").all().map((c) => c.name);
  const legacyRegistrationCols = ["registration_opens_at", "registration_deadline", "registration_force_closed", "registration_force_open"];
  const hasLegacyColumns = legacyRegistrationCols.some((c) => programmeCols.includes(c));

  if (hasLegacyColumns) {
    const backfillCandidates = db
      .prepare(
        `SELECT id, registration_opens_at, registration_deadline, registration_force_closed, registration_force_open
         FROM programmes
         WHERE registration_opens_at IS NOT NULL
            OR registration_deadline IS NOT NULL
            OR registration_force_closed = 1
            OR registration_force_open = 1`
      )
      .all();

    const findActiveRun = db.prepare(
      `SELECT li.* FROM learning_instances li
       JOIN learning_instance_targets lit ON lit.learning_instance_id = li.id
       WHERE lit.programme_id = ? AND li.status = 'active'`
    );
    const backfillRun = db.prepare(
      `UPDATE learning_instances
       SET registration_opens_at = ?, registration_deadline = ?, registration_force_closed = ?, registration_force_open = ?, updated_at = datetime('now')
       WHERE id = ?`
    );

    let backfilled = 0;
    backfillCandidates.forEach((programme) => {
      const activeRun = findActiveRun.get(programme.id);
      if (!activeRun) return; // no Run to inherit onto — the legacy data has nothing left to govern
      const runAlreadyConfigured = !!(
        activeRun.registration_opens_at ||
        activeRun.registration_deadline ||
        activeRun.registration_force_closed ||
        activeRun.registration_force_open
      );
      if (runAlreadyConfigured) return; // Run already owns its own window — never overwrite it with legacy data
      backfillRun.run(
        programme.registration_opens_at,
        programme.registration_deadline,
        programme.registration_force_closed,
        programme.registration_force_open,
        activeRun.id
      );
      backfilled += 1;
    });

    legacyRegistrationCols.forEach((col) => {
      if (programmeCols.includes(col)) {
        db.exec(`ALTER TABLE programmes DROP COLUMN ${col}`);
      }
    });

    console.log(`✅ Registration Window ownership consolidated onto the Programme Run (${backfilled} Programme(s) backfilled onto their active Run; programmes.registration_opens_at/registration_deadline/registration_force_closed/registration_force_open dropped — ABRS v2.2 §2.1/§8.2/§16).`);
  }
}

require("./migratePricing")(db, tryAlter);

// ============================================================
// Instructor Assignment consolidation — ABRS v2.2 §2.1 (Single Ownership),
// §8.2 ("The Programme Run owns... instructor assignment"), §9 (Activated
// Course "may define... Instructor assignment"), §13 (Programme Levels).
//
// Before this migration, "who may an instructor see/teach" had FOUR
// separate, independently-writable owners: the global `instructor_classes`
// table (instructor <-> Programme Level, unscoped to any Run),
// the global `instructor_courses` table (instructor <-> Course, unscoped
// to any Run), `learning_instances.instructor_id` (one lead instructor per
// Run), and `learning_instance_courses.instructor_id` (one instructor per
// Activated Course, Run-scoped but never wired to any authorization
// check — see syncActivatedCourseInstructor's own comment). Four owners
// for one fact is exactly the Single Ownership violation §2.1 defines.
//
// This migration introduces ONE table, `instructor_assignments`, as the
// sole, constitutional owner of instructor assignment going forward. Each
// row grants one instructor access to one Programme Run
// (learning_instance_id, always required — instructor assignment is a
// Programme Run-owned concept per §8.2), optionally narrowed to one
// Course, one Programme Level (`classes`, per §13/the `classes` table
// comment), and/or one Campus. A NULL on any of those three optional
// columns means "every value of that dimension within this Run" — the
// same "NULL = unrestricted, resolved at read time" convention already
// established for learning_instance_courses.visible_class_ids and
// learning_instances.delivery_modes/campus_ids. An administrator achieves
// "any combination of Learning Instances/Courses/Programme
// Levels/Campuses" by creating one row per combination they want to grant
// — full configurability without a second schema shape.
//
// `instructor_classes` and `instructor_courses` — the two legacy tables
// that were themselves the previous, non-Run-scoped "instructor
// assignment mechanism" (the literal subject of this remediation) — are
// backfilled into instructor_assignments below and then dropped, so no
// parallel assignment path survives this migration. `learning_instances.
// instructor_id`, `learning_instance_courses.instructor_id` and
// `operational_groups.instructor_id` are separate, narrower features
// (a Run's own "lead instructor" display field, and an Activated
// Course's/Operational Group's own optional override field respectively —
// §9, §11.3) that remain as configuration surfaces in their own right;
// this migration mirrors any value already set on them into
// instructor_assignments too (so existing access is never silently
// revoked), but from this point on every authorization check reads
// instructor_assignments exclusively — those columns are never consulted
// for access control again.
{
  const hasInstructorAssignments = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instructor_assignments'")
    .get();

  if (!hasInstructorAssignments) {
    db.exec(`
CREATE TABLE instructor_assignments (
  id                    TEXT PRIMARY KEY,
  instructor_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  learning_instance_id  TEXT NOT NULL REFERENCES learning_instances(id) ON DELETE CASCADE,
  course_id             TEXT REFERENCES courses(id) ON DELETE CASCADE,   -- NULL = every Course activated in this Run
  class_id              TEXT REFERENCES classes(id) ON DELETE CASCADE,   -- Programme Level; NULL = every Programme Level
  campus_id             TEXT REFERENCES campuses(id) ON DELETE CASCADE,  -- NULL = every Campus
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_instructor_assignments_instructor ON instructor_assignments(instructor_id);
CREATE INDEX idx_instructor_assignments_instance ON instructor_assignments(learning_instance_id);
CREATE INDEX idx_instructor_assignments_course ON instructor_assignments(course_id);
CREATE INDEX idx_instructor_assignments_class ON instructor_assignments(class_id);
CREATE INDEX idx_instructor_assignments_campus ON instructor_assignments(campus_id);
-- Prevents an admin creating the exact same grant twice. SQLite treats
-- NULL != NULL, so this only blocks true duplicates, not distinct
-- wildcard rows for the same instructor/Run (which is correct — the
-- admin may still be in the middle of adding several narrower rows).
CREATE UNIQUE INDEX idx_instructor_assignments_unique ON instructor_assignments(
  instructor_id, learning_instance_id,
  COALESCE(course_id, ''), COALESCE(class_id, ''), COALESCE(campus_id, '')
);
`);

    const insertAssignment = db.prepare(
      `INSERT OR IGNORE INTO instructor_assignments (id, instructor_id, learning_instance_id, course_id, class_id, campus_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    let backfilled = 0;

    // 1. Legacy instructor_classes (instructor <-> Programme Level, global)
    //    -> one row per Run belonging to that Programme Level's Programme,
    //    since a Programme Level itself carries no Run of its own.
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instructor_classes'").get()) {
      const rows = db.prepare("SELECT ic.instructor_id, ic.class_id, cl.programme_id FROM instructor_classes ic JOIN classes cl ON cl.id = ic.class_id").all();
      const findRunsForProgramme = db.prepare("SELECT id FROM learning_instances WHERE programme_id = ?");
      rows.forEach((r) => {
        if (!r.programme_id) return;
        findRunsForProgramme.all(r.programme_id).forEach((run) => {
          insertAssignment.run(uuid(), r.instructor_id, run.id, null, r.class_id, null);
          backfilled += 1;
        });
      });
    }

    // 2. Legacy instructor_courses (instructor <-> Course, global) -> one
    //    row per Run that either IS a run of that Course directly, or
    //    belongs to the Programme that owns that Course in its Course
    //    Library.
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instructor_courses'").get()) {
      const rows = db.prepare("SELECT im.instructor_id, im.course_id, c.programme_id FROM instructor_courses im LEFT JOIN courses c ON c.id = im.course_id").all();
      const findRunsForCourse = db.prepare("SELECT id FROM learning_instances WHERE course_id = ? OR programme_id = ?");
      rows.forEach((r) => {
        findRunsForCourse.all(r.course_id, r.programme_id || "").forEach((run) => {
          insertAssignment.run(uuid(), r.instructor_id, run.id, r.course_id, null, null);
          backfilled += 1;
        });
      });
    }

    // 3. learning_instances.instructor_id (Run's own "lead instructor")
    //    -> full-Run access.
    if (db.prepare("PRAGMA table_info(learning_instances)").all().some((c) => c.name === "instructor_id")) {
      db.prepare("SELECT id, instructor_id FROM learning_instances WHERE instructor_id IS NOT NULL").all().forEach((r) => {
        insertAssignment.run(uuid(), r.instructor_id, r.id, null, null, null);
        backfilled += 1;
      });
    }

    // 4. learning_instance_courses.instructor_id (Activated Course's own
    //    instructor) -> Run + Course scoped access.
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_instance_courses'").get()) {
      db.prepare("SELECT learning_instance_id, course_id, instructor_id FROM learning_instance_courses WHERE instructor_id IS NOT NULL").all().forEach((r) => {
        insertAssignment.run(uuid(), r.instructor_id, r.learning_instance_id, r.course_id, null, null);
        backfilled += 1;
      });
    }

    // 5. operational_groups.instructor_id (Operational Group's own
    //    instructor override) -> Run + Programme Level (legacy_class_id) +
    //    Campus scoped access.
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operational_groups'").get()) {
      db.prepare("SELECT learning_instance_id, legacy_class_id, campus_id, instructor_id FROM operational_groups WHERE instructor_id IS NOT NULL").all().forEach((r) => {
        insertAssignment.run(uuid(), r.instructor_id, r.learning_instance_id, null, r.legacy_class_id, r.campus_id);
        backfilled += 1;
      });
    }

    // Drop the two legacy tables outright — they were the previous
    // "instructor assignment mechanism" itself (unscoped to any Run),
    // now fully superseded and no longer read by any authorization check.
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instructor_classes'").get()) {
      db.exec("DROP TABLE instructor_classes");
    }
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instructor_courses'").get()) {
      db.exec("DROP TABLE instructor_courses");
    }

    console.log(`✅ Instructor Assignment consolidated onto instructor_assignments (${backfilled} row(s) backfilled; legacy instructor_classes/instructor_courses dropped — ABRS v2.2 §2.1/§8.2/§9/§13).`);
  }
}

// ============================================================
// Sponsor Bulk Registration (ABRS v2.2 Implementation — Sponsor Accounts /
// Bulk Registration / Single Ownership Principle §2.1).
//
// One table owns the lifecycle of a coordinator's bulk-upload batch, end
// to end: uploaded-template validation results, the registration preview
// (categorisation + Pricing-Engine-computed total), and the commit/audit
// result. This is deliberately a single owner for "what happened with
// this batch" rather than three separate tables that could each drift —
// see §2.1.
//
// Idempotency (Part 5 of the remediation brief): UNIQUE(sponsor_id,
// file_hash) means re-uploading the exact same completed template for the
// same sponsor resolves to the SAME batch row rather than creating a
// second one — committing an already-committed batch is a no-op that
// returns the original commit result (see utils/sponsorBulkRegistration.js
// commitBatch()), so a re-upload/retry can never double-create learner
// accounts, registrations, enrollments, sponsorship associations, or
// payments.
db.exec(`
CREATE TABLE IF NOT EXISTS sponsor_bulk_batches (
  id                    TEXT PRIMARY KEY,
  sponsor_id            TEXT NOT NULL REFERENCES sponsors(id),
  coordinator_id        TEXT NOT NULL REFERENCES users(id),
  learning_instance_id  TEXT NOT NULL REFERENCES learning_instances(id),
  file_name             TEXT,
  file_hash             TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'validated', -- validated | committed
  row_count             INTEGER NOT NULL DEFAULT 0,
  validation_json       TEXT,   -- Part 2: per-row validation failures + report
  preview_json          TEXT,   -- Part 3: learner categorisation + Pricing Engine total
  commit_result_json     TEXT,  -- Part 7: audit trail of what the commit actually did
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  committed_at          TEXT
);
`);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sponsor_bulk_batches_sponsor_hash ON sponsor_bulk_batches(sponsor_id, file_hash)");
db.exec("CREATE INDEX IF NOT EXISTS idx_sponsor_bulk_batches_sponsor ON sponsor_bulk_batches(sponsor_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_sponsor_bulk_batches_coordinator ON sponsor_bulk_batches(coordinator_id)");
console.log("✅ Sponsor Bulk Registration ready (sponsor_bulk_batches table).");

// ============================================================
// Campus name consistency backfill — repairs users.campus values that
// drifted from the canonical campuses.name (casing/whitespace differences
// from earlier unvalidated writes, e.g. sponsor bulk-registration before
// utils/campusResolution.js existed). Safe to re-run: only rewrites rows
// whose normalized campus text matches a real campus under a different
// spelling; leaves anything with no match untouched and logs it. See
// Section 3 of the constitution (free-text-vs-FK is a data-integrity
// defect) and utils/campusResolution.js for the resolution logic itself.
// ============================================================
{
  const { backfillCampusNameConsistency } = require("../utils/campusResolution");
  backfillCampusNameConsistency();
  console.log("✅ Campus name consistency backfill complete (users.campus normalized against campuses.name).");
}

// ============================================================
// ABRS v2.2 amendment — concurrent Programme Runs. Explicitly DROP the
// four partial UNIQUE indexes that used to enforce "only one Active
// Learning Instance per Programme/Course system-wide". Removing their
// CREATE UNIQUE INDEX IF NOT EXISTS statements above (see the two notes
// left in their place) only stops *new* databases from getting them —
// any database migrated under an earlier version of this schema already
// has them on disk and SQLite won't drop a UNIQUE index just because the
// script that created it changed, so this step is required for existing
// installs to actually gain the ability to run two Active Runs of the
// same Programme/Course concurrently. Safe to re-run (DROP INDEX IF
// EXISTS is a no-op once already dropped).
db.exec("DROP INDEX IF EXISTS idx_learning_instances_one_active_per_programme");
db.exec("DROP INDEX IF EXISTS idx_learning_instances_one_active_per_course");
db.exec("DROP INDEX IF EXISTS idx_lit_one_active_per_programme");
db.exec("DROP INDEX IF EXISTS idx_lit_one_active_per_course");
console.log("✅ Concurrent Programme Runs enabled (dropped legacy one-Active-Run-per-Programme/Course backstop indexes).");

// ============================================================
// Combined Registration + First Period Payment — per-Run admin choice.
// Default (0/false) is byte-for-byte today's behaviour: a Registration
// Fee payment (learning_instances.registration_fee_ghs) activates the
// account, and each academic period's own payment requirement
// (learning_instance_academic_periods.required_amount_ghs) is settled
// separately and later, exactly as before.
//
// When an admin sets this to 1/true on a Run that has an academic
// structure (semester/term) configured, self-registration into that Run
// charges ONLY the current/first academic period's own required amount
// (no separate Registration Fee charge at all) — that one payment both
// completes registration (see utils/paymentActivation.js's
// recoverRegistrationIfNeverCompleted, which this reuses rather than
// duplicating) and satisfies that period's payment requirement, so
// content access is unrestricted immediately. A Run with no academic
// structure, or whose current period has no payment requirement
// configured yet, is completely unaffected regardless of this flag —
// same "nothing configured yet = nothing changes" rule every other
// period-payment feature in this codebase already follows.
tryAlter("ALTER TABLE learning_instances ADD COLUMN combine_registration_with_first_period INTEGER NOT NULL DEFAULT 0");
console.log("✅ Combined Registration + First Period Payment column added (learning_instances.combine_registration_with_first_period).");

// ============================================================
// Instructor-portal filter consistency pass — Continuous Assessment had
// no class_id at all, unlike Notes and Examinations (which both already
// support scoping to one specific class). NULL (the default for every
// existing row) means "applies to every class studying this module",
// same convention as examinations.class_id and notes.class_id.
tryAlter("ALTER TABLE continuous_assessments ADD COLUMN class_id TEXT REFERENCES classes(id)");
console.log("✅ Continuous Assessment Class scoping column added (continuous_assessments.class_id).");

// ============================================================
// Builders' Lab Structured Curriculum Foundation (Phase 1)
// Add academic_period_sequence to course_group_courses.
// Because SQLite does not support altering constraints, we use the
// standard table recreation pattern. Existing rows default to sequence 1.
db.exec(`
CREATE TABLE IF NOT EXISTS course_group_courses_new (
  id                       TEXT PRIMARY KEY,
  course_group_id          TEXT NOT NULL REFERENCES course_groups(id) ON DELETE CASCADE,
  class_id                 TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  course_id                TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  academic_period_sequence INTEGER NOT NULL DEFAULT 1,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(course_group_id, class_id, course_id, academic_period_sequence)
);

INSERT INTO course_group_courses_new (id, course_group_id, class_id, course_id, sort_order, created_at)
SELECT id, course_group_id, class_id, course_id, sort_order, created_at FROM course_group_courses;

DROP TABLE course_group_courses;
ALTER TABLE course_group_courses_new RENAME TO course_group_courses;

CREATE INDEX IF NOT EXISTS idx_cgc_group ON course_group_courses(course_group_id);
CREATE INDEX IF NOT EXISTS idx_cgc_class ON course_group_courses(class_id);
CREATE INDEX IF NOT EXISTS idx_cgc_course ON course_group_courses(course_id);
`);
console.log("✅ Added academic_period_sequence to course_group_courses.");

// ============================================================
// Bootcamp Remediation — payments.operational_group_id column
// Traceability for Bootcamp and Operational Group enrolment payments.
tryAlter("ALTER TABLE payments ADD COLUMN operational_group_id TEXT REFERENCES operational_groups(id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_payments_operational_group ON payments(operational_group_id)");
console.log("✅ Added operational_group_id column and index to payments table.");

// ============================================================
// Bootcamp Remediation — activatedCoursesV2Enabled backfill for Bootcamp.
//
// The `behaviourBySlug.bootcamp` seed above (v9) already sets
// academicStructure.activatedCoursesV2Enabled = true for brand-new
// databases. This is the matching backfill for any pre-existing
// installation whose `bootcamp` Learning Offering Type row already has a
// `settings` JSON blob from before this flag was set — same idempotent,
// additive, "never touch other offering types" posture as the kids_stem
// legacyAlwaysSelfRegistrable backfill above. Builders' Lab and every other
// Offering Type are untouched; they keep DEFAULT_SETTINGS' `false`.
// ============================================================
{
  const row = db.prepare("SELECT id, settings FROM learning_offering_types WHERE slug = 'bootcamp'").get();
  if (row) {
    let settings;
    try {
      settings = JSON.parse(row.settings || "{}");
    } catch (e) {
      settings = {};
    }
    const alreadyCorrect =
      settings.academicStructure && settings.academicStructure.activatedCoursesV2Enabled === true;
    if (!alreadyCorrect) {
      settings.academicStructure = { ...(settings.academicStructure || {}), activatedCoursesV2Enabled: true };
      db.prepare("UPDATE learning_offering_types SET settings = ? WHERE id = ?").run(JSON.stringify(settings), row.id);
      console.log("✅ Backfilled activatedCoursesV2Enabled = true onto the pre-existing Bootcamp Learning Offering Type (Bootcamp Course Library remediation).");
    }
  }
}

// ============================================================
// Combined Registration + First Period Payment — correction backfill.
//
// The original implementation of combine_registration_with_first_period
// had the relationship backwards (it charged the first period's own
// independently-configured amount instead of the Registration Fee, and
// only worked once an admin had separately configured that amount). That
// bug is fixed in code (see utils/learningInstances.js's
// resolveCombinedPeriodCharge and setPeriodPaymentRequirement), but any
// database that had combine already turned ON *and* a first-period
// payment_mode/required_amount_ghs configured under the old, buggy admin
// UI is left holding exactly the invalid state the corrected business
// rule prohibits: two competing definitions of the first period's
// obligation (the Registration Fee, and an independently stored amount).
//
// Per the business rule (§10): when combine is ON, the first period's
// requirement must be *derived* from the Registration Fee, never stored
// independently — so this backfill clears (sets to NULL) the first
// period's own payment_mode/required_amount_ghs wherever combine is ON,
// letting the corrected resolveCombinedPeriodCharge/
// getEffectivePeriodPaymentRequirement logic take over as the single
// source of truth for that period going forward.
//
// Deliberately NOT touched by this backfill:
//   - Any Learning Instance with combine OFF — its first period's own
//     amount remains independently authoritative, exactly as before.
//   - Any period other than the first (sequence 1) — combine only ever
//     governs the first period; a Term 2/Semester 2 amount is untouched
//     regardless of this flag.
//   - Historical payment rows — a learner who already paid under the old
//     (buggy) charge amount keeps that payment exactly as recorded; this
//     backfill only clears the now-invalid independent *requirement*
//     configuration, it never rewrites financial history.
//
// Idempotent: once a first period's payment_mode/required_amount_ghs is
// NULL, the WHERE clause below no longer matches it, so re-running this
// migration is always a safe no-op on an already-corrected database.
{
  const combinedInstances = db
    .prepare("SELECT id FROM learning_instances WHERE combine_registration_with_first_period = 1")
    .all();
  let clearedCount = 0;
  const clearStmt = db.prepare(
    "UPDATE learning_instance_academic_periods SET payment_mode = NULL, required_amount_ghs = NULL WHERE id = ?"
  );
  for (const instance of combinedInstances) {
    const firstPeriod = db
      .prepare(
        `SELECT id, payment_mode, required_amount_ghs FROM learning_instance_academic_periods
         WHERE learning_instance_id = ?
         ORDER BY sequence ASC, created_at ASC
         LIMIT 1`
      )
      .get(instance.id);
    if (firstPeriod && (firstPeriod.payment_mode != null || firstPeriod.required_amount_ghs != null)) {
      clearStmt.run(firstPeriod.id);
      clearedCount += 1;
    }
  }
  if (clearedCount > 0) {
    console.log(
      `✅ Combined Registration + First Period Payment correction backfill: cleared ${clearedCount} first-period payment_mode/required_amount_ghs value(s) that were left independently configured under the old (buggy) combine-ON behavior — that period's requirement is now correctly derived from its Learning Instance's Registration Fee.`
    );
  } else {
    console.log("✅ Combined Registration + First Period Payment correction backfill: nothing to clear (no combine-ON Learning Instance had an independently configured first-period amount).");
  }
}

