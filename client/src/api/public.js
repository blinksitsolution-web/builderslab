/* ==========================================================================
   Public landing-page API methods (Phase 9). Deliberately minimal — only
   the calls the legacy index.html makes (see Phase 1/9 analysis), all
   genuinely unauthenticated on the backend (no requireAuth middleware —
   server/src/routes/settings.js "/public", modules.js "/campuses/list",
   learningOfferings.js "/types/public"). Same paths, methods, and
   response shapes as api.js's DTL.publicSettings / DTL.campuses /
   DTL.publicOfferings.

   The module catalog (GET /api/modules) is intentionally NOT duplicated
   here — api/learner.js's fetchModules() already wraps that exact same
   public, unauthenticated endpoint (it's used both by the learner
   dashboard and, originally, by this landing page — see Phase 5), so
   this page imports it from there instead of redefining it.
   ========================================================================== */
import { apiGet, apiPost } from "./client";

export async function fetchPublicSettings() {
  return apiGet("/api/settings/public");
}

export async function fetchCampuses() {
  const { campuses } = await apiGet("/api/modules/campuses/list");
  return campuses;
}

export async function fetchPublicOfferings() {
  const { offerings } = await apiGet("/api/learning-offerings/types/public");
  return offerings;
}

/* --------------------------------------------------------------------
   Self-registration catalog (Group 1 — public registration/enrollment,
   migrated from register.html). Deliberately a distinct, smaller field
   set than fetchPublicOfferings() above — /types/registration additionally
   returns parentAccountRequired (per-type, drives the Parent+Child vs
   Adult tab routing) and is filtered to self-registration-eligible types
   only, matching DTL.publicRegistrationOfferings() exactly. Same
   unauthenticated backend routes register.html always called (see
   server/src/routes/learningOfferings.js, classes.js, modules.js).
   -------------------------------------------------------------------- */
export async function fetchRegistrationOfferings() {
  const { offerings } = await apiGet("/api/learning-offerings/types/registration");
  return offerings;
}

export async function fetchProgrammesFor({ offeringTypeId, offeringTypeSlug, audience } = {}) {
  const qs = new URLSearchParams();
  if (offeringTypeId) qs.set("offeringTypeId", offeringTypeId);
  if (offeringTypeSlug) qs.set("offeringTypeSlug", offeringTypeSlug);
  if (audience) qs.set("audience", audience);
  const { programmes } = await apiGet(`/api/learning-offerings/programmes/public?${qs.toString()}`);
  return programmes;
}

// deliveryMode ("ON_CAMPUS" | "ONLINE") is optional — omitting it (every
// pre-existing caller) returns every class under the programme unfiltered,
// exactly as before Delivery Mode existed. Each returned class also now
// carries deliveryMode/campusId/campusName (null for legacy/unspecified
// classes) — see server/src/routes/classes.js.
export async function fetchClassesFor(programmeId, deliveryMode) {
  const qs = new URLSearchParams({ programmeId });
  if (deliveryMode) qs.set("deliveryMode", deliveryMode);
  const { classes } = await apiGet(`/api/classes/public?${qs.toString()}`);
  return classes;
}

// GET /api/learning-offerings/programme-runs/registration-config — v31.
// ONE call that returns everything registration needs to progressively
// render for a Programme's current Active Programme Run: available
// Delivery Modes, eligible Campuses, Fee, whether Installments are
// enabled, Participation Structures, and Academic Structure/current
// Period — all sourced from the Run itself, not assembled by the frontend
// from fetchClassesFor()'s per-Class fields. { hasActiveRun: false } is
// the normal, non-error response for a Programme with no Active run
// configured — callers should treat that as "nothing to progressively
// reveal yet", the same as before this endpoint existed.
export async function fetchRegistrationConfigFor(programmeId, instanceId) {
  if (!programmeId) return { hasActiveRun: false };
  const qs = new URLSearchParams({ programmeId });
  if (instanceId) qs.set("instanceId", instanceId);
  return apiGet(`/api/learning-offerings/programme-runs/registration-config?${qs.toString()}`);
}

// GET /api/modules/open — only modules currently open for self-enrolment
// (courses run in a fixed season order — see register.html Step 2).
// Distinct from api/learner.js's fetchModules(), which returns every
// module unfiltered for the learner portal's own use.
export async function fetchOpenModules(programmeId) {
  const { courses } = await apiGet(`/api/modules/open${programmeId ? `?programmeId=${encodeURIComponent(programmeId)}` : ""}`);
  return courses;
}

// POST /api/auth/registration-fee-preview — public, no account required.
// Bug fix: the payment step used to show the flat Site Settings global fee
// the whole time (see RegisterPage.jsx), because the true, offering/
// programme/class-aware total only ever arrived from POST /register itself
// — i.e. only after the parent had already entered their Mobile Money
// number and hit Pay. This calls the exact same fee-resolution chain
// (registrationBreakdown, via the same classId fallback /register uses)
// ahead of time so the number on screen before payment can never disagree
// with what actually gets charged.
export async function fetchRegistrationFeePreview(payload) {
  return apiPost("/api/auth/registration-fee-preview", payload);
}
