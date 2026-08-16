import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AuthLayout from "./AuthLayout";
import LearnerBlock from "./LearnerBlock";
import { useAuth } from "../../context/AuthContext";
import { registerAccount, initiateRegistrationPayment } from "../../api/auth";
import { submitPaymentOtp, verifyPayment } from "../../api/parent";
import { fetchPublicSettings, fetchRegistrationOfferings, fetchProgrammesFor, fetchClassesFor, fetchOpenModules, fetchRegistrationFeePreview, fetchRegistrationConfigFor } from "../../api/public";
import { isValidEmail, isValidGhPhone, isValidContactPhone, isStrongPassword, passwordMessage } from "../../utils/validators";
import { COUNTRIES, DEFAULT_COUNTRY, countryName } from "../../utils/countries";
import { Button, Input, Select, FormField, Alert, Card, Checkbox } from "../../components/ui";
import styles from "./RegisterPage.module.css";

const NETWORKS = ["MTN", "Vodafone", "AirtelTigo"];
const MAX_POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 3000;
// sessionStorage key used to survive the full-page redirect to/from
// Paystack's hosted card checkout — see initiateChargeAndHandle and the
// resume-on-mount effect below.
const CARD_PAYMENT_RESUME_KEY = "bl_pending_card_payment";
let learnerBlockSeq = 0;
function emptyLearner() {
  return { key: `l${++learnerBlockSeq}`, name: "", age: "", campus: "", schoolName: "", ownRoboticsKit: false };
}

/**
 * Public registration/enrollment (Group 1 of the final non-admin
 * migration) — a full React port of legacy register.html's four-step
 * wizard: account details (Parent + Child, with multi-child support, or
 * Adult learner) -> module selection (Kids STEM only) -> Mobile Money
 * payment -> success/credentials. Same cascading Offering Type ->
 * Programme -> Batch/Cohort selection, the same server-calculated fee
 * breakdown, and the same payment initiate/OTP/verify-poll contract as
 * legacy — nothing recomputed or reinvented client-side (see
 * server/src/routes/auth.js, payments.js, learningOfferings.js).
 *
 * Mounted at /app/register (see routing/AppRoutes.jsx), inside the same
 * <AuthProvider> the login route uses, so a successful registration can
 * refresh() the session immediately (registerAccount() already signs the
 * caller in server-side — see auth.js issueSession()) without a full
 * page reload.
 *
 * offeringTypeSlug / programmeId / audience query params are honoured the
 * same way legacy's applyDeepLinkSelection() did, for the landing page's
 * per-offering "Enrol now" links (see pages/public/publicUtils.js).
 *
 * Not ported: the purely informational "Bootcamp now open" ad panel
 * legacy showed above Step 1 (loadBootcampAd()) — cosmetic only, doesn't
 * affect any registration data or backend contract. See Group 1 final
 * report for this and other noted limitations.
 */
export default function RegisterPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [step, setStep] = useState(1);
  const [regType, setRegType] = useState("parent-learner");
  const [catalogStatus, setCatalogStatus] = useState("loading"); // "loading" | "ready" | "error"

  // ---- site settings (payment accounts / campuses) ------------------------
  const [paymentAccounts, setPaymentAccounts] = useState([]);
  const [campusOptions, setCampusOptions] = useState([]);

  // ---- registration offering catalog --------------------------------------
  const [registrationOfferings, setRegistrationOfferings] = useState([]);
  const parentOfferingTypes = useMemo(
    () => registrationOfferings.filter((t) => t.parentAccountRequired === "yes" || t.parentAccountRequired === "optional"),
    [registrationOfferings]
  );
  // ABRS v2.1 Phase 1 audit, Category 1: was `registrationOfferings.find((t)
  // => t.slug === "kids_stem")`. The default/classic parent-facing offering
  // is now whichever eligible offering the backend ranks first
  // (sort_order — GET /types/registration already orders this way, the same
  // "lowest sort_order active row" convention offeringTypeSettings.js's
  // getDefaultProgrammeForOfferingSlug uses server-side), not a literal
  // identifier comparison. For today's data this still resolves to Kids
  // STEM, since it is seeded at sort_order 0.
  const defaultParentOfferingType = parentOfferingTypes[0] || null;
  const adultOfferingTypes = useMemo(
    () => registrationOfferings.filter((t) => t.parentAccountRequired === "no" || t.parentAccountRequired === "optional"),
    [registrationOfferings]
  );
  const parentOfferingPickerVisible = parentOfferingTypes.length > 1;
  const adultOfferingPickerVisible = adultOfferingTypes.length > 0;

  // ---- Parent + Child fields ------------------------------------------------
  const [parentName, setParentName] = useState("");
  const [parentEmail, setParentEmail] = useState("");
  const [parentPhone, setParentPhone] = useState("");
  // ISO 3166-1 alpha-2 (see utils/countries.js). Ghana-selected is the
  // only path with a working payment method today (see Step 3's payment-
  // boundary notice) — everything else is contact-info-only for now.
  const [parentCountry, setParentCountry] = useState(DEFAULT_COUNTRY);
  const [parentTown, setParentTown] = useState("");
  const [parentPassword, setParentPassword] = useState("");
  const [parentPasswordConfirm, setParentPasswordConfirm] = useState("");
  const [learners, setLearners] = useState([emptyLearner()]);

  const [parentOfferingId, setParentOfferingId] = useState("");
  const [parentProgrammes, setParentProgrammes] = useState([]);
  const [parentProgrammeId, setParentProgrammeId] = useState("");
  const [parentClasses, setParentClasses] = useState([]);
  const [parentClassId, setParentClassId] = useState("");
  // §11/§17/§18 — the Operational Group (batch/cohort/section) selected
  // for this registration, if the Run has any configured. Entirely
  // separate from parentClassId (Programme Level) — never conflated, and
  // the picker below only ever appears once a Programme Run's own
  // Operational Groups are known (parentRunConfig.operationalGroups).
  const [parentOperationalGroupId, setParentOperationalGroupId] = useState("");
  // Renamed from parentSelectedIsKidsStem (ABRS v2.1 Phase 1 audit,
  // Category 1) — this tracks whether the currently-selected parent-facing
  // offering requires choosing individual Courses up front, not "is this
  // Kids STEM". Defaults `true` to preserve the pre-catalog-load classic
  // flow's existing behaviour (see registrationOfferings above).
  const [parentRequiresCourseSelection, setParentRequiresCourseSelection] = useState(true);
  // Delivery Mode ("ON_CAMPUS" | "ONLINE") — only ever relevant once the
  // selected Programme actually has classes carrying a delivery_mode (see
  // parentDeliveryModes below). Kids STEM's classic Foundation/Framework/
  // Skyline classes have no delivery_mode, so this never surfaces for that
  // flow — byte-for-byte unchanged.
  const [parentDeliveryMode, setParentDeliveryMode] = useState("");
  // Programme Run operational configuration (v31/v32) — the single source
  // of truth this page now consumes for progressive disclosure (available
  // Delivery Modes, eligible Campuses, whether Installments are enabled)
  // instead of inferring Delivery Mode purely from whichever individual
  // Classes happen to carry one. { hasActiveRun: false } (the endpoint's
  // own "nothing configured yet" shape) is the default/no-op state, so a
  // Programme with no Active Run behaves exactly as before this existed —
  // see fetchRegistrationConfigFor's own doc comment in api/public.js.
  const [parentRunConfig, setParentRunConfig] = useState({ hasActiveRun: false });
  // Registration Source of Truth: distinguishes "haven't fetched the Run
  // config yet" (default state above) from "fetched it, and there is
  // genuinely no Active Programme Run" — only the latter should block the
  // form and show the "no registration opportunities" message.
  const [parentRunConfigLoaded, setParentRunConfigLoaded] = useState(false);
  // ABRS v2.2 amendment (concurrent Programme Runs) — when a Programme has
  // more than one Active Run, fetchRegistrationConfigFor comes back as
  // { multipleActiveRuns: true, activeRuns: [...] } instead of a full
  // config. parentSelectedInstanceId holds the run the parent picks from
  // that list; choosing one triggers a second fetch (with instanceId set)
  // that returns the normal full config, exactly as the single-Run case
  // always has. Submitted alongside operationalGroupId as
  // learningInstanceId so the server never has to guess either.
  const [parentSelectedInstanceId, setParentSelectedInstanceId] = useState("");
  // Builders' Lab participation structure (v29) — which of the three
  // participation models this registration is for. Optional (backend
  // already defaults to NULL/"unspecified" when omitted); only surfaced
  // for the Kids STEM parent-learner path, since the three options
  // (structured_school_club / structured_other / individual_course) are
  // specifically the Builders' Lab structured-journey-vs-one-course
  // distinction, not a concept the Adult/Bootcamp/Corporate paths use.
  const [parentParticipationStructure, setParentParticipationStructure] = useState("");

  // ---- Adult learner fields --------------------------------------------------
  const [adultName, setAdultName] = useState("");
  const [adultEmail, setAdultEmail] = useState("");
  const [adultPhone, setAdultPhone] = useState("");
  const [adultCountry, setAdultCountry] = useState(DEFAULT_COUNTRY);
  const [adultTown, setAdultTown] = useState("");
  const [adultPassword, setAdultPassword] = useState("");
  const [adultPasswordConfirm, setAdultPasswordConfirm] = useState("");
  const [adultEducationLevel, setAdultEducationLevel] = useState("None");
  const [adultCampus, setAdultCampus] = useState("");
  const [adultOwnKit, setAdultOwnKit] = useState(false);

  // Which country field is "live" depends on which tab is active — used by
  // Step 1's phone validation and Step 3's payment-method boundary. Ghana
  // is the only country with a working payment path today.
  const registrantCountry = regType === "parent-learner" ? parentCountry : adultCountry;
  const isGhanaRegistrant = registrantCountry === DEFAULT_COUNTRY;

  const [adultOfferingId, setAdultOfferingId] = useState("");
  const [adultProgrammes, setAdultProgrammes] = useState([]);
  const [adultProgrammeId, setAdultProgrammeId] = useState("");
  const [adultClasses, setAdultClasses] = useState([]);
  const [adultClassId, setAdultClassId] = useState("");
  const [adultOperationalGroupId, setAdultOperationalGroupId] = useState("");
  const [adultDeliveryMode, setAdultDeliveryMode] = useState("");
  const [adultRunConfig, setAdultRunConfig] = useState({ hasActiveRun: false });
  const [adultRunConfigLoaded, setAdultRunConfigLoaded] = useState(false);
  // Same concurrent-Runs picker state as the parent-learner path above.
  const [adultSelectedInstanceId, setAdultSelectedInstanceId] = useState("");

  // ---- Step 2 (modules) -------------------------------------------------------
  const [modules, setModules] = useState([]);
  const [selectedModuleIds, setSelectedModuleIds] = useState([]);
  const [skipModuleStep, setSkipModuleStep] = useState(false);

  // ---- errors -----------------------------------------------------------------
  const [step1Error, setStep1Error] = useState("");
  const [step2Error, setStep2Error] = useState("");
  const [step3Error, setStep3Error] = useState("");
  const [show409LoginHint, setShow409LoginHint] = useState(false);

  // ---- payment/account-creation state -----------------------------------------
  const [network, setNetwork] = useState("MTN");
  const [momoNumber, setMomoNumber] = useState("");
  const [otp, setOtp] = useState("");
  const [payStage, setPayStage] = useState("form"); // "form" | "otp" | "polling"
  // Standalone confirmation shown instead of the wizard below when this page
  // is reached via a card-payment redirect that did NOT originate from
  // registration (see the resume effect a few lines down). null the rest
  // of the time, so it never affects the normal registration flow.
  const [genericResume, setGenericResume] = useState(null); // { kind: "monthly" | "enrolment" | "period", status: "polling" | "success" | "failed" } | null
  const [payMessage, setPayMessage] = useState("");
  const [payBusy, setPayBusy] = useState(false);
  const [accountCreated, setAccountCreated] = useState(false);
  const [feeBreakdown, setFeeBreakdown] = useState(null);
  const [feeTotal, setFeeTotal] = useState(null);
  // Pre-account-creation estimate (see fetchRegistrationFeePreview) — shown
  // on the payment step until the real, authoritative feeBreakdown/feeTotal
  // come back from POST /register itself. Both are computed by the exact
  // same registrationBreakdown() fee-resolution chain server-side, so they
  // should always agree; this just fills the gap before an account exists.
  const [previewBreakdown, setPreviewBreakdown] = useState(null);
  const [previewTotal, setPreviewTotal] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const accountIdRef = useRef(null); // parentId or learnerId to charge
  const paymentReferenceRef = useRef(null);
  const awaitingOtpRef = useRef(false);
  const pollRef = useRef(null);
  const pollAttemptsRef = useRef(0);
  const allLearnersRef = useRef(null); // credentials for step 4

  // ---- step 4 -------------------------------------------------------------------
  const [outcome, setOutcome] = useState(null); // { paymentSucceeded, allLearners }

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Resume after returning from Paystack's hosted card checkout. A full
  // browser redirect there and back reloads this SPA, so none of the
  // in-memory registration state (accountIdRef, allLearnersRef, step,
  // ...) survives — only the sessionStorage snapshot written just before
  // the redirect (see initiateChargeAndHandle) and whatever Paystack
  // appends to the callback URL do. Paystack always appends its own
  // `reference` (and `trxref`) query params to the callback_url it was
  // given (routes/payments.js) — never trusted on their own: they only
  // tell us WHICH payment to ask the server about, not whether it
  // succeeded. The actual status still comes from the existing
  // verify/poll flow (verifyPayment / startPolling), exactly as it does
  // for Mobile Money. If sessionStorage's reference doesn't match the
  // URL's (or is missing — a different tab, a cleared session), this
  // intentionally does nothing rather than resuming the wrong payment.
  useEffect(() => {
    const returnedReference = searchParams.get("reference") || searchParams.get("trxref");
    if (!returnedReference) return;
    let saved = null;
    try {
      const raw = sessionStorage.getItem(CARD_PAYMENT_RESUME_KEY);
      saved = raw ? JSON.parse(raw) : null;
    } catch {
      saved = null;
    }
    if (!saved || saved.reference !== returnedReference) return;

    sessionStorage.removeItem(CARD_PAYMENT_RESUME_KEY);
    // Strip Paystack's query params so a page refresh doesn't re-trigger this.
    navigate("/app/register", { replace: true });

    // Card payments started from an existing account's own dashboard (this
    // month's fee, an additional-programme enrolment, or a specific
    // Academic Period's outstanding balance — see
    // pages/parent/PayMonthlyFeeModal.jsx, PayEnrolmentModal.jsx and
    // PayPeriodModal.jsx) share this exact redirect/resume mechanism,
    // since routes/payments.js sends every CARD charge back through this
    // same callback_url regardless of where it was started. Those flows
    // tag their sessionStorage entry with `kind` so they resume here as a
    // small standalone confirmation instead of re-entering (and
    // misrepresenting) the registration wizard below, which assumes a
    // brand-new account/credentials to show.
    if (saved.kind === "monthly" || saved.kind === "enrolment" || saved.kind === "period") {
      setGenericResume({ kind: saved.kind, status: "polling" });
      pollGenericPayment(returnedReference);
      return;
    }

    accountIdRef.current = saved.accountId;
    allLearnersRef.current = saved.allLearners || null;
    if (saved.regType) setRegType(saved.regType);
    paymentReferenceRef.current = returnedReference;
    setAccountCreated(true);
    setStep(3);
    setPayBusy(true);
    refresh();
    startPolling(returnedReference, "CARD");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- initial catalog load ------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, offerings] = await Promise.all([fetchPublicSettings(), fetchRegistrationOfferings()]);
        if (cancelled) return;
        setPaymentAccounts(settings.paymentAccounts || []);
        setCampusOptions((settings.campuses || []).map((c) => c.name));
        setRegistrationOfferings(offerings || []);
        setCatalogStatus("ready");
      } catch (e) {
        if (!cancelled) setCatalogStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Once offerings are loaded: pre-select the default offering in the
  // parent offering picker (matches legacy's `selected` default) or, in the
  // classic single-offering case, load that offering's own programme list
  // directly — then apply any deep-link query params. Also seeds the adult
  // offering field. Mirrors register.html's
  // initPage()/applyDeepLinkSelection().
  useEffect(() => {
    if (catalogStatus !== "ready") return;
    let cancelled = false;
    (async () => {
      try {
        if (parentOfferingPickerVisible) {
          const initialId = defaultParentOfferingType?.id || "";
          if (initialId) await handleParentOfferingChange(initialId);
        } else if (defaultParentOfferingType) {
          const programmes = await fetchProgrammesFor({ offeringTypeId: defaultParentOfferingType.id });
          if (cancelled) return;
          setParentProgrammes(programmes);
          setParentRequiresCourseSelection(!!defaultParentOfferingType.requiresCourseSelectionAtRegistration);
          // Registration Source of Truth: proactively resolve whether this
          // (usually the only) Kids STEM programme actually has an Active
          // Programme Run, instead of only finding out at submit time.
          if (programmes.length === 1) {
            await handleParentProgrammeChange(programmes[0].id);
          }
        }
      } catch (e) {
        /* both flows still work with no programme pre-selected */
      }
      if (!cancelled) applyDeepLinkSelection();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogStatus]);

  async function applyDeepLinkSelection() {
    const slug = searchParams.get("offeringTypeSlug");
    const programmeIdParam = searchParams.get("programmeId");
    const audienceParam = searchParams.get("audience");
    if (!slug && !audienceParam) return;
    const wantsAdult = audienceParam === "adult";

    const parentMatch = !wantsAdult && slug ? parentOfferingTypes.find((t) => t.slug === slug) : null;
    if (parentMatch && parentOfferingPickerVisible) {
      setRegType("parent-learner");
      await handleParentOfferingChange(parentMatch.id, programmeIdParam || undefined);
      return;
    }
    // No-picker case: there's exactly one parent-eligible offering, so a
    // deep link naming that same offering by slug can apply its
    // programmeId directly (was `slug === "kids_stem"` — ABRS v2.1 Phase 1
    // audit, Category 1).
    const matchesTheOnlyOffering = !parentOfferingPickerVisible && parentOfferingTypes.some((t) => t.slug === slug);
    if (!wantsAdult && matchesTheOnlyOffering && programmeIdParam) {
      setParentProgrammeId(programmeIdParam);
      return;
    }
    const adultMatch = slug ? adultOfferingTypes.find((t) => t.slug === slug) : null;
    if (adultMatch) {
      setRegType("adult");
      await handleAdultOfferingChange(adultMatch.id, programmeIdParam || undefined);
      return;
    }
    if (audienceParam === "adult" || audienceParam === "parent-learner") {
      setRegType(audienceParam);
    }
  }

  // ---- cascading selection handlers ------------------------------------------

  async function handleParentOfferingChange(offeringId, preselectProgrammeId) {
    setParentOfferingId(offeringId);
    setParentClassId("");
    setParentClasses([]);
    if (!offeringId) {
      setParentProgrammes([]);
      return;
    }
    const type = parentOfferingTypes.find((t) => t.id === offeringId);
    const programmes = await fetchProgrammesFor({ offeringTypeId: offeringId, audience: "parent-learner" });
    setParentProgrammes(programmes);
    setParentRequiresCourseSelection(!!(type && type.requiresCourseSelectionAtRegistration));
    if (preselectProgrammeId) {
      setParentProgrammeId(preselectProgrammeId);
      await handleParentProgrammeChange(preselectProgrammeId, programmes);
    } else {
      setParentProgrammeId("");
      setParentRunConfig({ hasActiveRun: false });
      setParentRunConfigLoaded(false);
    }
  }

  async function handleParentProgrammeChange(programmeId, programmesList) {
    setParentProgrammeId(programmeId);
    setParentClassId("");
    setParentDeliveryMode("");
    setParentOperationalGroupId("");
    setParentSelectedInstanceId("");
    if (!programmeId) {
      setParentClasses([]);
      setParentRunConfig({ hasActiveRun: false });
      setParentRunConfigLoaded(false);
      return;
    }
    const [classes, runConfig] = await Promise.all([fetchClassesFor(programmeId), fetchRegistrationConfigFor(programmeId)]);
    setParentClasses(classes);
    setParentRunConfig(runConfig || { hasActiveRun: false });
    // ABRS v2.2 amendment (concurrent Programme Runs): multipleActiveRuns
    // means the parent must pick a run before there's a full config to
    // progressively disclose — leave parentRunConfigLoaded false (same
    // "haven't resolved a usable config yet" state as still-loading)
    // until handleParentInstanceChoice below resolves one.
    setParentRunConfigLoaded(!runConfig?.multipleActiveRuns);
    // Individual Course Registration fix: the exactly-one-Active-Run case
    // never shows the "which run?" picker (only rendered when
    // multipleActiveRuns is true), so handleParentInstanceChoice below was
    // never called and parentSelectedInstanceId stayed "" — even though
    // the config response already resolved and returned that one Run's
    // instanceId right here. The final registration request then sent
    // learningInstanceId: undefined, which the backend correctly rejects
    // for Individual Course registration ("learningInstanceId is required
    // for Individual Course registration."). Copy it over immediately so
    // every hasActiveRun response (one Run OR a Run just chosen from the
    // multi-Run picker) leaves parentSelectedInstanceId holding a valid
    // id; the multiple-Active-Runs case still correctly starts/resets to
    // "" here since runConfig.instanceId is absent on that response shape
    // (see the hasActiveRun: false, multipleActiveRuns: true branch of
    // GET .../registration-config above).
    setParentSelectedInstanceId(runConfig?.hasActiveRun ? runConfig.instanceId || "" : "");
    // Progressive disclosure: exactly one Delivery Mode configured on the
    // Run -> auto-select it, nothing to ask the parent.
    if (runConfig?.hasActiveRun && runConfig.deliveryModes?.length === 1) {
      setParentDeliveryMode(runConfig.deliveryModes[0]);
    }
  }

  // Called once the parent picks a specific run from parentRunConfig's
  // activeRuns list (only rendered when multipleActiveRuns is true).
  // Re-fetches the full config scoped to that run — from here on the
  // form behaves exactly like the single-Run case always has.
  async function handleParentInstanceChoice(instanceId) {
    setParentSelectedInstanceId(instanceId);
    setParentOperationalGroupId("");
    if (!instanceId) return;
    const runConfig = await fetchRegistrationConfigFor(parentProgrammeId, instanceId);
    setParentRunConfig(runConfig || { hasActiveRun: false });
    setParentRunConfigLoaded(true);
    if (runConfig?.hasActiveRun && runConfig.deliveryModes?.length === 1) {
      setParentDeliveryMode(runConfig.deliveryModes[0]);
    }
  }

  async function handleAdultOfferingChange(offeringId, preselectProgrammeId) {
    setAdultOfferingId(offeringId);
    setAdultClassId("");
    setAdultClasses([]);
    setAdultOperationalGroupId("");
    if (!offeringId) {
      setAdultProgrammes([]);
      return;
    }
    const programmes = await fetchProgrammesFor({ offeringTypeId: offeringId, audience: "adult" });
    setAdultProgrammes(programmes);
    if (preselectProgrammeId) {
      setAdultProgrammeId(preselectProgrammeId);
      await handleAdultProgrammeChange(preselectProgrammeId);
    } else {
      setAdultProgrammeId("");
      setAdultRunConfig({ hasActiveRun: false });
      setAdultRunConfigLoaded(false);
    }
  }

  async function handleAdultProgrammeChange(programmeId) {
    setAdultProgrammeId(programmeId);
    setAdultClassId("");
    setAdultDeliveryMode("");
    setAdultOperationalGroupId("");
    setAdultSelectedInstanceId("");
    if (!programmeId) {
      setAdultClasses([]);
      setAdultRunConfig({ hasActiveRun: false });
      setAdultRunConfigLoaded(false);
      return;
    }
    const [classes, runConfig] = await Promise.all([fetchClassesFor(programmeId), fetchRegistrationConfigFor(programmeId)]);
    setAdultClasses(classes);
    setAdultRunConfig(runConfig || { hasActiveRun: false });
    setAdultRunConfigLoaded(!runConfig?.multipleActiveRuns);
    // Individual Course Registration fix — adult equivalent of the same
    // fix in handleParentProgrammeChange above: copy the resolved Run's
    // instanceId into adultSelectedInstanceId as soon as it's known,
    // rather than only when the multi-Run picker calls
    // handleAdultInstanceChoice. See that function's comment for the
    // full rationale.
    setAdultSelectedInstanceId(runConfig?.hasActiveRun ? runConfig.instanceId || "" : "");
    if (runConfig?.hasActiveRun && runConfig.deliveryModes?.length === 1) {
      setAdultDeliveryMode(runConfig.deliveryModes[0]);
    }
  }

  // Adult equivalent of handleParentInstanceChoice above.
  async function handleAdultInstanceChoice(instanceId) {
    setAdultSelectedInstanceId(instanceId);
    setAdultOperationalGroupId("");
    if (!instanceId) return;
    const runConfig = await fetchRegistrationConfigFor(adultProgrammeId, instanceId);
    setAdultRunConfig(runConfig || { hasActiveRun: false });
    setAdultRunConfigLoaded(true);
    if (runConfig?.hasActiveRun && runConfig.deliveryModes?.length === 1) {
      setAdultDeliveryMode(runConfig.deliveryModes[0]);
    }
  }

  // parentPathRequiresCourseSelection(): does the currently-selected (or,
  // in the no-picker classic-flow case, default) parent-facing offering
  // require choosing individual Courses up front? Registration Experience
  // Redesign: now defers to parentStructureRequiresCourseSelection, which
  // reads the resolved Participation Structure's own config (§10.2) once
  // one has resolved, rather than a single static per-Offering-Type flag
  // that couldn't distinguish "individual_course" from the two structured
  // journeys within the same Offering Type.
  function parentPathRequiresCourseSelection() {
    return parentStructureRequiresCourseSelection;
  }

  // Delivery Mode only ever needs to be shown when the programme's classes
  // actually carry one — every legacy programme (no admin has configured
  // Delivery Mode on any of its classes yet) has parentClasses/adultClasses
  // all with deliveryMode: null, so these are empty and nothing changes
  // for that programme's registration flow.
  // Delivery Mode options: the Programme Run's own configured Delivery
  // Modes (registration-config, the architecture's actual source of truth
  // for this — see migrate.js's v31 comment) take priority once a Run
  // exists. Falls back to inferring from whichever individual Classes
  // happen to carry a deliveryMode only for a Programme with no Active Run
  // configured yet, which keeps every pre-v31/legacy programme's
  // registration flow working exactly as before.
  const parentDeliveryModes = useMemo(() => {
    if (parentRunConfig?.hasActiveRun && parentRunConfig.deliveryModes?.length) return parentRunConfig.deliveryModes;
    return Array.from(new Set(parentClasses.map((c) => c.deliveryMode).filter(Boolean)));
  }, [parentRunConfig, parentClasses]);
  const parentVisibleClasses = parentDeliveryModes.length
    ? parentClasses.filter((c) => c.deliveryMode === parentDeliveryMode)
    : parentClasses;
  const parentSelectedClass = parentClasses.find((c) => c.id === parentClassId) || null;
  // Progressive disclosure: exactly one Batch/Cohort available for the
  // chosen Programme (+ Delivery Mode, once relevant) -> auto-select it,
  // nothing to ask.
  useEffect(() => {
    if (!parentClassId && parentVisibleClasses.length === 1) {
      setParentClassId(parentVisibleClasses[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentVisibleClasses]);
  // Campus options: the Run's own eligible Campuses (registration-config)
  // once one is selected and On-Campus/Hybrid is in play; the Batch/Cohort
  // itself still wins when it carries its own explicit campus (unchanged
  // per-Class override — see resolveCampusForRegistration server-side).
  const parentRunCampusOptions = parentRunConfig?.hasActiveRun ? (parentRunConfig.campuses || []).map((c) => c.name) : [];
  useEffect(() => {
    if (parentSelectedClass?.deliveryMode) return; // the Class itself already carries a fixed campus
    if (parentDeliveryMode === "ONLINE") return;
    if (parentRunCampusOptions.length !== 1) return;
    const only = parentRunCampusOptions[0];
    setLearners((current) => (current.some((l) => !l.campus) ? current.map((l) => (l.campus ? l : { ...l, campus: only })) : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentRunCampusOptions, parentDeliveryMode, parentSelectedClass]);

  // Registration Experience Redesign — Participation Structures are no
  // longer a hardcoded 3-option enum in this page; they're read from this
  // Programme's own configuration (registration-config's
  // participationStructureOptions — see getEffectiveProgrammeParticipation
  // Structures server-side), which is what §10.2/§2.2 actually require:
  // course-selection requirement, whether the structure uses Programme
  // Levels, and the registrant role all come from that Programme's config,
  // never a hardcoded string comparison in this component.
  const parentParticipationOptions = parentRunConfig?.hasActiveRun ? parentRunConfig.participationStructureOptions || [] : [];
  // Progressive disclosure: exactly one Participation Structure configured
  // for this Programme -> auto-select it, nothing to ask.
  useEffect(() => {
    if (!parentParticipationStructure && parentParticipationOptions.length === 1) {
      setParentParticipationStructure(parentParticipationOptions[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentParticipationOptions]);
  const parentSelectedStructure = parentParticipationOptions.find((s) => s.key === parentParticipationStructure) || null;
  // Once this Programme's own config resolves a Participation Structure,
  // that structure's own requiresCourseSelection flag is authoritative
  // (§10.2) — falls back to the legacy per-Offering-Type flag only when no
  // structure has been resolved yet (e.g. config not loaded, or this
  // Programme has no Active Run to resolve one against), which keeps every
  // pre-existing flow working unchanged until this resolves.
  const parentStructureRequiresCourseSelection = parentSelectedStructure ? parentSelectedStructure.requiresCourseSelection : parentRequiresCourseSelection;
  // §11.2 — "Parents never choose a Programme Level": once the selected
  // Participation Structure is one that uses Programme Levels (Builders'
  // Lab's structured journeys), the Batch/Cohort ("Class") picker below is
  // hidden entirely and no classId is ever sent — the backend's own
  // resolveEntryClass() auto-assigns the Foundation Programme Level, the
  // single source of truth for that assignment (routes/auth.js).
  const parentUsesProgrammeLevels = !!parentSelectedStructure?.usesProgrammeLevels;
  const parentEntryLevelName = parentRunConfig?.hasActiveRun ? parentRunConfig.entryLevel?.className : null;
  // §11/§17/§18 — this Run's active Operational Groups, if any (empty for
  // the common case of a Run with none configured — the picker below
  // simply never renders then, identical to today's behaviour).
  const parentOperationalGroups = parentRunConfig?.hasActiveRun ? parentRunConfig.operationalGroups || [] : [];
  useEffect(() => {
    if (!parentOperationalGroupId && parentOperationalGroups.length === 1) {
      setParentOperationalGroupId(parentOperationalGroups[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentOperationalGroups]);

  const adultDeliveryModes = useMemo(() => {
    if (adultRunConfig?.hasActiveRun && adultRunConfig.deliveryModes?.length) return adultRunConfig.deliveryModes;
    return Array.from(new Set(adultClasses.map((c) => c.deliveryMode).filter(Boolean)));
  }, [adultRunConfig, adultClasses]);
  const adultVisibleClasses = adultDeliveryModes.length
    ? adultClasses.filter((c) => c.deliveryMode === adultDeliveryMode)
    : adultClasses;
  const adultSelectedClass = adultClasses.find((c) => c.id === adultClassId) || null;
  useEffect(() => {
    if (!adultClassId && adultVisibleClasses.length === 1) {
      setAdultClassId(adultVisibleClasses[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adultVisibleClasses]);
  const adultRunCampusOptions = adultRunConfig?.hasActiveRun ? (adultRunConfig.campuses || []).map((c) => c.name) : [];
  const adultOperationalGroups = adultRunConfig?.hasActiveRun ? adultRunConfig.operationalGroups || [] : [];
  useEffect(() => {
    if (!adultOperationalGroupId && adultOperationalGroups.length === 1) {
      setAdultOperationalGroupId(adultOperationalGroups[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adultOperationalGroups]);
  // Registration Source of Truth: once a specific Programme's Run config
  // has actually been fetched (parentRunConfigLoaded), a confirmed
  // hasActiveRun: false means there is genuinely no registration
  // opportunity right now — surfaced up front rather than only at submit.
  const parentRegistrationBlocked = !!(parentProgrammeId && parentRunConfigLoaded && parentRunConfig && parentRunConfig.hasActiveRun === false);
  const adultRegistrationBlocked = !!(adultOfferingPickerVisible && adultProgrammeId && adultRunConfigLoaded && adultRunConfig && adultRunConfig.hasActiveRun === false);
  // Auto-select the campus once it's the only one configured for this Run
  // and On-Campus/Hybrid is actually the Delivery Mode in play (Online
  // never shows a campus at all — see the render logic below).
  useEffect(() => {
    if (adultCampus) return;
    if (adultSelectedClass?.deliveryMode) return; // the Class itself already carries a fixed campus
    if (adultDeliveryMode === "ONLINE") return;
    if (adultRunCampusOptions.length === 1) setAdultCampus(adultRunCampusOptions[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adultRunCampusOptions, adultDeliveryMode, adultSelectedClass]);

  function handleParentDeliveryModeChange(mode) {
    setParentDeliveryMode(mode);
    setParentClassId("");
  }
  function handleAdultDeliveryModeChange(mode) {
    setAdultDeliveryMode(mode);
    setAdultClassId("");
  }

  // ---- learner block handlers ------------------------------------------------
  function updateLearner(index, next) {
    setLearners((current) => current.map((l, i) => (i === index ? next : l)));
  }
  function addLearner() {
    setLearners((current) => [...current, emptyLearner()]);
  }
  function removeLearner(index) {
    setLearners((current) => current.filter((_, i) => i !== index));
  }

  // ---- Step 1 -> Step 2/3 -------------------------------------------------------
  async function goStep2() {
    setStep1Error("");
    let programmeIdForModules;
    let willSkipModuleStep = false;

    if (regType === "parent-learner") {
      if (!parentName.trim() || !parentEmail.trim() || !parentPhone.trim() || !parentPassword) {
        setStep1Error("Fill in every parent field.");
        return;
      }
      if (!parentTown.trim()) return setStep1Error("Enter your town/city of residence.");
      if (!isValidEmail(parentEmail)) return setStep1Error("Enter a valid email address.");
      if (!isValidContactPhone(parentPhone, parentCountry)) {
        return setStep1Error(
          parentCountry === DEFAULT_COUNTRY
            ? "Enter a valid 10-digit phone number, e.g. 0501234567."
            : "Enter a valid phone number, including the country code (e.g. +14155550123)."
        );
      }
      if (!isStrongPassword(parentPassword)) return setStep1Error(passwordMessage(parentPassword));
      if (parentPassword !== parentPasswordConfirm) return setStep1Error("Your password and confirmation don't match.");
      if (learners.length === 0) return setStep1Error("Add at least one child.");
      for (const l of learners) {
        if (!l.name.trim()) return setStep1Error("Every child needs a name.");
        if (l.age !== "" && l.age !== null && l.age !== undefined) {
          const ageNum = Number(l.age);
          if (!Number.isInteger(ageNum) || ageNum < 3 || ageNum > 21) {
            return setStep1Error(`${l.name}'s age must be a whole number between 3 and 21 (leave blank if unsure).`);
          }
        }
      }

      if (parentOfferingPickerVisible) {
        if (!parentOfferingId || !parentProgrammeId) {
          return setStep1Error("Select what you're registering your child for, and a Programme.");
        }
        if (!parentPathRequiresCourseSelection()) {
          if (parentDeliveryModes.length && !parentDeliveryMode) {
            return setStep1Error("Select a delivery mode (Online or On-Campus).");
          }
          if (!parentUsesProgrammeLevels && !parentClassId) return setStep1Error("Select a Batch/Cohort.");
        }
        programmeIdForModules = parentProgrammeId;
      } else if (parentProgrammes.length > 1) {
        programmeIdForModules = parentProgrammeId;
      }
      if (parentRegistrationBlocked) {
        return setStep1Error("There are currently no available registration opportunities for this programme — an admin hasn't opened registration yet.");
      }
      willSkipModuleStep = !parentPathRequiresCourseSelection();
    } else {
      if (!adultName.trim() || !adultEmail.trim() || !adultPhone.trim() || !adultPassword) {
        setStep1Error("Fill in every field.");
        return;
      }
      if (!adultTown.trim()) return setStep1Error("Enter your town/city of residence.");
      if (!isValidEmail(adultEmail)) return setStep1Error("Enter a valid email address.");
      if (!isValidContactPhone(adultPhone, adultCountry)) {
        return setStep1Error(
          adultCountry === DEFAULT_COUNTRY
            ? "Enter a valid 10-digit phone number, e.g. 0501234567."
            : "Enter a valid phone number, including the country code (e.g. +14155550123)."
        );
      }
      if (!isStrongPassword(adultPassword)) return setStep1Error(passwordMessage(adultPassword));
      if (adultPassword !== adultPasswordConfirm) return setStep1Error("Your password and confirmation don't match.");
      if (adultOfferingPickerVisible) {
        if (!adultOfferingId || !adultProgrammeId) {
          return setStep1Error("Select what you're enrolling in and a Programme.");
        }
        if (adultDeliveryModes.length && !adultDeliveryMode) {
          return setStep1Error("Select a delivery mode (Online or On-Campus).");
        }
        if (!adultClassId) return setStep1Error("Select a Batch/Cohort.");
        programmeIdForModules = adultProgrammeId;
      }
      if (adultRegistrationBlocked) {
        return setStep1Error("There are currently no available registration opportunities for this programme — an admin hasn't opened registration yet.");
      }
      willSkipModuleStep = true; // Adult tab never shows the module step
    }

    setSkipModuleStep(willSkipModuleStep);
    if (willSkipModuleStep) {
      setStep(3);
      return;
    }
    try {
      const openModules = await fetchOpenModules(programmeIdForModules);
      setModules(openModules);
    } catch (e) {
      setModules([]);
    }
    setStep(2);
  }

  function toggleModule(id) {
    setSelectedModuleIds((current) => (current.includes(id) ? current.filter((m) => m !== id) : [...current, id]));
  }

  function goStep3() {
    setStep2Error("");
    if (selectedModuleIds.length === 0) {
      setStep2Error("Pick at least one module.");
      return;
    }
    setStep(3);
  }

  // Bug fix: this used to be missing entirely, which is why the payment
  // step's "Registration total" fell back to the flat Site Settings global
  // fee (see the `fees` state above) for as long as the parent/adult sat on
  // that screen — an Offering-Type-specific, per-Programme, or per-Batch/
  // Cohort fee set via the admin's Offering Type Settings > Fees (or a
  // Learning Group's own fee) never showed up until *after* they'd already
  // entered their Mobile Money number and hit Pay, because the true total
  // only ever came from POST /register's own response. This fetches the
  // same registrationBreakdown() computation ahead of time via the new
  // public /api/auth/registration-fee-preview endpoint, using the exact
  // same programmeId/classId resolution handlePaySubmit sends, so the
  // number on screen matches what's actually going to be charged.
  useEffect(() => {
    if (step !== 3 || accountCreated) return;
    let cancelled = false;
    setPreviewLoading(true);
    const payload =
      regType === "parent-learner"
        ? {
            kind: "parent-learner",
            programmeId: parentOfferingPickerVisible || parentProgrammes.length > 1 ? parentProgrammeId || undefined : undefined,
            classId: parentOfferingPickerVisible && !parentPathRequiresCourseSelection() && !parentUsesProgrammeLevels ? parentClassId : undefined,
            // Bug fix: needed so the server can tell this is an Individual
            // Course request and skip its own Class-based `foundation`
            // resolution (see the server-side comment on
            // registration-fee-preview) — without this the server can't
            // distinguish an Individual Course pick from a structured one
            // and may still price an unrelated Class's Run.
            participationStructure: parentParticipationStructure || undefined,
            // Bug fix: this used to be omitted here even though the actual
            // /register submission a few hundred lines below always sends
            // it — so an Individual Course Run's own registration_fee_ghs
            // (and any Combine Registration with First Period pricing)
            // never showed up in this preview; the server fell back to
            // resolveEntryClass(programmeId)'s unrelated Foundation-class
            // Run instead, pricing a completely different Learning
            // Instance. Kept identical to the real submission's own
            // `learningInstanceId: parentSelectedInstanceId || undefined`.
            learningInstanceId: parentSelectedInstanceId || undefined,
            learners: learners.map((l) => ({ name: l.name.trim() || undefined, campus: l.campus || undefined, schoolName: l.schoolName.trim() || undefined, ownRoboticsKit: l.ownRoboticsKit })),
          }
        : {
            kind: "adult",
            classId: adultOfferingPickerVisible && adultProgrammeId ? adultClassId : undefined,
            // Same fix as the parent-learner branch above, mirroring the
            // real submission's `learningInstanceId: hasOffering ? adultSelectedInstanceId || undefined : undefined`.
            learningInstanceId: adultOfferingPickerVisible && adultProgrammeId ? adultSelectedInstanceId || undefined : undefined,
            adult: { name: adultName.trim() || undefined, campus: adultCampus || undefined, ownRoboticsKit: adultOwnKit },
          };
    fetchRegistrationFeePreview(payload)
      .then((result) => {
        if (cancelled) return;
        setPreviewBreakdown(result.breakdown || null);
        setPreviewTotal(result.totalGHS != null ? result.totalGHS : null);
      })
      .catch(() => {
        // Preview is a courtesy only — the real, authoritative total still
        // comes back from POST /register regardless of whether this loads.
        if (!cancelled) {
          setPreviewBreakdown(null);
          setPreviewTotal(null);
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, accountCreated, regType, parentProgrammeId, parentClassId, parentParticipationStructure, parentSelectedInstanceId, adultProgrammeId, adultClassId, adultSelectedInstanceId, learners, adultOwnKit, adultCampus]);

  // ---- Step 3: create account + Mobile Money payment ---------------------------

  function startPolling(reference, method = "MOBILE_MONEY") {
    pollAttemptsRef.current = 0;
    setPayStage("polling");
    setPayMessage(method === "CARD" ? "Confirming your card payment…" : "Checking your phone and approving the payment prompt…");
    pollRef.current = setInterval(async () => {
      pollAttemptsRef.current += 1;
      try {
        const { status } = await verifyPayment(reference);
        if (status === "success") {
          clearInterval(pollRef.current);
          pollRef.current = null;
          finishOutcome(true);
        } else if (status === "failed" || pollAttemptsRef.current > MAX_POLL_ATTEMPTS) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          finishOutcome(false);
        }
      } catch (e) {
        /* keep polling */
      }
    }, POLL_INTERVAL_MS);
  }

  // Same poll shape as startPolling above, but drives the standalone
  // genericResume confirmation instead of the registration wizard's
  // outcome/step 4 — see the resume effect for when this is used.
  function pollGenericPayment(reference) {
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts += 1;
      try {
        const { status } = await verifyPayment(reference);
        if (status === "success") {
          clearInterval(interval);
          setGenericResume((r) => (r ? { ...r, status: "success" } : r));
        } else if (status === "failed" || attempts > MAX_POLL_ATTEMPTS) {
          clearInterval(interval);
          setGenericResume((r) => (r ? { ...r, status: "failed" } : r));
        }
      } catch (e) {
        if (attempts > MAX_POLL_ATTEMPTS) {
          clearInterval(interval);
          setGenericResume((r) => (r ? { ...r, status: "failed" } : r));
        }
      }
    }, POLL_INTERVAL_MS);
  }

  function finishOutcome(paymentSucceeded) {
    setOutcome({ paymentSucceeded, allLearners: allLearnersRef.current || [] });
    setStep(4);
  }

  async function initiateChargeAndHandle(momo, method = "MOBILE_MONEY") {
    setStep3Error("");
    try {
      const charge = await initiateRegistrationPayment(accountIdRef.current, { method, network, momoNumber: momo });
      paymentReferenceRef.current = charge.reference;

      if (method === "CARD") {
        // Dev-mode fallback (no PAYSTACK_SECRET_KEY configured): the server
        // auto-completes the payment inline and never gives us a hosted
        // checkout URL to redirect to — same success path as MoMo's own
        // dev fallback below.
        if (charge.status === "success") {
          finishOutcome(true);
          return;
        }
        if (!charge.authorizationUrl) {
          setStep3Error("Couldn't start the card payment. Please try again.");
          setPayBusy(false);
          return;
        }
        // A full-page redirect to Paystack's hosted checkout reloads this
        // SPA, discarding in-memory state (accountIdRef, allLearnersRef,
        // etc.) — save just enough in sessionStorage to resume verification
        // by reference alone when the learner comes back (see the
        // resume-after-redirect effect near the top of this component).
        // The server/Paystack verification that follows is the sole source
        // of truth for whether payment actually succeeded; nothing here
        // is trusted client-side.
        try {
          sessionStorage.setItem(
            CARD_PAYMENT_RESUME_KEY,
            JSON.stringify({
              reference: charge.reference,
              accountId: accountIdRef.current,
              regType,
              allLearners: allLearnersRef.current,
            })
          );
        } catch {
          // sessionStorage unavailable (e.g. private browsing) — resume
          // after redirect just won't auto-restore; verification itself
          // still works fine via the reference in the return URL.
        }
        window.location.href = charge.authorizationUrl;
        return;
      }

      if (charge.status === "send_otp") {
        awaitingOtpRef.current = true;
        setPayStage("otp");
        setPayMessage("Enter the OTP your network just sent you, then press Confirm.");
        setPayBusy(false);
        return;
      }
      if (charge.status === "success") {
        finishOutcome(true);
        return;
      }
      setPayMessage(charge.displayText || "Check your phone and approve the payment prompt…");
      startPolling(charge.reference);
    } catch (e) {
      setStep3Error(e.message);
      setPayBusy(false);
    }
  }

  async function handlePaySubmit() {
    setStep3Error("");
    setShow409LoginHint(false);

    // Payment-method boundary: Ghana always uses the existing Mobile
    // Money flow, unchanged. Every other country uses Paystack's hosted
    // card checkout (see routes/payments.js's method param) — never
    // inferred silently past this one branch point, which mirrors the
    // server's own explicit `method` field.
    const method = isGhanaRegistrant ? "MOBILE_MONEY" : "CARD";

    // Case 1: an OTP is pending on an already-created account. Only ever
    // true for MOBILE_MONEY — CARD's hosted checkout has no OTP step in
    // this app, Paystack's own page handles 3D Secure.
    if (accountIdRef.current && awaitingOtpRef.current) {
      if (!otp.trim()) return setStep3Error("Enter the OTP.");
      setPayBusy(true);
      try {
        await submitPaymentOtp(paymentReferenceRef.current, otp.trim());
        awaitingOtpRef.current = false;
        startPolling(paymentReferenceRef.current);
      } catch (e) {
        setStep3Error(e.message);
        setPayBusy(false);
      }
      return;
    }

    // Case 2: account already exists (a previous charge attempt failed to
    // initiate) — retry the charge, never create a second account.
    if (accountIdRef.current) {
      if (method === "MOBILE_MONEY" && !isValidGhPhone(momoNumber)) {
        return setStep3Error("Enter a valid 10-digit Mobile Money number, e.g. 0501234567.");
      }
      setPayBusy(true);
      await initiateChargeAndHandle(momoNumber, method);
      return;
    }

    // Case 3: first attempt — create the account, then charge it.
    if (method === "MOBILE_MONEY" && !isValidGhPhone(momoNumber)) {
      return setStep3Error("Enter a valid 10-digit Mobile Money number, e.g. 0501234567.");
    }
    setPayBusy(true);

    let result;
    try {
      if (regType === "parent-learner") {
        result = await registerAccount({
          kind: "parent-learner",
          courseIds: selectedModuleIds,
          programmeId: parentOfferingPickerVisible || parentProgrammes.length > 1 ? parentProgrammeId || undefined : undefined,
          classId: parentOfferingPickerVisible && !parentPathRequiresCourseSelection() && !parentUsesProgrammeLevels ? parentClassId : undefined,
          operationalGroupId: parentOperationalGroups.length ? parentOperationalGroupId || undefined : undefined,
          // ABRS v2.2 amendment (concurrent Programme Runs) — set only
          // when parentRunConfig required the "which run/cohort?" picker
          // above (i.e. this programme had more than one Active Run);
          // undefined is a no-op for every single-Run programme, exactly
          // as before this existed.
          learningInstanceId: parentSelectedInstanceId || undefined,
          participationStructure: parentParticipationStructure || undefined,
          parent: {
            name: parentName.trim(),
            email: parentEmail.trim(),
            phone: parentPhone.trim(),
            country: parentCountry,
            town: parentTown.trim(),
            password: parentPassword,
            confirmPassword: parentPasswordConfirm,
            phoneNetwork: network,
          },
          learners: learners.map((l) => ({
            name: l.name.trim(),
            campus: l.campus || undefined,
            schoolName: l.schoolName.trim() || undefined,
            ownRoboticsKit: l.ownRoboticsKit,
            age: l.age !== "" ? Number(l.age) : undefined,
          })),
        });
      } else {
        const hasOffering = adultOfferingPickerVisible && adultProgrammeId;
        result = await registerAccount({
          kind: "adult",
          courseIds: selectedModuleIds,
          classId: hasOffering ? adultClassId : undefined,
          operationalGroupId: hasOffering && adultOperationalGroups.length ? adultOperationalGroupId || undefined : undefined,
          // Same concurrent-Runs disambiguator as the parent-learner path.
          learningInstanceId: hasOffering ? adultSelectedInstanceId || undefined : undefined,
          adult: {
            name: adultName.trim(),
            email: adultEmail.trim(),
            phone: adultPhone.trim(),
            country: adultCountry,
            town: adultTown.trim(),
            password: adultPassword,
            confirmPassword: adultPasswordConfirm,
            phoneNetwork: network,
            ownRoboticsKit: adultOwnKit,
            educationLevel: adultEducationLevel,
            campus: adultCampus || undefined,
          },
        });
      }
    } catch (e) {
      setStep3Error(e.message || "Something went wrong creating your account.");
      setPayBusy(false);
      // Only the duplicate-account 409 ("An account with this email
      // already exists.") warrants the login hint. Registration can also
      // 409 for an unrelated reason now — no Active Programme Run exists
      // for the selected programme — and showing "log in instead" there
      // would be actively misleading (there's no existing account to log
      // into; the fix is an admin opening a registration run, not logging
      // in).
      if (e.status === 409 && /account.*already exists/i.test(e.message || "")) setShow409LoginHint(true);
      // ABRS v2.2 amendment (concurrent Programme Runs): defensive-only —
      // the "which run/cohort?" picker above should already prevent this
      // in the normal flow, but a Programme could genuinely have gone
      // from one Active Run to two between page load and submit (an
      // admin activated a second Run mid-registration). e.activeRuns
      // comes straight from the server's 409 (see ApiError's `extra`
      // merge in api/client.js) — reset back to the picker state rather
      // than leaving the person stuck on a plain error message they can't
      // act on.
      if (Array.isArray(e.activeRuns) && e.activeRuns.length) {
        setStep3Error(`${e.message || "Choose which run to register into."} Please re-select the run/cohort above and try again.`);
        if (regType === "parent-learner") {
          setParentSelectedInstanceId("");
          setParentRunConfig({ hasActiveRun: false, multipleActiveRuns: true, activeRuns: e.activeRuns });
          setParentRunConfigLoaded(false);
        } else {
          setAdultSelectedInstanceId("");
          setAdultRunConfig({ hasActiveRun: false, multipleActiveRuns: true, activeRuns: e.activeRuns });
          setAdultRunConfigLoaded(false);
        }
      }
      return;
    }

    // Account created — sync the session (registerAccount already set the
    // cookie server-side) so "Go to my dashboard" on Step 4 works without
    // a full reload.
    refresh();

    allLearnersRef.current = result.learners || null;
    accountIdRef.current = regType === "parent-learner" ? result.parentId : result.learnerId;
    if (result.registrationBreakdown && result.registrationBreakdown.length) setFeeBreakdown(result.registrationBreakdown);
    if (result.registrationTotalGHS != null) setFeeTotal(result.registrationTotalGHS);
    setAccountCreated(true);

    await initiateChargeAndHandle(momoNumber, method);
  }

  function downloadCredentials() {
    const all = outcome?.allLearners || [];
    if (!all.length) return;
    const lines = [
      "The Builders' Lab — learner login credentials",
      "Keep this somewhere safe. Each password is shown only once.",
      "",
      ...all.map((l) => `${l.name} — Email: ${l.learnerLoginEmail} — Password: ${l.learnerPassword || "—"} — Student ID: ${l.studentCode}`),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "builderslab-learner-credentials.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function handleGoToDashboard() {
    await refresh();
    navigate("/app");
  }

  // ==============================================================================

  if (genericResume) {
    return (
      <div className={styles.page}>
        <div className={styles.wrap}>
          <Card padding className={styles.card} style={{ textAlign: "center" }}>
            {genericResume.status === "polling" && <p className="text-helper">Confirming your card payment…</p>}
            {genericResume.status === "success" && (
              <>
                <div style={{ fontSize: "2.4rem", marginBottom: 10 }}>✅</div>
                <h2>Payment successful</h2>
                <p>{genericResume.kind === "monthly" ? "This month's fee is now paid." : genericResume.kind === "period" ? "The outstanding balance is now paid." : "Your programme is now active."}</p>
                <Button fullWidth onClick={handleGoToDashboard} style={{ marginTop: "var(--space-4)" }}>
                  Go to my dashboard
                </Button>
              </>
            )}
            {genericResume.status === "failed" && (
              <>
                <h2>Payment not completed</h2>
                <p>We couldn't confirm this payment. You can try again from your dashboard.</p>
                <Button fullWidth onClick={handleGoToDashboard} style={{ marginTop: "var(--space-4)" }}>
                  Go to my dashboard
                </Button>
              </>
            )}
          </Card>
        </div>
      </div>
    );
  }

  if (catalogStatus === "error") {
    return (
      <AuthLayout eyebrow="Enrol" title="Something went wrong" description="We couldn't load registration details.">
        <Alert variant="danger">Couldn't load registration details. Please refresh the page and try again.</Alert>
      </AuthLayout>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <Card padding className={styles.card}>
          <p className="text-caption">Step {Math.min(step, 3)} of 3</p>

          {step === 1 && (
            <div>
              <h2>Create your account</h2>
              <p className="text-helper" style={{ marginBottom: "var(--space-4)" }}>
                Choose who this account is for.
              </p>

              <div className={styles.roleToggle}>
                <Button type="button" variant={regType === "parent-learner" ? "primary" : "secondary"} onClick={() => setRegType("parent-learner")}>
                  Parent + Child learner
                </Button>
                <Button type="button" variant={regType === "adult" ? "primary" : "secondary"} onClick={() => setRegType("adult")}>
                  Adult learner (18+)
                </Button>
              </div>

              {regType === "parent-learner" ? (
                <>
                  <FormField label="Your full name (parent/guardian)" required>
                    <Input value={parentName} onChange={(e) => setParentName(e.target.value)} placeholder="e.g. Abena Dalike" />
                  </FormField>
                  <FormField label="Country" required helperText={parentCountry === DEFAULT_COUNTRY ? "" : "Online payment currently only supports Ghana Mobile Money — see the payment step for details."}>
                    <Select value={parentCountry} onChange={(e) => setParentCountry(e.target.value)}>
                      {COUNTRIES.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField label="Town / City of residence" required>
                    <Input value={parentTown} onChange={(e) => setParentTown(e.target.value)} placeholder="e.g. Kumasi" />
                  </FormField>
                  <div className={styles.fieldRow}>
                    <FormField label="Email" required>
                      <Input type="email" value={parentEmail} onChange={(e) => setParentEmail(e.target.value)} placeholder="you@email.com" />
                    </FormField>
                    <FormField label="Phone number" required>
                      <Input
                        value={parentPhone}
                        onChange={(e) => setParentPhone(e.target.value)}
                        placeholder={parentCountry === DEFAULT_COUNTRY ? "05XXXXXXXX" : "+14155550123"}
                      />
                    </FormField>
                  </div>
                  <div className={styles.fieldRow}>
                    <FormField label="Create your password (8+ chars, letters & numbers)" required>
                      <Input type="password" value={parentPassword} onChange={(e) => setParentPassword(e.target.value)} placeholder="••••••••" />
                    </FormField>
                    <FormField label="Confirm your password" required>
                      <Input type="password" value={parentPasswordConfirm} onChange={(e) => setParentPasswordConfirm(e.target.value)} placeholder="••••••••" />
                    </FormField>
                  </div>

                  {parentOfferingPickerVisible && (
                    <FormField label="What are you registering your child for?">
                      <Select value={parentOfferingId} onChange={(e) => handleParentOfferingChange(e.target.value)}>
                        <option value="">Choose…</option>
                        {parentOfferingTypes.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.icon} {t.name}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                  {(parentOfferingPickerVisible ? parentOfferingId : parentProgrammes.length > 1) && (
                    <FormField label="Programme">
                      <Select value={parentProgrammeId} onChange={(e) => handleParentProgrammeChange(e.target.value)}>
                        <option value="">Choose…</option>
                        {parentProgrammes.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                            {p.durationLabel ? ` (${p.durationLabel})` : ""}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                  {parentRegistrationBlocked && (
                    <Alert variant="info">
                      There are currently no available registration opportunities for this programme — an admin hasn't opened registration yet. Please check back later or contact us for details.
                    </Alert>
                  )}

                  {/* Registration Experience Redesign — Participation
                      Structure now resolves BEFORE Delivery Mode/Class:
                      it's this Programme's own config (registration-
                      config's participationStructureOptions) that decides
                      whether Course Selection or a Batch/Cohort picker
                      comes next, and whether a Programme Level gets
                      auto-assigned (§10.2, §11.2) — never a hardcoded
                      branch in this component. Only rendered when there's
                      an actual choice; a single configured option
                      auto-selects with nothing to ask (see the effect
                      above), and a Programme with none configured falls
                      back to the pre-existing behaviour untouched. */}
                  {parentOfferingPickerVisible && parentProgrammeId && parentParticipationOptions.length > 1 && (
                    <FormField label="How will your child be participating?">
                      <Select value={parentParticipationStructure} onChange={(e) => setParentParticipationStructure(e.target.value)}>
                        <option value="">Choose…</option>
                        {parentParticipationOptions.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}

                  {/* ABRS v2.2 amendment (concurrent Programme Runs) — this
                      Programme currently has more than one Active Run (e.g.
                      separate cohorts for different schools/batches).
                      Nothing else below can render a sensible config until
                      one is chosen, since Delivery Mode/Fee/Operational
                      Groups/Academic Period are all per-Run. */}
                  {parentOfferingPickerVisible && parentProgrammeId && parentRunConfig?.multipleActiveRuns && (
                    <FormField label="Which run/cohort?" helperText="This programme currently has more than one active run — choose which one you're registering into.">
                      <Select value={parentSelectedInstanceId} onChange={(e) => handleParentInstanceChoice(e.target.value)}>
                        <option value="">Choose…</option>
                        {(parentRunConfig.activeRuns || []).map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name || r.id}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                  {parentOfferingPickerVisible && parentProgrammeId && !parentPathRequiresCourseSelection() && parentDeliveryModes.length > 1 && (
                    <FormField label="Delivery mode">
                      <Select value={parentDeliveryMode} onChange={(e) => handleParentDeliveryModeChange(e.target.value)}>
                        <option value="">Choose…</option>
                        {parentDeliveryModes.includes("ON_CAMPUS") && <option value="ON_CAMPUS">On-Campus</option>}
                        {parentDeliveryModes.includes("ONLINE") && <option value="ONLINE">Online</option>}
                      </Select>
                    </FormField>
                  )}
                  {/* §11.2 — Parents never choose a Programme Level: once the
                      resolved Participation Structure uses Programme
                      Levels, this Batch/Cohort picker (which for that
                      structure IS the Programme Level list) is hidden
                      entirely; no classId is ever sent, and the backend
                      auto-assigns the entry Programme Level. */}
                  {parentOfferingPickerVisible &&
                    parentProgrammeId &&
                    !parentPathRequiresCourseSelection() &&
                    !parentUsesProgrammeLevels &&
                    (!parentDeliveryModes.length || parentDeliveryMode) && (
                      <FormField label={(parentProgrammes.find((p) => p.id === parentProgrammeId) || {}).learningGroupLabel || "Batch/Cohort"}>
                        <Select value={parentClassId} onChange={(e) => setParentClassId(e.target.value)}>
                          <option value="">Choose…</option>
                          {parentVisibleClasses.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </Select>
                      </FormField>
                    )}
                  {parentOfferingPickerVisible && parentProgrammeId && !parentPathRequiresCourseSelection() && parentUsesProgrammeLevels && parentEntryLevelName && (
                    <Alert variant="info">Your child will begin at {parentEntryLevelName} and progress from there — this is set automatically.</Alert>
                  )}
                  {/* §11 — Operational Groups (batch/cohort/section) are
                      entirely separate from the Programme Level picker
                      above; only rendered once this Run actually has more
                      than one to choose between (exactly one auto-selects
                      silently, same progressive-disclosure pattern as
                      Delivery Mode/Campus). */}
                  {parentOfferingPickerVisible && parentProgrammeId && parentOperationalGroups.length > 1 && (
                    <FormField label="Batch / Group" helperText="Which group you'd like to join for this run.">
                      <Select value={parentOperationalGroupId} onChange={(e) => setParentOperationalGroupId(e.target.value)}>
                        <option value="">Choose…</option>
                        {parentOperationalGroups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.displayLabel || g.name}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}


                  <hr className={styles.divider} />
                  {learners.map((l, i) => (
                    <LearnerBlock
                      key={l.key}
                      index={i}
                      learner={l}
                      campusOptions={parentRunCampusOptions.length ? parentRunCampusOptions : campusOptions}
                      onChange={updateLearner}
                      onRemove={removeLearner}
                      deliveryMode={parentSelectedClass?.deliveryMode || (parentDeliveryMode === "ONLINE" ? "ONLINE" : null)}
                      campusName={parentSelectedClass?.campusName || null}
                    />
                  ))}
                  <Button type="button" variant="ghost" size="sm" onClick={addLearner}>
                    + Add another child
                  </Button>
                </>
              ) : (
                <>
                  <FormField label="Your full name" required>
                    <Input value={adultName} onChange={(e) => setAdultName(e.target.value)} placeholder="e.g. Kojo Aliefeh" />
                  </FormField>
                  <FormField label="Country" required helperText={adultCountry === DEFAULT_COUNTRY ? "" : "Online payment currently only supports Ghana Mobile Money — see the payment step for details."}>
                    <Select value={adultCountry} onChange={(e) => setAdultCountry(e.target.value)}>
                      {COUNTRIES.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField label="Town / City of residence" required>
                    <Input value={adultTown} onChange={(e) => setAdultTown(e.target.value)} placeholder="e.g. Kumasi" />
                  </FormField>
                  <div className={styles.fieldRow}>
                    <FormField label="Email" required>
                      <Input type="email" value={adultEmail} onChange={(e) => setAdultEmail(e.target.value)} placeholder="you@email.com" />
                    </FormField>
                    <FormField label="Phone number" required>
                      <Input
                        value={adultPhone}
                        onChange={(e) => setAdultPhone(e.target.value)}
                        placeholder={adultCountry === DEFAULT_COUNTRY ? "05XXXXXXXX" : "+14155550123"}
                      />
                    </FormField>
                  </div>
                  <div className={styles.fieldRow}>
                    <FormField label="Create a password (8+ chars, letters & numbers)" required>
                      <Input type="password" value={adultPassword} onChange={(e) => setAdultPassword(e.target.value)} placeholder="••••••••" />
                    </FormField>
                    <FormField label="Confirm password" required>
                      <Input type="password" value={adultPasswordConfirm} onChange={(e) => setAdultPasswordConfirm(e.target.value)} placeholder="••••••••" />
                    </FormField>
                  </div>
                  <FormField label="Education level">
                    <Select value={adultEducationLevel} onChange={(e) => setAdultEducationLevel(e.target.value)}>
                      <option value="None">None</option>
                      <option value="Senior High">Senior High</option>
                      <option value="Tertiary">Tertiary</option>
                    </Select>
                  </FormField>
                  {!adultSelectedClass?.deliveryMode && adultDeliveryMode !== "ONLINE" && (
                    <FormField label="Campus">
                      <Select value={adultCampus} onChange={(e) => setAdultCampus(e.target.value)}>
                        <option value="">Choose…</option>
                        {(adultRunCampusOptions.length ? adultRunCampusOptions : campusOptions).map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                        <option value="Other / not listed">Other / not listed</option>
                      </Select>
                    </FormField>
                  )}
                  {(adultSelectedClass?.deliveryMode === "ON_CAMPUS" || adultSelectedClass?.deliveryMode === "HYBRID") && (
                    <FormField label="Campus" helperText="Determined by the selected Batch/Cohort.">
                      <Input value={adultSelectedClass.campusName || "—"} disabled readOnly />
                    </FormField>
                  )}
                  {/* deliveryMode === "ONLINE" (either the Class's own, or the
                      Run-level auto-selected one) — no campus field, campus is
                      null/ignored for the enrollment path. */}
                  <Checkbox
                    label="I'd like to keep my own robotics kit (extra one-off fee applies)"
                    checked={adultOwnKit}
                    onChange={(e) => setAdultOwnKit(e.target.checked)}
                  />

                  {adultOfferingPickerVisible && (
                    <FormField label="What are you enrolling in?">
                      <Select value={adultOfferingId} onChange={(e) => handleAdultOfferingChange(e.target.value)}>
                        <option value="">— select —</option>
                        {adultOfferingTypes.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.icon} {t.name}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                  {adultOfferingId && (
                    <FormField label="Programme">
                      <Select value={adultProgrammeId} onChange={(e) => handleAdultProgrammeChange(e.target.value)}>
                        <option value="">— select —</option>
                        {adultProgrammes.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                            {p.durationLabel ? ` (${p.durationLabel})` : ""}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                  {adultRegistrationBlocked && (
                    <Alert variant="info">
                      There are currently no available registration opportunities for this programme — an admin hasn't opened registration yet. Please check back later or contact us for details.
                    </Alert>
                  )}
                  {/* ABRS v2.2 amendment (concurrent Programme Runs) — same
                      "choose a run first" negotiation as the parent-learner
                      path above. */}
                  {adultOfferingId && adultProgrammeId && adultRunConfig?.multipleActiveRuns && (
                    <FormField label="Which run/cohort?" helperText="This programme currently has more than one active run — choose which one you're registering into.">
                      <Select value={adultSelectedInstanceId} onChange={(e) => handleAdultInstanceChoice(e.target.value)}>
                        <option value="">Choose…</option>
                        {(adultRunConfig.activeRuns || []).map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name || r.id}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                  {adultOfferingId && adultProgrammeId && adultDeliveryModes.length > 1 && (
                    <FormField label="Delivery mode">
                      <Select value={adultDeliveryMode} onChange={(e) => handleAdultDeliveryModeChange(e.target.value)}>
                        <option value="">Choose…</option>
                        {adultDeliveryModes.includes("ON_CAMPUS") && <option value="ON_CAMPUS">On-Campus</option>}
                        {adultDeliveryModes.includes("ONLINE") && <option value="ONLINE">Online</option>}
                      </Select>
                    </FormField>
                  )}
                  {adultOfferingId && adultProgrammeId && (!adultDeliveryModes.length || adultDeliveryMode) && (
                    <FormField label={(adultProgrammes.find((p) => p.id === adultProgrammeId) || {}).learningGroupLabel || "Batch/Cohort"}>
                      <Select value={adultClassId} onChange={(e) => setAdultClassId(e.target.value)}>
                        <option value="">Choose…</option>
                        {adultVisibleClasses.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                  {adultOfferingId && adultProgrammeId && adultOperationalGroups.length > 1 && (
                    <FormField label="Batch / Group" helperText="Which group you'd like to join for this run.">
                      <Select value={adultOperationalGroupId} onChange={(e) => setAdultOperationalGroupId(e.target.value)}>
                        <option value="">Choose…</option>
                        {adultOperationalGroups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.displayLabel || g.name}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                </>
              )}

              {step1Error && (
                <div style={{ marginTop: "var(--space-3)" }}>
                  <Alert variant="danger">{step1Error}</Alert>
                </div>
              )}
              <Button fullWidth onClick={goStep2} style={{ marginTop: "var(--space-4)" }}>
                Continue
              </Button>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2>Choose a Builders' module</h2>
              <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
                Only modules currently open for enrolment are shown — courses run in a fixed order, so the next module opens once the current one's
                season ends.
              </p>
              {modules.length === 0 && <p className="text-helper">No module is open for new enrolment right now — please check back soon or contact us.</p>}
              {modules.map((m) => (
                <label key={m.id} className={styles.moduleRow}>
                  <input type="checkbox" checked={selectedModuleIds.includes(m.id)} onChange={() => toggleModule(m.id)} />
                  <span>
                    <b>{m.id}</b> — {m.title} <span className="text-caption">({m.weeks} wks, ages {m.ages})</span>
                  </span>
                </label>
              ))}
              {step2Error && (
                <div style={{ marginTop: "var(--space-3)" }}>
                  <Alert variant="danger">{step2Error}</Alert>
                </div>
              )}
              <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
                <Button variant="ghost" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button fullWidth onClick={goStep3}>
                  Continue to payment
                </Button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2>Pay registration fee</h2>
              <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
                {isGhanaRegistrant
                  ? "A one-time registration fee unlocks the account. Choose your network and approve the prompt on your phone."
                  : "A one-time registration fee unlocks the account, paid securely by card."}
              </p>

              <Card padding className={styles.feePanel}>
                {(() => {
                  // feeBreakdown/feeTotal (set once the account actually
                  // exists) are authoritative; previewBreakdown/previewTotal
                  // are the pre-creation estimate from the same fee-
                  // resolution chain. Never falls back to the flat Site
                  // Settings global default here — see the effect above for
                  // why that used to be misleading.
                  const breakdown = feeBreakdown || previewBreakdown;
                  const total = feeTotal != null ? feeTotal : previewTotal;
                  if (!breakdown && total == null) {
                    return <p className="text-helper">{previewLoading ? "Calculating your registration fee…" : "Registration fee shown once calculated."}</p>;
                  }
                  return (
                    <>
                      {breakdown &&
                        breakdown.map((b, i) => (
                          <div key={i} className={styles.feeRow}>
                            <span>
                              {b.name}
                              {b.discounted ? " (multi-ward discount)" : ""}
                            </span>
                            <span>GHS {b.amountGHS}</span>
                          </div>
                        ))}
                      <div className={styles.feeRow} style={{ fontWeight: 600 }}>
                        <span>Registration total{feeTotal == null && total != null ? " (estimate)" : ""}</span>
                        <span>{total != null ? `GHS ${total}` : "—"}</span>
                      </div>
                    </>
                  );
                })()}
              </Card>

              {paymentAccounts.length > 0 && (
                <Card padding className={styles.feePanel} style={{ marginTop: "var(--space-3)" }}>
                  <p className="text-caption" style={{ marginBottom: "var(--space-2)" }}>
                    Our payment accounts
                  </p>
                  {paymentAccounts.map((a, i) => (
                    <div key={i} className={styles.feeRow}>
                      <span>{a.network}</span>
                      <span>
                        {a.account_number} — {a.account_name}
                      </span>
                    </div>
                  ))}
                </Card>
              )}

              {payStage === "form" && isGhanaRegistrant && (
                <div style={{ marginTop: "var(--space-4)" }}>
                  <FormField label="Mobile Money network">
                    <Select value={network} onChange={(e) => setNetwork(e.target.value)} disabled={accountCreated}>
                      {NETWORKS.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField label="Mobile Money number">
                    <Input value={momoNumber} onChange={(e) => setMomoNumber(e.target.value)} placeholder="05XXXXXXXX" disabled={payBusy} />
                  </FormField>
                </div>
              )}

              {payStage === "form" && !isGhanaRegistrant && (
                <div style={{ marginTop: "var(--space-4)" }}>
                  <Alert variant="info">
                    You'll be taken to Paystack's secure checkout to pay by card. Amounts are charged in GHS (your card issuer converts automatically); {countryName(registrantCountry)}-specific payment methods aren't available yet.
                  </Alert>
                </div>
              )}

              {payStage === "otp" && (
                <div style={{ marginTop: "var(--space-4)" }}>
                  <FormField label="Enter the OTP sent by your network" helperText={payMessage}>
                    <Input value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" placeholder="123456" autoFocus />
                  </FormField>
                </div>
              )}

              {payStage === "polling" && (
                <p className="text-helper" style={{ marginTop: "var(--space-3)" }}>
                  {payMessage}
                </p>
              )}

              {step3Error && (
                <div style={{ marginTop: "var(--space-3)" }}>
                  <Alert variant="danger">{step3Error}</Alert>
                </div>
              )}
              {show409LoginHint && (
                <div style={{ marginTop: "var(--space-2)" }}>
                  <Link to="/app/login" className="text-body">
                    Log in to your existing account
                  </Link>
                  <p className="text-caption" style={{ marginTop: "var(--space-1)" }}>
                    Once you're signed in, use My Programmes → Enrol in another programme to join this programme without creating a second account.
                  </p>
                </div>
              )}

              <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
                {!accountCreated && (
                  <Button
                    variant="ghost"
                    onClick={() => setStep(skipModuleStep ? 1 : 2)}
                    disabled={payBusy}
                  >
                    Back
                  </Button>
                )}
                <Button
                  fullWidth
                  loading={payBusy && payStage !== "otp"}
                  onClick={handlePaySubmit}
                  disabled={payStage === "polling"}
                >
                  {payStage === "otp" ? "Confirm OTP" : isGhanaRegistrant ? "Pay & create account" : "Continue to secure payment"}
                </Button>
              </div>
            </div>
          )}

          {step === 4 && outcome && (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "2.4rem", marginBottom: 10 }}>✅</div>
              <h2>You're enrolled!</h2>
              <p>
                {outcome.paymentSucceeded
                  ? outcome.allLearners.length > 1
                    ? "Payment confirmed for all your children. Save each learner's login credentials below — they're shown only once."
                    : outcome.allLearners.length
                    ? "Payment confirmed. Save your learner's login credentials below — they're shown only once."
                    : "Payment confirmed. You can now sign in any time."
                  : "Your account was created, but the payment didn't go through. Save your learner's login credentials below, then sign in to your parent portal to retry payment and activate access."}
              </p>

              {outcome.allLearners.length > 0 && (
                <Card padding style={{ textAlign: "left", marginTop: "var(--space-4)" }}>
                  <h3>Learner login credentials — save these now</h3>
                  <p className="text-caption" style={{ marginBottom: "var(--space-2)" }}>
                    Each learner signs in with the email and password below. This password is shown only once.
                  </p>
                  <table className={styles.credsTable}>
                    <thead>
                      <tr>
                        <th>Learner</th>
                        <th>Login email</th>
                        <th>Password</th>
                        <th>Student ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outcome.allLearners.map((l, i) => (
                        <tr key={i}>
                          <td>{l.name}</td>
                          <td>{l.learnerLoginEmail}</td>
                          <td>
                            <b>{l.learnerPassword || "—"}</b>
                          </td>
                          <td>{l.studentCode}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
                    <Button variant="ghost" fullWidth onClick={() => window.print()}>
                      🖨 Print credentials
                    </Button>
                    <Button variant="ghost" fullWidth onClick={downloadCredentials}>
                      ⬇ Download as text
                    </Button>
                  </div>
                </Card>
              )}

              <Button fullWidth onClick={handleGoToDashboard} style={{ marginTop: "var(--space-4)" }}>
                Go to my dashboard
              </Button>
            </div>
          )}

          {step === 1 && (
            <p className="text-caption" style={{ textAlign: "center", marginTop: "var(--space-4)" }}>
              Already have an account? <Link to="/app/login">Sign in</Link>.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
