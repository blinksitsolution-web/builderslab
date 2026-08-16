-- The Builders' Lab — relational schema (SQLite)
-- Swap to Postgres later if you outgrow SQLite: the queries in src/routes use
-- plain parameterized SQL, so the port mainly means changing db.js's driver.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  role            TEXT NOT NULL CHECK (role IN ('learner','parent','instructor','admin')),
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT,               -- NULL for learner sub-accounts with no independent login
  phone           TEXT,
  phone_network   TEXT,
  country         TEXT,               -- ISO 3166-1 alpha-2 (e.g. 'GH', 'US'); NULL = unknown/predates capture
  town            TEXT,               -- Town/city of residence (free text, distinct from campus/school_name); NULL = unknown/predates capture
  campus          TEXT,
  parent_id       TEXT REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'active',        -- active | pending_payment | suspended
  payment_status  TEXT NOT NULL DEFAULT 'unpaid',         -- current | unpaid
  -- Admin-controlled access override (see utils/accessControl.js): can
  -- bypass payment-related restrictions, but never a 'suspended' status.
  access_override             INTEGER NOT NULL DEFAULT 0,
  access_override_reason      TEXT,
  access_override_expires_at  TEXT,   -- ISO datetime; NULL = never expires
  specialty       TEXT,               -- instructors: which modules they teach
  avatar_path     TEXT,
  joined_date     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS enrollments (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id  TEXT NOT NULL,
  PRIMARY KEY (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS progress (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id         TEXT NOT NULL,
  lesson_id         TEXT NOT NULL,
  watched_seconds   REAL NOT NULL DEFAULT 0,
  quiz_score        INTEGER,           -- percent, null until attempted
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, course_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS unlocks (
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id          TEXT NOT NULL,
  unlocked_lesson_id TEXT NOT NULL,
  PRIMARY KEY (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS grades (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   TEXT NOT NULL,
  midterm     INTEGER,
  end_of_term INTEGER,
  PRIMARY KEY (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  media_type  TEXT,                    -- image | video | none
  file_path   TEXT,                    -- relative path under /uploads
  grade       TEXT,
  mark        REAL,                    -- numeric mark, alongside the letter grade
  feedback    TEXT,
  date        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount         REAL NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'GHS',  -- ISO 4217, 3-letter code. Every payment today is GHS
                                                -- (Ghana Mobile Money is the only charge path that
                                                -- exists); this column just makes that fact explicit
                                                -- data instead of an assumption, so a future non-GHS
                                                -- payment path has somewhere correct to record its
                                                -- currency without any historical-row reinterpretation.
  type           TEXT NOT NULL,        -- registration | monthly
  method         TEXT,
  momo_number    TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',   -- pending | successful | failed
  paystack_ref   TEXT UNIQUE,
  date           TEXT NOT NULL DEFAULT (datetime('now')),
  payment_month  TEXT,             -- e.g. '2026-07'; only meaningful for type='monthly'
  learner_ids    TEXT              -- JSON array; set only for combined multi-ward registration charges
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_name   TEXT NOT NULL,
  to_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject     TEXT,
  body        TEXT NOT NULL,
  is_read     INTEGER NOT NULL DEFAULT 0,
  date        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  course_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  file_path   TEXT,
  posted_by   TEXT NOT NULL,
  target      TEXT NOT NULL DEFAULT 'all',
  date        TEXT NOT NULL DEFAULT (datetime('now')),
  ai_status     TEXT NOT NULL DEFAULT 'pending', -- pending | processing | completed | failed (video_lesson only)
  ai_transcript TEXT,                            -- auto-obtained transcript, if any
  ai_error      TEXT,                            -- user-facing AI processing error message, if any
  ai_error_detail TEXT,                          -- raw underlying provider error (status/body), for troubleshooting
  transcript_version INTEGER NOT NULL DEFAULT 0,  -- bumped each time a new transcript is obtained
  summary_version     INTEGER NOT NULL DEFAULT 0  -- bumped each time the Lesson Summary (body) is edited
);

CREATE TABLE IF NOT EXISTS ai_quiz_cache (
  course_id   TEXT NOT NULL,
  lesson_id   TEXT NOT NULL,
  questions   TEXT NOT NULL,   -- JSON
  source      TEXT NOT NULL DEFAULT 'gemini', -- provider id (e.g. 'groq'/'anthropic'/'ollama'/legacy 'gemini') | 'fallback'
  provider           TEXT,     -- display name of the AI provider used, e.g. 'Groq'
  model               TEXT,    -- model name used
  transcript_version  INTEGER, -- notes.transcript_version at generation time
  summary_version     INTEGER, -- notes.summary_version at generation time
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (course_id, lesson_id)
);

-- ============================================================
-- v2 additions
-- ============================================================

CREATE TABLE IF NOT EXISTS campuses (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  active  INTEGER NOT NULL DEFAULT 1
);

-- Curriculum metadata now lives in the DB (not just data/lessons.js) so the
-- admin can control ordering and which course is "in season" without a
-- code change. `sequence` encodes the required order
-- (Hardware -> Programming -> IoT -> Graphic Design); NULL sequence = elective,
-- can be taken any time. `is_open` = currently accepting new enrolments.
-- (Formerly named `modules`; this is the primary curriculum unit in the
-- Institution -> Learning Offering Type -> Programme -> Programme Level ->
-- Programme Run -> Academic Structure -> Academic Period -> Course ->
-- Lesson hierarchy — Lessons (formerly `course_topics`) attach directly
-- to a Course, with no additional layer beneath it.)
CREATE TABLE IF NOT EXISTS courses (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  blurb     TEXT,
  ages      TEXT,
  weeks     INTEGER,
  sequence  INTEGER,
  is_open   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attendance (
  id            TEXT PRIMARY KEY,
  course_id     TEXT NOT NULL,
  instructor_id TEXT NOT NULL REFERENCES users(id),
  learner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,           -- yyyy-mm-dd, one row per learner per session date
  status        TEXT NOT NULL CHECK (status IN ('present','late','absent')),
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(course_id, learner_id, date)
);

-- Course Topics — monthly topic listing for a Course (distinct from this
-- codebase's separate Lesson concept: data/lessons.js's video-lesson
-- catalogue, tracked via progress/unlocks.lesson_id — that IS this
-- system's "Lesson" node under Course in the academic hierarchy; this
-- table is an additional, unrelated topics/announcements feature that
-- happens to sit alongside it). Table name kept as-is: it already reads
-- correctly ("topics belonging to a course") now that Module = Course.
CREATE TABLE IF NOT EXISTS course_topics (
  id          TEXT PRIMARY KEY,
  course_id   TEXT NOT NULL,
  month_label TEXT NOT NULL,   -- e.g. '2026-07'
  title       TEXT NOT NULL,
  body        TEXT,
  file_path   TEXT,
  posted_by   TEXT NOT NULL,
  date        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_resets (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);

-- Generic key/value store for landing-page content, fee amounts, branding
-- (logo/signature paths), etc. — lets the admin edit the site without a
-- developer. `value` is JSON.
CREATE TABLE IF NOT EXISTS site_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_accounts (
  id             TEXT PRIMARY KEY,
  network        TEXT NOT NULL,     -- MTN | Vodafone | AirtelTigo
  account_number TEXT NOT NULL,
  account_name   TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS success_stories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT,
  quote       TEXT NOT NULL,
  avatar_path TEXT,
  highlighted INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blog_posts (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  cover_path TEXT,
  published  INTEGER NOT NULL DEFAULT 1,
  date       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- v3 additions — Foundation / Framework / Skyline class system,
-- instructor class+module assignment, unique student IDs, adult
-- learners, assignments (distinct from projects), examinations.
-- ============================================================

-- The three fixed cohorts learners progress through. `sort_order` encodes
-- the promotion path (Foundation -> Framework -> Skyline).
--
-- NOTE: `name` is deliberately NOT globally UNIQUE (see the v10 migration in
-- migrate.js, which rebuilds this table on any existing database that still
-- has the old global constraint). Under the Unified Learning Architecture a
-- "Learning Group" name only has to be unique *within its own programme* —
-- a Bootcamp "Weekday" cohort and some other programme's "Weekday" batch (or
-- two programmes each with a class literally named "Foundation") must be
-- able to coexist as completely independent rows, since Learning Offering
-- Type/Programme is the primary identifying context, never the name alone.
-- The real uniqueness rule (per-programme) is enforced by
-- idx_classes_programme_name below, once `programme_id` exists.
--
-- ARCHITECTURE NOTE (ABRS v2.1 §11 / Appendix A-3): under the constitutional
-- specification, this table's primary, authoritative meaning is Programme
-- Level (Foundation -> Framework -> Skyline: a progression ladder owned by
-- the Programme, changed only by Promotion — ABRS v2.1 §11-12). The words
-- "cohort" and "Learning Group" in the comment above predate the
-- constitution and describe a second, related-but-distinct usage this table
-- is also read for elsewhere in the codebase (grouping learners within a
-- delivery, independent of progression). ABRS v2.1 §11.3 records this as a
-- known, currently-unresolved mixing of responsibilities and is explicit
-- that no new architectural layer (Cohort, Track, Stream, Section, or any
-- other name — ABRS v2.1 §11.4) may be introduced to split it without a
-- separate constitutional review. Until such a review happens, read this
-- table as Programme Level first; do not extend its "cohort" usage further.
CREATE TABLE IF NOT EXISTS classes (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Which class(es) an instructor has been assigned to by admin — instructors
-- may only see/interact with learners, attendance, notes and topics that
-- belong to these classes.
CREATE TABLE IF NOT EXISTS instructor_classes (
  instructor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id      TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  PRIMARY KEY (instructor_id, class_id)
);

-- Which course(s) an instructor has been assigned to teach.
CREATE TABLE IF NOT EXISTS instructor_courses (
  instructor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id     TEXT NOT NULL,
  PRIMARY KEY (instructor_id, course_id)
);

-- Assignments (distinct from free-form "projects"): file upload OR
-- in-portal text-editor submission, graded by the instructor.
CREATE TABLE IF NOT EXISTS assignment_submissions (
  id           TEXT PRIMARY KEY,
  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text_content TEXT,
  file_path    TEXT,
  grade        TEXT,
  feedback     TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- End-of-term / midterm examinations: instructor-authored MCQ sets,
-- auto-graded the same way lesson quizzes are.
CREATE TABLE IF NOT EXISTS examinations (
  id          TEXT PRIMARY KEY,
  course_id   TEXT NOT NULL,
  class_id    TEXT REFERENCES classes(id),
  title       TEXT NOT NULL,
  term_type   TEXT NOT NULL CHECK (term_type IN ('midterm','end_of_term','retake')),
  questions   TEXT NOT NULL,   -- JSON: [{question, choices:[], correctIndex}]
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Only meaningful when term_type = 'retake': JSON array of learner user_ids
  -- this examination is restricted to (identified via transcript interpretation).
  -- NULL for midterm/end_of_term, which remain visible to the whole class as before.
  assigned_learner_ids TEXT
);

CREATE TABLE IF NOT EXISTS examination_attempts (
  id             TEXT PRIMARY KEY,
  examination_id TEXT NOT NULL REFERENCES examinations(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers        TEXT NOT NULL,  -- JSON array of chosen indices
  score          INTEGER NOT NULL, -- percent
  submitted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(examination_id, user_id)
);

-- ============================================================
-- v4 additions — Instructor Continuous Assessment (independent of the
-- AI-generated lesson quizzes and of the Examination panel). Attached to a
-- single lesson item, which is either a video lesson or a note — both are
-- rows in `notes`, matched the same way the rest of the app already
-- identifies them (kind = 'video_lesson' | 'note').
-- ============================================================

CREATE TABLE IF NOT EXISTS continuous_assessments (
  id           TEXT PRIMARY KEY,
  course_id    TEXT NOT NULL,
  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, -- the video lesson / note it's attached to
  title        TEXT NOT NULL,
  published    INTEGER NOT NULL DEFAULT 0,   -- learners only ever see published assessments
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- `type` is deliberately open-ended (not a CHECK enum) so additional question
-- types can be added later without an engine redesign; only 'mcq' and
-- 'true_false' are used today. `options` is JSON (4 choices for mcq, always
-- ["True","False"] for true_false); `correct_answer` stores the correct
-- option index as text so both types share one column.
CREATE TABLE IF NOT EXISTS ca_questions (
  id               TEXT PRIMARY KEY,
  assessment_id    TEXT NOT NULL REFERENCES continuous_assessments(id) ON DELETE CASCADE,
  type             TEXT NOT NULL DEFAULT 'mcq',   -- mcq | true_false (extensible)
  question         TEXT NOT NULL,
  options          TEXT NOT NULL,                 -- JSON array of choice strings
  correct_answer   INTEGER NOT NULL,               -- index into options
  marks            REAL NOT NULL DEFAULT 1,
  sort_order       INTEGER NOT NULL DEFAULT 0
);

-- One attempt per learner per assessment — auto-marked at submission time,
-- saved permanently. Kept entirely separate from progress.quiz_score (AI
-- quiz) and examination_attempts (Examination panel).
CREATE TABLE IF NOT EXISTS ca_attempts (
  id             TEXT PRIMARY KEY,
  assessment_id  TEXT NOT NULL REFERENCES continuous_assessments(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers        TEXT NOT NULL,   -- JSON array of chosen option indices
  total_marks    REAL NOT NULL,   -- marks earned
  max_marks      REAL NOT NULL,   -- marks available
  percentage     REAL NOT NULL,
  submitted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(assessment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ca_questions_assessment ON ca_questions(assessment_id);
CREATE INDEX IF NOT EXISTS idx_ca_attempts_user ON ca_attempts(user_id);

CREATE INDEX IF NOT EXISTS idx_progress_user ON progress(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_id);

-- ============================================================
-- v5 additions — Academic Session, Term & Calendar Engine.
-- Every academic-record table (grades, projects, payments, attendance,
-- examinations, examination_attempts, continuous_assessments, ca_attempts,
-- assignment_submissions, course_topics, notes) gets a `term_id` column
-- added via migrate.js's tryAlter (existing-row backward compatibility, same
-- pattern as every prior v2–v4 addition above). The tables below are the new
-- foundation those columns reference.
-- ============================================================

-- One row per academic year, e.g. "2025/2026". Only one row may have
-- is_active = 1 at a time; enforced in application code (utils/academicTerm.js),
-- not a DB constraint, so historical years are never blocked from existing.
CREATE TABLE IF NOT EXISTS academic_years (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,   -- e.g. '2025/2026'
  start_date TEXT,                   -- yyyy-mm-dd, optional
  end_date   TEXT,
  is_active  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Terms belong to exactly one academic year. sort_order encodes Term 1/2/3
-- ordering within that year. Only one term system-wide may have is_active = 1
-- (and it must belong to the active academic year — enforced in app code).
CREATE TABLE IF NOT EXISTS academic_terms (
  id               TEXT PRIMARY KEY,
  academic_year_id TEXT NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,     -- e.g. 'Term 1'
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(academic_year_id, name)
);

-- Every configurable date-range the calendar engine manages for a term:
-- registration, lessons, midterm, end-of-term exams, retake, payment
-- deadline, transcript release, certificate release, school holiday. `type`
-- is deliberately open-ended (not a CHECK enum) so new period types can be
-- added later without a schema change. Multiple rows of the same type are
-- allowed per term (e.g. several holiday ranges).
CREATE TABLE IF NOT EXISTS academic_calendar_periods (
  id         TEXT PRIMARY KEY,
  term_id    TEXT NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,   -- registration | lesson | midterm | end_of_term_exam | retake | payment_deadline | transcript_release | certificate_release | holiday
  label      TEXT,            -- optional display name, e.g. 'Christmas Break'
  start_date TEXT NOT NULL,   -- yyyy-mm-dd
  end_date   TEXT,            -- yyyy-mm-dd; NULL for single-date periods (deadlines/releases)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calendar_periods_term ON academic_calendar_periods(term_id);
CREATE INDEX IF NOT EXISTS idx_calendar_periods_type ON academic_calendar_periods(term_id, type);

-- Audit trail for every promotion/repeat/transfer/graduate action performed
-- by the Promotion Engine. Does not itself move any records — it's a log of
-- what happened, for admin review. `details` is JSON: shape depends on
-- action (e.g. {fromClassId, toClassId} for transfer, {fromCampus, toCampus}
-- for campus transfer).
CREATE TABLE IF NOT EXISTS promotion_log (
  id                TEXT PRIMARY KEY,
  learner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action            TEXT NOT NULL,   -- promote | repeat | transfer_class | transfer_campus | graduate
  from_year_id      TEXT REFERENCES academic_years(id),
  to_year_id        TEXT REFERENCES academic_years(id),
  details           TEXT,            -- JSON, action-specific
  performed_by      TEXT NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_promotion_log_learner ON promotion_log(learner_id);

-- Every Retake Examination attempt, kept independently of examination_attempts
-- so a full retake history survives even though examination_attempts already
-- stores the attempt too (this table is the audit-focused summary the
-- Retake Workflow reads to decide "does this learner still show as Retake").
CREATE TABLE IF NOT EXISTS retake_attempts (
  id             TEXT PRIMARY KEY,
  learner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id      TEXT NOT NULL,
  term_id        TEXT NOT NULL REFERENCES academic_terms(id),
  examination_id TEXT NOT NULL REFERENCES examinations(id) ON DELETE CASCADE,
  score          INTEGER NOT NULL,          -- percent scored on the retake exam
  new_total      REAL,                      -- recalculated course Total after this attempt
  new_grade      TEXT,                      -- recalculated Grade after this attempt
  new_interpretation TEXT,                  -- recalculated Interpretation after this attempt
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_retake_attempts_learner_course_term ON retake_attempts(learner_id, course_id, term_id);

-- ============================================================
-- v6 additions — Role-Based Access Control (RBAC) Engine.
-- Reusable Role Templates (Super Administrator, Administrator, Academic
-- Administrator, Finance Administrator, Certificate Administrator, Campus
-- Administrator, Corporate Coordinator, plus any custom ones a Super
-- Administrator creates from the Admin Portal). Administrator accounts
-- reference one via users.role_template_id (added in migrate.js's tryAlter,
-- same additive pattern as every prior column); users.custom_permissions
-- (also added there) lets a Super Administrator override a template with a
-- hand-picked permission set for one specific administrator only.
-- See utils/permissions.js for the permission catalog and utils/rbac.js for
-- the engine that resolves them — nothing else in the LMS should hardcode a
-- permission check.
-- ============================================================
CREATE TABLE IF NOT EXISTS role_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0,   -- built-in templates: not deletable
  is_active   INTEGER NOT NULL DEFAULT 1,
  permissions TEXT NOT NULL DEFAULT '[]',   -- JSON array of "module.action" keys
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- NOTE: corporate_clients already exists (created in db/migrate.js as part of
-- the Unified Learning Architecture) — Corporate Coordinator accounts simply
-- reference it via users.corporate_client_id (added below in migrate.js),
-- no new table needed here.

CREATE INDEX IF NOT EXISTS idx_role_templates_active ON role_templates(is_active);

-- ============================================================
-- v7 addition — Audit Trail. A record of every change/modification made
-- anywhere in the LMS, for Super Administrator review (Admin Portal ->
-- Roles & Access -> Audit Trail). Rows are written two ways:
--  1. utils/auditLog.js's recordAuditLog(), called explicitly right after
--     a write by routes that already have the before/after values and can
--     produce a real field-by-field diff (see routes/users.js account
--     changes, routes/roleTemplates.js) — `changes` is populated JSON.
--  2. middleware/auditTrail.js, a catch-all that logs every mutating
--     (POST/PUT/PATCH/DELETE) authenticated API request that reaches this
--     far without #1 already having logged it (req._auditLogged) — so
--     every change is captured even before a route gets its own rich
--     instrumentation. These rows have method/path but no `changes` diff,
--     and never log request bodies (so secrets/passwords are never at risk
--     of ending up in the trail).
-- `changes` is JSON: {field: {from, to}} for a diffed update, or a
-- free-form action-specific payload for a create/delete — open-ended
-- shape, same convention as promotion_log.details above.
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT REFERENCES users(id),
  actor_name    TEXT,               -- snapshot at write time, survives actor account deletion
  actor_role    TEXT,
  action        TEXT NOT NULL,      -- create | update | delete | status_change | ... (open-ended)
  entity_type   TEXT NOT NULL,      -- e.g. 'users', 'role_templates', 'settings'
  entity_id     TEXT,
  entity_label  TEXT,               -- human-readable snapshot, e.g. the affected account's name
  changes       TEXT,               -- JSON diff/payload; NULL when nothing more specific was captured
  method        TEXT,               -- HTTP method
  path          TEXT,               -- request path
  status_code   INTEGER,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
