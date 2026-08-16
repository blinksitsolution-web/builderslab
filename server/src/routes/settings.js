const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole, requirePermission, requireSuperAdmin } = require("../middleware/auth");
const { getSetting, setSetting } = require("../utils/settings");
const { wardDiscountPercents } = require("../utils/fees");
const { encryptSecret, decryptSecret, maskSecret } = require("../utils/crypto");
const { getProvider, DEFAULT_MODELS } = require("../utils/aiProviderRegistry");
const { createUploadPipeline } = require("../middleware/upload");

const router = express.Router();

// All of this file's uploads (about-section image, branding signature/logo,
// success-story avatars, blog covers, how-it-works images, gallery images,
// partner logos) are plain images sharing the same "branding" folder and
// 10MB limit as before — `verify` checks real file content (magic bytes)
// against png/jpeg/webp after upload, not just the client-supplied mimetype.
const { upload, verify } = createUploadPipeline("IMAGE", "branding", 10);

/* ---------------------------------------------------------------------
   Public: everything the landing page / register page needs in one call
   --------------------------------------------------------------------- */
router.get("/public", (req, res) => {
  const hero = getSetting("hero", {});
  const fees = getSetting("fees", { registrationGHS: 350, monthlyGHS: 180, termlyGHS: 480, partnerSchoolRegistrationGHS: 250, partnerSchoolMonthlyGHS: 130, ownRoboticsKitFeeGHS: 200, registrationDiscountPercent: 0, monthlyDiscountPercent: 0 });
  // ABRS v2.2 §15.7 — registrationDiscountPercent/monthlyDiscountPercent
  // above are the pre-§15 settings this Discount Policy was originally
  // seeded from (db/migratePricing.js's one-time v41 backfill); nothing
  // reads them for pricing anymore, only the discount_policies row they
  // produced does (utils/pricingEngine.js's resolveDiscountPolicies).
  // liveSiblingDiscountPercents is that row's CURRENT actual value, so
  // Settings → Fees can show admins the number that's really in effect
  // instead of the frozen-at-migration-time one above.
  fees.liveSiblingDiscountPercents = wardDiscountPercents();
  const branding = getSetting("branding", { logoPath: "/images/DTH.jpg" });
  const contact = getSetting("contact", {});
  const campuses = db.prepare("SELECT id, name FROM campuses WHERE active = 1 ORDER BY name").all();
  const stories = db.prepare("SELECT * FROM success_stories ORDER BY sort_order ASC").all();
  const blog = db.prepare("SELECT * FROM blog_posts WHERE published = 1 ORDER BY featured DESC, date DESC LIMIT 6").all();
  const paymentAccounts = db.prepare("SELECT * FROM payment_accounts WHERE active = 1").all();
  // Public Website CMS additions — About/Home/Footer/Enrol-button copy plus
  // the new list-content sections. Each falls back to a sane default so
  // older frontends that don't read these keys are unaffected.
  const about = getSetting("about", {});
  const home = getSetting("home", {});
  const footer = getSetting("footer", {});
  const enrolButton = getSetting("enrolButton", { text: "Enrol now", targetOfferingSlug: "kids_stem", openBehavior: "same_tab", visible: true });
  const howItWorks = db.prepare("SELECT * FROM how_it_works_steps WHERE active = 1 ORDER BY sort_order ASC").all();
  const faqs = db.prepare("SELECT * FROM faqs WHERE active = 1 ORDER BY sort_order ASC").all();
  const gallery = db.prepare("SELECT * FROM gallery_images WHERE active = 1 ORDER BY sort_order ASC").all();
  const partners = db.prepare("SELECT * FROM partners WHERE active = 1 ORDER BY sort_order ASC").all();
  res.json({ hero, fees, branding, contact, campuses, stories, blog, paymentAccounts, about, home, footer, enrolButton, howItWorks, faqs, gallery, partners });
});

/* ---------------------------------------------------------------------
   Admin: landing content
   --------------------------------------------------------------------- */
router.patch("/hero", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  setSetting("hero", { ...getSetting("hero", {}), ...req.body });
  res.json({ ok: true });
});
router.patch("/contact", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  setSetting("contact", { ...getSetting("contact", {}), ...req.body });
  res.json({ ok: true });
});
router.patch("/about", requireAuth, requirePermission("siteSettings.edit"), upload.single("image"), verify, (req, res) => {
  const next = { ...getSetting("about", {}), ...req.body };
  if (req.file) next.imagePath = `/uploads/branding/${req.file.filename}`;
  setSetting("about", next);
  res.json({ ok: true, about: next });
});
router.patch("/home", requireAuth, requirePermission("siteSettings.edit"), upload.single("howItWorksImage"), verify, (req, res) => {
  const next = { ...getSetting("home", {}), ...req.body };
  if (req.file) next.howItWorksImagePath = `/uploads/branding/${req.file.filename}`;
  setSetting("home", next);
  res.json({ ok: true, home: next });
});
router.patch("/footer", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  const next = { ...getSetting("footer", {}), ...req.body };
  setSetting("footer", next);
  res.json({ ok: true, footer: next });
});
router.patch("/enrol-button", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  const current = getSetting("enrolButton", { text: "Enrol now", targetOfferingSlug: "kids_stem", openBehavior: "same_tab", visible: true });
  const { text, targetOfferingSlug, openBehavior, visible } = req.body;
  const next = {
    text: text ?? current.text,
    targetOfferingSlug: targetOfferingSlug ?? current.targetOfferingSlug,
    openBehavior: openBehavior ?? current.openBehavior,
    visible: visible !== undefined ? !!visible : current.visible,
  };
  setSetting("enrolButton", next);
  res.json({ ok: true, enrolButton: next });
});
router.patch("/fees", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  const { registrationGHS, monthlyGHS, termlyGHS, partnerSchoolRegistrationGHS, partnerSchoolMonthlyGHS, ownRoboticsKitFeeGHS, registrationDiscountPercent, monthlyDiscountPercent } = req.body;
  const current = getSetting("fees", {});
  const num = (v, fallback) => (v != null ? Number(v) : fallback);
  setSetting("fees", {
    registrationGHS: num(registrationGHS, current.registrationGHS),
    monthlyGHS: num(monthlyGHS, current.monthlyGHS),
    termlyGHS: num(termlyGHS, current.termlyGHS),
    // Learners who attend one of our partner schools get a cheaper rate.
    partnerSchoolRegistrationGHS: num(partnerSchoolRegistrationGHS, current.partnerSchoolRegistrationGHS),
    partnerSchoolMonthlyGHS: num(partnerSchoolMonthlyGHS, current.partnerSchoolMonthlyGHS),
    // Extra one-off charge for learners who want to keep their own robotics kit.
    ownRoboticsKitFeeGHS: num(ownRoboticsKitFeeGHS, current.ownRoboticsKitFeeGHS),
    // Multi-ward discounts: applied from the 2nd child onward only.
    registrationDiscountPercent: num(registrationDiscountPercent, current.registrationDiscountPercent ?? 0),
    monthlyDiscountPercent: num(monthlyDiscountPercent, current.monthlyDiscountPercent ?? 0),
  });
  res.json({ ok: true });
});
router.patch("/branding", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  setSetting("branding", { ...getSetting("branding", {}), ...req.body });
  res.json({ ok: true });
});
router.post("/branding/signature", requireAuth, requirePermission("siteSettings.edit"), upload.single("signature"), verify, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const signaturePath = `/uploads/branding/${req.file.filename}`;
  setSetting("branding", { ...getSetting("branding", {}), signaturePath });
  res.json({ ok: true, signaturePath });
});
router.post("/branding/logo", requireAuth, requirePermission("siteSettings.edit"), upload.single("logo"), verify, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const logoPath = `/uploads/branding/${req.file.filename}`;
  setSetting("branding", { ...getSetting("branding", {}), logoPath });
  res.json({ ok: true, logoPath });
});

/* ---------------------------------------------------------------------
   Admin: payment accounts (displayed to parents on the register page)
   --------------------------------------------------------------------- */
router.post("/payment-accounts", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  const { network, accountNumber, accountName } = req.body;
  if (!network || !accountNumber || !accountName) return res.status(400).json({ error: "network, accountNumber and accountName are required." });
  db.prepare("INSERT INTO payment_accounts (id, network, account_number, account_name, active) VALUES (?, ?, ?, ?, 1)").run(uuid(), network, accountNumber, accountName);
  res.json({ ok: true });
});
router.patch("/payment-accounts/:id", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  const { network, accountNumber, accountName, active } = req.body;
  const existing = db.prepare("SELECT * FROM payment_accounts WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found." });
  db.prepare("UPDATE payment_accounts SET network=?, account_number=?, account_name=?, active=? WHERE id=?").run(
    network ?? existing.network,
    accountNumber ?? existing.account_number,
    accountName ?? existing.account_name,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    req.params.id
  );
  res.json({ ok: true });
});
router.delete("/payment-accounts/:id", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  db.prepare("DELETE FROM payment_accounts WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------
   Admin: success stories (landing page testimonials)
   --------------------------------------------------------------------- */
router.post("/success-stories", requireAuth, requirePermission("siteSettings.edit"), upload.single("avatar"), verify, (req, res) => {
  const { name, role, quote, highlighted, sortOrder } = req.body;
  if (!name || !quote) return res.status(400).json({ error: "name and quote are required." });
  const avatarPath = req.file ? `/uploads/branding/${req.file.filename}` : null;
  db.prepare(
    "INSERT INTO success_stories (id, name, role, quote, avatar_path, highlighted, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(uuid(), name, role || null, quote, avatarPath, highlighted ? 1 : 0, Number(sortOrder) || 0);
  res.json({ ok: true });
});
router.patch("/success-stories/:id", requireAuth, requirePermission("siteSettings.edit"), upload.single("avatar"), verify, (req, res) => {
  const existing = db.prepare("SELECT * FROM success_stories WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found." });
  const { name, role, quote, highlighted, sortOrder } = req.body;
  const avatarPath = req.file ? `/uploads/branding/${req.file.filename}` : existing.avatar_path;
  db.prepare("UPDATE success_stories SET name=?, role=?, quote=?, avatar_path=?, highlighted=?, sort_order=? WHERE id=?").run(
    name ?? existing.name,
    role ?? existing.role,
    quote ?? existing.quote,
    avatarPath,
    highlighted !== undefined ? (highlighted ? 1 : 0) : existing.highlighted,
    sortOrder !== undefined ? Number(sortOrder) : existing.sort_order,
    req.params.id
  );
  res.json({ ok: true });
});
router.delete("/success-stories/:id", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  db.prepare("DELETE FROM success_stories WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------
   Admin: blog / news
   --------------------------------------------------------------------- */
router.get("/blog/all", requireAuth, requirePermission("siteSettings.view", "siteSettings.edit"), (req, res) => {
  res.json({ posts: db.prepare("SELECT * FROM blog_posts ORDER BY date DESC").all() });
});
router.post("/blog", requireAuth, requirePermission("siteSettings.edit"), upload.single("cover"), verify, (req, res) => {
  const { title, body, published, featured, category, author, videoUrl } = req.body;
  if (!title || !body) return res.status(400).json({ error: "title and body are required." });
  const coverPath = req.file ? `/uploads/branding/${req.file.filename}` : null;
  db.prepare(
    "INSERT INTO blog_posts (id, title, body, cover_path, published, date, featured, category, author, video_url) VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)"
  ).run(
    uuid(), title, body, coverPath, published === "false" ? 0 : 1,
    featured === "true" || featured === true ? 1 : 0,
    category || null, author || null, videoUrl || null
  );
  res.json({ ok: true });
});
router.patch("/blog/:id", requireAuth, requirePermission("siteSettings.edit"), upload.single("cover"), verify, (req, res) => {
  const existing = db.prepare("SELECT * FROM blog_posts WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found." });
  const { title, body, published, featured, category, author, videoUrl } = req.body;
  const coverPath = req.file ? `/uploads/branding/${req.file.filename}` : existing.cover_path;
  db.prepare("UPDATE blog_posts SET title=?, body=?, cover_path=?, published=?, featured=?, category=?, author=?, video_url=? WHERE id=?").run(
    title ?? existing.title,
    body ?? existing.body,
    coverPath,
    published !== undefined ? (published === "false" || published === false ? 0 : 1) : existing.published,
    featured !== undefined ? (featured === "false" || featured === false ? 0 : 1) : existing.featured,
    category !== undefined ? category : existing.category,
    author !== undefined ? author : existing.author,
    videoUrl !== undefined ? videoUrl : existing.video_url,
    req.params.id
  );
  res.json({ ok: true });
});
router.delete("/blog/:id", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  db.prepare("DELETE FROM blog_posts WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------
   Admin: How It Works steps (landing page)
   --------------------------------------------------------------------- */
router.get("/how-it-works/all", requireAuth, requirePermission("siteSettings.view", "siteSettings.edit"), (req, res) => {
  res.json({ steps: db.prepare("SELECT * FROM how_it_works_steps ORDER BY sort_order ASC").all() });
});
router.post("/how-it-works", requireAuth, requirePermission("siteSettings.edit"), upload.single("image"), verify, (req, res) => {
  const { icon, title, description, sortOrder } = req.body;
  if (!title) return res.status(400).json({ error: "title is required." });
  const imagePath = req.file ? `/uploads/branding/${req.file.filename}` : null;
  db.prepare(
    "INSERT INTO how_it_works_steps (id, icon, image_path, title, description, sort_order, active) VALUES (?, ?, ?, ?, ?, ?, 1)"
  ).run(uuid(), icon || null, imagePath, title, description || null, Number(sortOrder) || 0);
  res.json({ ok: true });
});
router.patch("/how-it-works/:id", requireAuth, requirePermission("siteSettings.edit"), upload.single("image"), verify, (req, res) => {
  const existing = db.prepare("SELECT * FROM how_it_works_steps WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found." });
  const { icon, title, description, sortOrder, active } = req.body;
  const imagePath = req.file ? `/uploads/branding/${req.file.filename}` : existing.image_path;
  db.prepare("UPDATE how_it_works_steps SET icon=?, image_path=?, title=?, description=?, sort_order=?, active=? WHERE id=?").run(
    icon ?? existing.icon,
    imagePath,
    title ?? existing.title,
    description ?? existing.description,
    sortOrder !== undefined ? Number(sortOrder) : existing.sort_order,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    req.params.id
  );
  res.json({ ok: true });
});
router.delete("/how-it-works/:id", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  db.prepare("DELETE FROM how_it_works_steps WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------
   Admin: FAQs (landing page)
   --------------------------------------------------------------------- */
router.get("/faqs/all", requireAuth, requirePermission("siteSettings.view", "siteSettings.edit"), (req, res) => {
  res.json({ faqs: db.prepare("SELECT * FROM faqs ORDER BY sort_order ASC").all() });
});
router.post("/faqs", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  const { question, answer, sortOrder } = req.body;
  if (!question || !answer) return res.status(400).json({ error: "question and answer are required." });
  db.prepare("INSERT INTO faqs (id, question, answer, sort_order, active) VALUES (?, ?, ?, ?, 1)").run(uuid(), question, answer, Number(sortOrder) || 0);
  res.json({ ok: true });
});
router.patch("/faqs/:id", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  const existing = db.prepare("SELECT * FROM faqs WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found." });
  const { question, answer, sortOrder, active } = req.body;
  db.prepare("UPDATE faqs SET question=?, answer=?, sort_order=?, active=? WHERE id=?").run(
    question ?? existing.question,
    answer ?? existing.answer,
    sortOrder !== undefined ? Number(sortOrder) : existing.sort_order,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    req.params.id
  );
  res.json({ ok: true });
});
router.delete("/faqs/:id", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  db.prepare("DELETE FROM faqs WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------
   Admin: Gallery images (landing page)
   --------------------------------------------------------------------- */
router.get("/gallery/all", requireAuth, requirePermission("siteSettings.view", "siteSettings.edit"), (req, res) => {
  res.json({ images: db.prepare("SELECT * FROM gallery_images ORDER BY sort_order ASC").all() });
});
router.post("/gallery", requireAuth, requirePermission("siteSettings.edit"), upload.single("image"), verify, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "image file is required." });
  const { caption, sortOrder } = req.body;
  const imagePath = `/uploads/branding/${req.file.filename}`;
  db.prepare("INSERT INTO gallery_images (id, image_path, caption, sort_order, active) VALUES (?, ?, ?, ?, 1)").run(uuid(), imagePath, caption || null, Number(sortOrder) || 0);
  res.json({ ok: true });
});
router.patch("/gallery/:id", requireAuth, requirePermission("siteSettings.edit"), upload.single("image"), verify, (req, res) => {
  const existing = db.prepare("SELECT * FROM gallery_images WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found." });
  const { caption, sortOrder, active } = req.body;
  const imagePath = req.file ? `/uploads/branding/${req.file.filename}` : existing.image_path;
  db.prepare("UPDATE gallery_images SET image_path=?, caption=?, sort_order=?, active=? WHERE id=?").run(
    imagePath,
    caption ?? existing.caption,
    sortOrder !== undefined ? Number(sortOrder) : existing.sort_order,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    req.params.id
  );
  res.json({ ok: true });
});
router.delete("/gallery/:id", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  db.prepare("DELETE FROM gallery_images WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------
   Admin: Partners (landing page)
   --------------------------------------------------------------------- */
router.get("/partners/all", requireAuth, requirePermission("siteSettings.view", "siteSettings.edit"), (req, res) => {
  res.json({ partners: db.prepare("SELECT * FROM partners ORDER BY sort_order ASC").all() });
});
router.post("/partners", requireAuth, requirePermission("siteSettings.edit"), upload.single("logo"), verify, (req, res) => {
  const { name, url, sortOrder } = req.body;
  if (!name) return res.status(400).json({ error: "name is required." });
  const logoPath = req.file ? `/uploads/branding/${req.file.filename}` : null;
  db.prepare("INSERT INTO partners (id, name, logo_path, url, sort_order, active) VALUES (?, ?, ?, ?, ?, 1)").run(uuid(), name, logoPath, url || null, Number(sortOrder) || 0);
  res.json({ ok: true });
});
router.patch("/partners/:id", requireAuth, requirePermission("siteSettings.edit"), upload.single("logo"), verify, (req, res) => {
  const existing = db.prepare("SELECT * FROM partners WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found." });
  const { name, url, sortOrder, active } = req.body;
  const logoPath = req.file ? `/uploads/branding/${req.file.filename}` : existing.logo_path;
  db.prepare("UPDATE partners SET name=?, logo_path=?, url=?, sort_order=?, active=? WHERE id=?").run(
    name ?? existing.name,
    logoPath,
    url ?? existing.url,
    sortOrder !== undefined ? Number(sortOrder) : existing.sort_order,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    req.params.id
  );
  res.json({ ok: true });
});
router.delete("/partners/:id", requireAuth, requirePermission("siteSettings.edit"), (req, res) => {
  db.prepare("DELETE FROM partners WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------
   Admin: API keys (Paystack, AI providers) — never exposed via /public.
   Stored in the same generic site_settings key/value store as everything
   else here. AI provider credentials are encrypted at rest (utils/crypto.js)
   and only ever decrypted server-side when a provider needs them
   (utils/aiProviderRegistry.js) — the admin UI only ever sees masked values.
   --------------------------------------------------------------------- */
const AI_PROVIDER_IDS = ["groq", "anthropic", "ollama"];
const defaultApiKeys = () => ({
  paystackKey: "",
  activeAiProvider: "groq",
  groq: { apiKeyEnc: "", model: DEFAULT_MODELS.groq },
  anthropic: { apiKeyEnc: "", model: DEFAULT_MODELS.anthropic },
  ollama: { baseUrl: "http://localhost:11434", model: DEFAULT_MODELS.ollama },
});

router.get("/api-keys", requireAuth, requireSuperAdmin, (req, res) => {
  const keys = getSetting("apiKeys", defaultApiKeys());
  // Mask every provider's key before it ever reaches the client.
  const masked = { paystackKey: keys.paystackKey || "", activeAiProvider: keys.activeAiProvider || "groq" };
  AI_PROVIDER_IDS.forEach((id) => {
    const cfg = keys[id] || {};
    masked[id] = {
      ...cfg,
      apiKeyMasked: cfg.apiKeyEnc ? maskSecret(decryptSecret(cfg.apiKeyEnc)) : "",
      apiKeyEnc: undefined,
    };
  });
  res.json({ apiKeys: masked });
});

router.patch("/api-keys", requireAuth, requireSuperAdmin, (req, res) => {
  const { paystackKey, activeAiProvider, groq, anthropic, ollama } = req.body;
  const current = getSetting("apiKeys", defaultApiKeys());
  const nextProviderCfg = (id, incoming) => {
    const existing = current[id] || {};
    if (!incoming) return existing;
    const next = { ...existing };
    // Only overwrite the stored (encrypted) key when the admin actually
    // typed a new one — an empty/untouched field keeps the existing key.
    if (incoming.apiKey) next.apiKeyEnc = encryptSecret(String(incoming.apiKey).trim());
    if (incoming.model !== undefined) next.model = String(incoming.model).trim() || DEFAULT_MODELS[id];
    if (id === "ollama" && incoming.baseUrl !== undefined) next.baseUrl = String(incoming.baseUrl).trim() || "http://localhost:11434";
    return next;
  };
  setSetting("apiKeys", {
    paystackKey: paystackKey !== undefined ? String(paystackKey).trim() : current.paystackKey,
    activeAiProvider: AI_PROVIDER_IDS.includes(activeAiProvider) ? activeAiProvider : current.activeAiProvider || "groq",
    groq: nextProviderCfg("groq", groq),
    anthropic: nextProviderCfg("anthropic", anthropic),
    ollama: nextProviderCfg("ollama", ollama),
  });
  res.json({ ok: true });
});

// Verifies API key/endpoint + selected model + provider availability ONLY —
// never generates a quiz or touches lesson data.
router.post("/api-keys/test-connection", requireAuth, requireSuperAdmin, async (req, res) => {
  const providerId = AI_PROVIDER_IDS.includes(req.body.provider) ? req.body.provider : getSetting("apiKeys", defaultApiKeys()).activeAiProvider;
  const provider = getProvider(providerId);
  const result = await provider.healthCheck();
  res.json({ provider: provider.name, ...result });
});

/* ---------------------------------------------------------------------
   Admin: configurable assessment-type weights. Purely storage for now — no
   current grading or transcript calculation reads these yet. They're kept
   here (rather than a new table) since site_settings is already the
   generic key/value store the rest of Settings uses. New assessment types
   can be added to this object later without any schema/route change.
   --------------------------------------------------------------------- */
const defaultAssessmentWeights = () => ({
  aiQuiz: 10,
  continuousAssessment: 20,
  assignment: 10,
  project: 15,
  midtermExamination: 15,
  endOfTermExamination: 25,
  retakeExamination: 25,
});

router.get("/assessment-weights", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  res.json({ weights: getSetting("assessmentWeights", defaultAssessmentWeights()) });
});

router.patch("/assessment-weights", requireAuth, requireRole("admin"), (req, res) => {
  const current = getSetting("assessmentWeights", defaultAssessmentWeights());
  const next = { ...current };
  Object.entries(req.body || {}).forEach(([key, value]) => {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0) next[key] = num;
  });
  setSetting("assessmentWeights", next);
  res.json({ ok: true, weights: next });
});

module.exports = router;
