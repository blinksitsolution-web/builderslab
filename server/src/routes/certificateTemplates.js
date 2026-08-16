const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getSetting, setSetting } = require("../utils/settings");
const { createUploadPipeline } = require("../middleware/upload");

const router = express.Router();

const TEMPLATE_TYPES = ["module_completion", "graduation", "honor", "recognition", "corporate_training", "bootcamp"];

// Certificate signatures — a simple, ONE-TIME global upload (an admin
// indicates whether the certificate carries one or two signatures, and
// uploads each), exactly like the single global signature already used for
// transcripts (see routes/settings.js POST /branding/signature) — instead
// of the older per-Campus Branding Profile signature (routes/campusBranding.js),
// which only ever applied to Kids STEM campuses and left Adult
// Professional/Corporate Training/Bootcamp certificates (no campus at all)
// with no way to carry a signature. Stored on certificateOrgSettings since
// that's already the one global, always-applicable settings bucket for
// certificates (institution/programme name).
const DEFAULT_CERT_ORG_SETTINGS = {
  institutionName: "Dalijay Tech Hub",
  programName: "Builder's Lab",
  signatureCount: 1, // 1 or 2
  signature1: { path: null, name: "", title: "" },
  signature2: { path: null, name: "", title: "" },
};
function certOrgSettings() {
  const stored = getSetting("certificateOrgSettings", DEFAULT_CERT_ORG_SETTINGS);
  return {
    ...DEFAULT_CERT_ORG_SETTINGS,
    ...stored,
    signature1: { ...DEFAULT_CERT_ORG_SETTINGS.signature1, ...(stored.signature1 || {}) },
    signature2: { ...DEFAULT_CERT_ORG_SETTINGS.signature2, ...(stored.signature2 || {}) },
  };
}

// Same "branding" uploads subfolder as routes/campusBranding.js and
// routes/settings.js's signature upload — `verify` checks real file
// content (magic bytes) against png/jpeg/webp after upload.
const { upload: signatureUpload, verify: verifySignature } = createUploadPipeline("IMAGE", "branding", 8);

function rowToTemplate(row) {
  return {
    ...row,
    isActive: !!row.is_active,
    showAcademicStats: !!row.show_academic_stats,
    fields: JSON.parse(row.fields || "[]"),
    placeholders: JSON.parse(row.placeholders || "[]"),
    skillsConfig: row.skills_config ? JSON.parse(row.skills_config) : null,
  };
}

// Global, org-wide settings that aren't campus- or template-specific
// (institution name, program name) — per spec these are fixed identifiers
// ("Dalijay Tech Hub" / "Builder's Lab"), not something that varies by
// campus branding profile or by certificate template.
router.get("/org-settings", requireAuth, (req, res) => {
  res.json(certOrgSettings());
});

router.patch("/org-settings", requireAuth, requireRole("admin"), (req, res) => {
  const current = certOrgSettings();
  const { institutionName, programName, signatureCount, signature1Name, signature1Title, signature2Name, signature2Title } = req.body;
  const updated = {
    ...current,
    institutionName: institutionName ?? current.institutionName,
    programName: programName ?? current.programName,
    // Only 1 or 2 signatures are ever meaningful on a certificate — an
    // admin explicitly indicates which, exactly per spec.
    signatureCount: [1, 2].includes(Number(signatureCount)) ? Number(signatureCount) : current.signatureCount,
    signature1: { ...current.signature1, name: signature1Name ?? current.signature1.name, title: signature1Title ?? current.signature1.title },
    signature2: { ...current.signature2, name: signature2Name ?? current.signature2.name, title: signature2Title ?? current.signature2.title },
  };
  setSetting("certificateOrgSettings", updated);
  res.json(updated);
});

// Uploading the signature image itself is a separate multipart endpoint per
// slot (1 or 2) — same pattern as routes/settings.js's branding/signature
// and routes/campusBranding.js's per-slot image uploads elsewhere in this
// codebase, so this isn't a new upload pattern.
router.post("/org-settings/signature/:slot", requireAuth, requireRole("admin"), signatureUpload.single("signature"), verifySignature, (req, res) => {
  const slot = req.params.slot;
  if (!["1", "2"].includes(slot)) return res.status(400).json({ error: "slot must be 1 or 2." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const current = certOrgSettings();
  const key = `signature${slot}`;
  const updated = { ...current, [key]: { ...current[key], path: `/uploads/branding/${req.file.filename}` } };
  setSetting("certificateOrgSettings", updated);
  res.json(updated);
});

// Any signed-in user can list templates (issuing UI, and learners/parents
// don't need this — but instructors/admins picking a template to issue do).
router.get("/", requireAuth, (req, res) => {
  let rows = db.prepare("SELECT * FROM certificate_templates ORDER BY name ASC").all();
  if (req.query.type) rows = rows.filter((r) => r.type === req.query.type);
  if (req.query.activeOnly === "true") rows = rows.filter((r) => r.is_active);
  res.json({ templates: rows.map(rowToTemplate) });
});

router.get("/:id", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM certificate_templates WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Template not found." });
  res.json(rowToTemplate(row));
});

router.post("/", requireAuth, requireRole("admin"), (req, res) => {
  const { name, type, title, body, footer, dateFormat, numberFormat, fields, placeholders, showAcademicStats, skillsConfig } = req.body;
  if (!name || !type) return res.status(400).json({ error: "name and type are required." });
  if (!TEMPLATE_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${TEMPLATE_TYPES.join(", ")}` });
  const id = uuid();
  db.prepare(
    `INSERT INTO certificate_templates
       (id, name, type, title, body, footer, date_format, number_format, fields, placeholders, show_academic_stats, skills_config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    type,
    title || "Certificate of Completion",
    body || "",
    footer || null,
    dateFormat || "DD MMMM YYYY",
    numberFormat || "CERT-{campus}-{year}-{seq}",
    JSON.stringify(fields || []),
    JSON.stringify(placeholders || []),
    showAcademicStats ? 1 : 0,
    skillsConfig ? JSON.stringify(skillsConfig) : null
  );
  res.json(rowToTemplate(db.prepare("SELECT * FROM certificate_templates WHERE id = ?").get(id)));
});

router.patch("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const row = db.prepare("SELECT * FROM certificate_templates WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Template not found." });
  if (req.body.type && !TEMPLATE_TYPES.includes(req.body.type)) {
    return res.status(400).json({ error: `type must be one of: ${TEMPLATE_TYPES.join(", ")}` });
  }
  const merged = {
    name: req.body.name ?? row.name,
    type: req.body.type ?? row.type,
    title: req.body.title ?? row.title,
    body: req.body.body ?? row.body,
    footer: req.body.footer ?? row.footer,
    date_format: req.body.dateFormat ?? row.date_format,
    number_format: req.body.numberFormat ?? row.number_format,
    fields: req.body.fields ? JSON.stringify(req.body.fields) : row.fields,
    placeholders: req.body.placeholders ? JSON.stringify(req.body.placeholders) : row.placeholders,
    show_academic_stats: req.body.showAcademicStats != null ? (req.body.showAcademicStats ? 1 : 0) : row.show_academic_stats,
    skills_config: req.body.skillsConfig ? JSON.stringify(req.body.skillsConfig) : row.skills_config,
  };
  db.prepare(
    `UPDATE certificate_templates SET name=?, type=?, title=?, body=?, footer=?, date_format=?, number_format=?,
       fields=?, placeholders=?, show_academic_stats=?, skills_config=?, updated_at=datetime('now') WHERE id=?`
  ).run(
    merged.name, merged.type, merged.title, merged.body, merged.footer, merged.date_format, merged.number_format,
    merged.fields, merged.placeholders, merged.show_academic_stats, merged.skills_config, req.params.id
  );
  // Editing a template never touches previously-issued certificates — those
  // hold their own template_snapshot taken at issue time (see
  // db/migrate.js's issued_certificates table and routes/certificates.js).
  res.json(rowToTemplate(db.prepare("SELECT * FROM certificate_templates WHERE id = ?").get(req.params.id)));
});

router.post("/:id/duplicate", requireAuth, requireRole("admin"), (req, res) => {
  const row = db.prepare("SELECT * FROM certificate_templates WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Template not found." });
  const id = uuid();
  db.prepare(
    `INSERT INTO certificate_templates
       (id, name, type, title, body, footer, date_format, number_format, fields, placeholders, show_academic_stats, skills_config, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(id, `${row.name} (Copy)`, row.type, row.title, row.body, row.footer, row.date_format, row.number_format, row.fields, row.placeholders, row.show_academic_stats, row.skills_config);
  res.json(rowToTemplate(db.prepare("SELECT * FROM certificate_templates WHERE id = ?").get(id)));
});

router.post("/:id/activate", requireAuth, requireRole("admin"), (req, res) => {
  const result = db.prepare("UPDATE certificate_templates SET is_active = 1, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Template not found." });
  res.json(rowToTemplate(db.prepare("SELECT * FROM certificate_templates WHERE id = ?").get(req.params.id)));
});

router.post("/:id/deactivate", requireAuth, requireRole("admin"), (req, res) => {
  const result = db.prepare("UPDATE certificate_templates SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Template not found." });
  res.json(rowToTemplate(db.prepare("SELECT * FROM certificate_templates WHERE id = ?").get(req.params.id)));
});

module.exports = router;
