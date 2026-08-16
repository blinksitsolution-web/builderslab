import { useCallback, useEffect, useState } from "react";
import { fetchUser } from "../../api/users";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { setAccessOverride, setLearnerSponsor, setEnrolmentParticipationStructure, fetchProgrammeParticipationStructures } from "../../api/admin";
import { AccessOverrideModal } from "./PaymentActionModals";
import SponsorAssignModal from "./SponsorAssignModal";
import { countryName } from "../../utils/countries";
import { Drawer, Badge, StatusIndicator, Button, Select, Skeleton, ErrorState, UnauthorizedState } from "../../components/ui";

// ABRS v2.1 Phase 4 (Category 3 audit fix) — Participation Structure
// options and display labels used to be three hardcoded string
// comparisons here (structured_school_club / structured_other /
// individual_course). They're now read from the Programme's own
// configured Participation Structures (Section 10.2, via
// GET /api/learning-offerings/programmes/:id/participation-structures —
// see fetchProgrammeParticipationStructures below), so a Programme's
// admin-defined names/keys render correctly with zero code changes here.
// participationStructureLabel falls back to a generic, non-guessing
// treatment for anything not in that list: empty/null shows as
// "not set", and a value present but not found in the fetched config
// (e.g. this Programme's config hasn't been reviewed yet, or the drawer's
// fetch is still loading) shows its raw key rather than a made-up label.
function participationStructureLabel(value, options) {
  if (!value) return "— not set —";
  const match = (options || []).find((opt) => opt.value === value);
  return match ? match.label : value;
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: "var(--space-4)" }}>
      <p className="text-label" style={{ margin: 0 }}>
        {label}
      </p>
      <p style={{ margin: "var(--space-1) 0 0" }}>{children ?? "—"}</p>
    </div>
  );
}

/**
 * Account detail view (Phase 17) — reuses the existing generic
 * GET /api/users/:id wrapper (client/src/api/users.js, shared with
 * learner/parent self-view since Phase 2/6) rather than adding a
 * duplicate endpoint. requireSelfParentOrStaff already allows any admin
 * or instructor to fetch any account this way (see Phase 1 analysis of
 * server/src/middleware/auth.js) — no extra permission is required for
 * this specific read.
 */
export default function AccountDetailDrawer({ userId, open, onClose, classNameById, moduleTitleById }) {
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "error" | "forbidden"
  const [account, setAccount] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [overrideModalOpen, setOverrideModalOpen] = useState(false);
  const [sponsorModalOpen, setSponsorModalOpen] = useState(false);
  const [participationSaving, setParticipationSaving] = useState(false);
  const [participationError, setParticipationError] = useState(null);
  // ABRS v2.1 Phase 4 (Category 3 audit fix) — this Programme's own
  // configured Participation Structures, fetched once we know which
  // Programme the account belongs to. [] is a normal state (Programme has
  // none configured, or hasn't loaded yet) — participationStructureLabel
  // and the Select's option list both already treat [] safely.
  const [participationStructureOptions, setParticipationStructureOptions] = useState([]);

  const load = useCallback(() => {
    if (!userId) return;
    setStatus("loading");
    fetchUser(userId)
      .then((user) => {
        setAccount(user);
        setStatus("ready");
      })
      .catch((e) => {
        if (isForbiddenError(e) || isUnauthorizedError(e)) {
          setStatus("forbidden");
        } else {
          setErrorMessage(e.message);
          setStatus("error");
        }
      });
  }, [userId]);

  useEffect(() => {
    if (!open || !userId) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId]);

  // ABRS v2.1 Phase 4 (Category 3 audit fix) — once the account (and thus
  // its Programme) has loaded, fetch that Programme's configured
  // Participation Structures for the Select/label below. Re-runs if the
  // drawer is reused for a different account without unmounting (the
  // programmeId dependency keys it correctly either way).
  useEffect(() => {
    if (!account || !account.programmeId) {
      setParticipationStructureOptions([]);
      return;
    }
    let cancelled = false;
    fetchProgrammeParticipationStructures(account.programmeId)
      .then((structures) => {
        if (cancelled) return;
        setParticipationStructureOptions([
          { value: "", label: "Unspecified / not applicable" },
          ...(structures || []).map((s) => ({ value: s.key, label: s.name })),
        ]);
      })
      .catch(() => {
        if (!cancelled) setParticipationStructureOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [account && account.programmeId]);

  // Phase 18: grant/revoke the backend's Access Override
  // (PATCH /api/users/:userId/access-override — see api/admin.js) and
  // reload this drawer's account data from the server afterward, the same
  // "act, then re-render from the server's own response" pattern
  // useAccountManagement's row actions use, rather than guessing the new
  // accessRestricted/access_override shape client-side.
  async function saveOverride(id, payload) {
    await setAccessOverride(id, payload);
    load();
  }

  // Same "act, then reload from the server's own response" pattern as
  // saveOverride above.
  async function saveSponsor(id, sponsorId) {
    await setLearnerSponsor(id, sponsorId);
    load();
  }

  // Same "act, then reload from the server's own response" pattern as
  // saveOverride/saveSponsor above. Uses the primary enrolment id already
  // resolved server-side by userView.js rather than re-deriving it here.
  async function saveParticipationStructure(nextValue) {
    if (!account?.primaryEnrollmentId) return;
    setParticipationError(null);
    setParticipationSaving(true);
    try {
      await setEnrolmentParticipationStructure(account.primaryEnrollmentId, nextValue || null);
      load();
    } catch (e) {
      setParticipationError(e.message);
    } finally {
      setParticipationSaving(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} side="right" title={account ? account.name : "Account details"}>
      {status === "loading" && (
        <div>
          <Skeleton height={16} width="60%" />
          <div style={{ marginTop: "var(--space-3)" }}>
            <Skeleton height={16} width="80%" />
          </div>
          <div style={{ marginTop: "var(--space-3)" }}>
            <Skeleton height={16} width="40%" />
          </div>
        </div>
      )}

      {status === "forbidden" && <UnauthorizedState description="You don't have permission to view this account." />}

      {status === "error" && <ErrorState description={errorMessage} />}

      {status === "ready" && account && (
        <div>
          <Field label="Role">
            <Badge tone="neutral">{account.role}</Badge>
            {account.role === "learner" && account.is_adult ? <span style={{ marginLeft: "var(--space-2)" }}>Adult learner</span> : null}
          </Field>

          <Field label="Email">{account.email}</Field>
          <Field label="Phone">{account.phone}</Field>
          {account.phone_network && <Field label="Mobile Money network">{account.phone_network}</Field>}
          <Field label="Country">{account.country ? countryName(account.country) : "—"}</Field>
          <Field label="Town / City of residence">{account.town}</Field>
          <Field label="Campus">{account.campus}</Field>
          <Field label="Registration date">{account.joined_date}</Field>

          <Field label="Account status">
            <StatusIndicator tone={account.status === "active" ? "positive" : account.status === "pending_payment" ? "caution" : "critical"}>{account.status}</StatusIndicator>
          </Field>

          {account.role === "learner" && (
            <>
              <Field label="Student code">{account.student_code}</Field>
              <Field label="Parent / guardian">{account.parentName}</Field>
              <Field label="School name">{account.school_name}</Field>
              <Field label="Programme">{account.programmeName}</Field>
              <Field label="Course Group(s)">{(account.courseGroupNames || []).length ? account.courseGroupNames.join(", ") : "— ungrouped modules only —"}</Field>
              <Field label="Class / Learning Group">{account.className}</Field>
              <Field label="Delivery mode">{account.deliveryMode === "ONLINE" ? "Online" : account.deliveryMode === "ON_CAMPUS" ? "On-campus" : account.deliveryMode === "HYBRID" ? "Hybrid" : account.deliveryMode}</Field>
              <Field label="Participation structure">
                {account.primaryEnrollmentId ? (
                  <>
                    <Select
                      value={account.participationStructure || ""}
                      disabled={participationSaving}
                      onChange={(e) => saveParticipationStructure(e.target.value)}
                    >
                      {participationStructureOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </Select>
                    {participationError && (
                      <p className="text-helper" style={{ marginTop: "var(--space-1)", color: "var(--color-danger, #b91c1c)" }}>
                        {participationError}
                      </p>
                    )}
                  </>
                ) : (
                  participationStructureLabel(account.participationStructure, participationStructureOptions)
                )}
              </Field>
              <Field label="Age">{account.age}</Field>
              <Field label="Education level">{account.education_level}</Field>
              <Field label="Owns a robotics kit">{account.own_robotics_kit == null ? "—" : account.own_robotics_kit ? "Yes" : "No"}</Field>
              <Field label="Payment status">
                <Badge tone={account.payment_status === "current" || account.payment_status === "waived" ? "success" : account.payment_status === "partial" ? "warning" : "danger"}>
                  {account.payment_status === "waived" ? "Waived (legacy)" : account.payment_status}
                </Badge>
                {account.sponsorId && account.payment_status !== "current" && account.payment_status !== "waived" && (
                  <p className="text-helper" style={{ marginTop: "var(--space-1)" }}>
                    Sponsor payment outstanding — {account.sponsorName} is responsible for this learner's fees but hasn't paid yet.
                  </p>
                )}
              </Field>
              <Field label="Corporate client">{account.corporateClientName || "—"}</Field>
              <Field label="Sponsor">
                {account.sponsorName ? (
                  <Badge tone={account.payment_status === "current" || account.payment_status === "waived" ? "success" : "warning"}>{account.sponsorName}</Badge>
                ) : (
                  "Not sponsored"
                )}
                <div style={{ marginTop: "var(--space-2)" }}>
                  <Button variant="ghost" size="sm" onClick={() => setSponsorModalOpen(true)}>
                    {account.sponsorId ? "Change sponsor" : "Attach sponsor"}
                  </Button>
                </div>
              </Field>
              <Field label="Courses">{(account.courseIds || []).map((mid) => moduleTitleById?.get(mid) || mid).join(", ")}</Field>
            </>
          )}

          {account.role === "parent" && (
            <>
              <Field label="Children">{(account.childIds || []).length} linked</Field>
              <Field label="Sponsor (coordinator account)">
                {account.sponsorName ? <Badge tone="neutral">{account.sponsorName}</Badge> : "Not linked to a sponsor"}
                <div style={{ marginTop: "var(--space-2)" }}>
                  <Button variant="ghost" size="sm" onClick={() => setSponsorModalOpen(true)}>
                    {account.sponsorId ? "Change sponsor" : "Attach sponsor"}
                  </Button>
                </div>
              </Field>
            </>
          )}

          {account.role === "instructor" && (
            <>
              <Field label="Classes teaching">{(account.classIds || []).map((cid) => classNameById?.get(cid) || cid).join(", ")}</Field>
              <Field label="Courses teaching">{(account.assignedCourseIds || []).map((mid) => moduleTitleById?.get(mid) || mid).join(", ")}</Field>
            </>
          )}

          {account.role === "admin" && (
            <>
              <Field label="Super Administrator">{account.isSuperAdmin ? "Yes" : "No"}</Field>
              <Field label="Role Template">
                {account.roleTemplateName || "No template"}
                {account.usesCustomPermissions ? " (custom permission set)" : ""}
              </Field>
            </>
          )}

          {(account.role === "learner" || account.role === "parent") && (
            <Field label="Access restriction">
              {account.accessRestricted ? (
                <Badge tone="danger">{account.accessRestrictedReason === "suspended" ? "Restricted (account suspended)" : "Restricted (payment)"}</Badge>
              ) : (
                <Badge tone="success">Not restricted</Badge>
              )}
              {account.access_override ? (
                <p className="text-helper" style={{ marginTop: "var(--space-1)" }}>
                  Access override active — {account.access_override_reason}
                  {account.access_override_expires_at ? ` (expires ${account.access_override_expires_at.slice(0, 16).replace("T", " ")})` : " (no expiry)"}
                </p>
              ) : null}
              <div style={{ marginTop: "var(--space-2)" }}>
                <Button variant="ghost" size="sm" onClick={() => setOverrideModalOpen(true)}>
                  {account.access_override ? "Revoke access override" : "Grant access override"}
                </Button>
              </div>
            </Field>
          )}
        </div>
      )}

      <AccessOverrideModal account={overrideModalOpen ? account : null} onClose={() => setOverrideModalOpen(false)} onSave={saveOverride} />
      <SponsorAssignModal account={sponsorModalOpen ? account : null} onClose={() => setSponsorModalOpen(false)} onSave={saveSponsor} />
    </Drawer>
  );
}
