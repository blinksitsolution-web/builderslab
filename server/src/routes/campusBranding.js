const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { createUploadPipeline } = require("../middleware/upload");

const router = express.Router();

// Same upload pattern as users.js's avatarUpload — one shared uploads root,
// its own subfolder. `verify` checks real file content (magic bytes)
// against png/jpeg/webp after upload, not just the client-supplied mimetype.
const { upload: brandingUpload, verify: verifyBrandingImage } = createUploadPipeline("IMAGE", "branding", 8);

function rowToProfile(row) {
  return { ...row, themeColours: row.theme_colours ? JSON.parse(row.theme_colours) : null };
}

router.get("/", requireAuth, (req, res) => {
  res.json({ profiles: db.prepare("SELECT * FROM campus_branding_profiles ORDER BY campus_name ASC").all().map(rowToProfile) });
});

router.get("/:campusName", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM campus_branding_profiles WHERE campus_name = ?").get(req.params.campusName);
  if (!row) return res.status(404).json({ error: "No branding profile for this campus yet." });
  res.json(rowToProfile(row));
});

// Adding a new partner school only requires creating one of these — no code
// change, per the spec.
router.post("/", requireAuth, requireRole("admin"), (req, res) => {
  const { campusName, partnerSchoolName, institutionName, authorizedSignatory, footer, themeColours } = req.body;
  if (!campusName) return res.status(400).json({ error: "campusName is required." });
  const campus = db.prepare("SELECT name FROM campuses WHERE name = ?").get(campusName);
  if (!campus) return res.status(404).json({ error: "Unknown campus. Create the campus first." });
  const id = uuid();
  try {
    db.prepare(
      `INSERT INTO campus_branding_profiles (id, campus_name, partner_school_name, institution_name, authorized_signatory, footer, theme_colours)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, campusName, partnerSchoolName || null, institutionName || "Dalijay Tech Hub", authorizedSignatory || null, footer || null, themeColours ? JSON.stringify(themeColours) : null);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return res.status(409).json({ error: "A branding profile already exists for this campus." });
    throw e;
  }
  res.json(rowToProfile(db.prepare("SELECT * FROM campus_branding_profiles WHERE id = ?").get(id)));
});

router.patch("/:campusName", requireAuth, requireRole("admin"), (req, res) => {
  const row = db.prepare("SELECT * FROM campus_branding_profiles WHERE campus_name = ?").get(req.params.campusName);
  if (!row) return res.status(404).json({ error: "No branding profile for this campus yet — create one first." });
  const merged = {
    partner_school_name: req.body.partnerSchoolName ?? row.partner_school_name,
    institution_name: req.body.institutionName ?? row.institution_name,
    authorized_signatory: req.body.authorizedSignatory ?? row.authorized_signatory,
    footer: req.body.footer ?? row.footer,
    theme_colours: req.body.themeColours ? JSON.stringify(req.body.themeColours) : row.theme_colours,
  };
  db.prepare(
    `UPDATE campus_branding_profiles SET partner_school_name=?, institution_name=?, authorized_signatory=?, footer=?, theme_colours=?, updated_at=datetime('now') WHERE campus_name=?`
  ).run(merged.partner_school_name, merged.institution_name, merged.authorized_signatory, merged.footer, merged.theme_colours, req.params.campusName);
  // Never touches previously-issued certificates — see issued_certificates'
  // branding_snapshot in db/migrate.js.
  res.json(rowToProfile(db.prepare("SELECT * FROM campus_branding_profiles WHERE campus_name = ?").get(req.params.campusName)));
});

// Separate upload endpoints per image slot, matching how avatarUpload works
// elsewhere in this codebase — keeps the JSON PATCH endpoint above free of
// multipart handling.
function uploadHandler(column) {
  return [
    requireAuth,
    requireRole("admin"),
    brandingUpload.single("image"),
    verifyBrandingImage,
    (req, res) => {
      const row = db.prepare("SELECT * FROM campus_branding_profiles WHERE campus_name = ?").get(req.params.campusName);
      if (!row) return res.status(404).json({ error: "No branding profile for this campus yet — create one first." });
      if (!req.file) return res.status(400).json({ error: "No image uploaded." });
      const filePath = `/uploads/branding/${req.file.filename}`;
      db.prepare(`UPDATE campus_branding_profiles SET ${column} = ?, updated_at = datetime('now') WHERE campus_name = ?`).run(filePath, req.params.campusName);
      res.json(rowToProfile(db.prepare("SELECT * FROM campus_branding_profiles WHERE campus_name = ?").get(req.params.campusName)));
    },
  ];
}
router.post("/:campusName/institution-logo", ...uploadHandler("institution_logo_path"));
router.post("/:campusName/partner-logo", ...uploadHandler("partner_logo_path"));
router.post("/:campusName/signature", ...uploadHandler("signature_path"));
router.post("/:campusName/background", ...uploadHandler("background_image_path"));

module.exports = router;
