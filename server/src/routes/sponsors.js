// ============================================================
// Sponsors — NGOs, Members of Parliament, corporates, or individuals
// covering a learner's fees. CRUD here mirrors corporate_clients in
// learningOfferings.js (view/create/edit, is_active toggle instead of
// delete) rather than inventing a different shape for what is,
// structurally, the same kind of "organization funding some learners"
// entity.
//
// The actual attach/detach-to-a-learner action lives in routes/users.js
// as PATCH /:userId/sponsor (it belongs with the rest of a learner's
// account-mutation endpoints, not here) — this file is purely about
// managing the sponsor roster and reporting on who's under each sponsor.
// ============================================================

const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { toPublicUser } = require("../utils/userView");

const router = express.Router();

const SPONSOR_TYPES = ["ngo", "mp", "corporate", "individual", "other"];

function toSponsor(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    notes: row.notes,
    isActive: !!row.is_active,
    maxLearners: row.max_learners,
    learnerCount: row.learner_count ?? undefined,
  };
}

// GET /api/sponsors?all=true — active-only by default (same convention as
// GET /corporate-clients), ?all=true includes deactivated sponsors too
// (still shown in historical reports, just not offered when attaching a
// new learner). Includes a learner_count per sponsor so the list itself
// doubles as a lightweight "how many learners is each sponsor covering"
// view without a separate request per row.
router.get("/", requireAuth, requirePermission("sponsors.view"), (req, res) => {
  let sql = `
    SELECT s.*, (SELECT COUNT(*) FROM users u WHERE u.sponsor_id = s.id AND u.role = 'learner') AS learner_count
    FROM sponsors s`;
  if (req.query.all !== "true") sql += " WHERE s.is_active = 1";
  sql += " ORDER BY s.name ASC";
  res.json({ sponsors: db.prepare(sql).all().map(toSponsor) });
});

router.post("/", requireAuth, requirePermission("sponsors.create"), (req, res) => {
  const { name, type, contactName, contactEmail, contactPhone, notes, maxLearners } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required." });
  if (type && !SPONSOR_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${SPONSOR_TYPES.join(", ")}` });
  }
  if (maxLearners !== undefined && maxLearners !== null && (!Number.isInteger(maxLearners) || maxLearners < 1)) {
    return res.status(400).json({ error: "maxLearners must be a positive whole number, or omitted for no limit." });
  }
  if (db.prepare("SELECT id FROM sponsors WHERE name = ?").get(name.trim())) {
    return res.status(409).json({ error: "A sponsor with this name already exists." });
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO sponsors (id, name, type, contact_name, contact_email, contact_phone, notes, max_learners)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name.trim(), type || "ngo", contactName || null, contactEmail || null, contactPhone || null, notes || null, maxLearners ?? null);
  res.json(toSponsor(db.prepare("SELECT * FROM sponsors WHERE id = ?").get(id)));
});

router.patch("/:id", requireAuth, requirePermission("sponsors.edit"), (req, res) => {
  const row = db.prepare("SELECT * FROM sponsors WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Sponsor not found." });
  const { name, type, contactName, contactEmail, contactPhone, notes, maxLearners } = req.body;
  if (type && !SPONSOR_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${SPONSOR_TYPES.join(", ")}` });
  }
  if (maxLearners !== undefined && maxLearners !== null && (!Number.isInteger(maxLearners) || maxLearners < 1)) {
    return res.status(400).json({ error: "maxLearners must be a positive whole number, or omitted for no limit." });
  }
  db.prepare(`UPDATE sponsors SET name=?, type=?, contact_name=?, contact_email=?, contact_phone=?, notes=?, max_learners=? WHERE id=?`).run(
    name?.trim() ?? row.name,
    type ?? row.type,
    contactName ?? row.contact_name,
    contactEmail ?? row.contact_email,
    contactPhone ?? row.contact_phone,
    notes ?? row.notes,
    maxLearners !== undefined ? maxLearners : row.max_learners,
    req.params.id
  );
  res.json(toSponsor(db.prepare("SELECT * FROM sponsors WHERE id = ?").get(req.params.id)));
});

router.post("/:id/activate", requireAuth, requirePermission("sponsors.edit"), (req, res) => {
  const result = db.prepare("UPDATE sponsors SET is_active = 1 WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Sponsor not found." });
  res.json({ ok: true });
});

router.post("/:id/deactivate", requireAuth, requirePermission("sponsors.edit"), (req, res) => {
  // Deactivating a sponsor does NOT retroactively unwaive any learner
  // currently attached to it — that's a deliberate, separate admin
  // action (PATCH /api/users/:userId/sponsor with sponsorId: null) so a
  // sponsor's funding round ending doesn't silently cut off learners
  // mid-term. Deactivating just stops it being offered for *new*
  // attachments.
  const result = db.prepare("UPDATE sponsors SET is_active = 0 WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Sponsor not found." });
  res.json({ ok: true });
});

// GET /api/sponsors/:id/learners — the roster a sponsor (or the admin
// reporting back to them) needs: who they're currently funding.
router.get("/:id/learners", requireAuth, requirePermission("sponsors.view"), (req, res) => {
  const sponsor = db.prepare("SELECT * FROM sponsors WHERE id = ?").get(req.params.id);
  if (!sponsor) return res.status(404).json({ error: "Sponsor not found." });
  const learners = db.prepare("SELECT * FROM users WHERE sponsor_id = ? AND role = 'learner' ORDER BY name ASC").all(req.params.id);
  res.json({ sponsor: toSponsor(sponsor), learners: learners.map((u) => toPublicUser(u)) });
});

// GET /api/sponsors/:id/coordinators — the coordinator accounts (role
// 'parent', sponsor_id = this sponsor) currently registering learners on
// this sponsor's behalf. Separate from /:id/learners above (that's the
// actual sponsored children/adults; this is the staff-created logins
// managing them).
router.get("/:id/coordinators", requireAuth, requirePermission("sponsors.view"), (req, res) => {
  const sponsor = db.prepare("SELECT * FROM sponsors WHERE id = ?").get(req.params.id);
  if (!sponsor) return res.status(404).json({ error: "Sponsor not found." });
  const coordinators = db
    .prepare("SELECT id, name, email, phone, max_children, coordinator_scope, status FROM users WHERE sponsor_id = ? AND role = 'parent' ORDER BY name ASC")
    .all(req.params.id)
    .map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      maxChildren: c.max_children,
      scope: c.coordinator_scope || "child",
      status: c.status,
      childCount: db.prepare("SELECT COUNT(*) c FROM users WHERE parent_id = ? AND status != 'inactive'").get(c.id).c,
    }));
  res.json({ sponsor: toSponsor(sponsor), coordinators });
});

module.exports = router;
