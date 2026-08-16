import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { addChild } from "../../api/parent";
import { fetchPublicSettings, fetchOpenModules, fetchRegistrationOfferings, fetchProgrammesFor, fetchClassesFor } from "../../api/public";
import LearnerBlock from "../auth/LearnerBlock";
import { PageHeader, Card, Button, Alert, Skeleton, FormField, Input, Select, Radio, Modal } from "../../components/ui";

/**
 * Add a child/learner. Two shapes, since Kids STEM and Adult Professional/
 * Corporate Training/Bootcamp are structurally different registrations
 * (module checklist + a default entry class vs an explicit Offering Type
 * → Programme → Batch/Cohort pick, no module requirement, is_adult=1):
 *
 * - An ordinary parent (no sponsor_id) only ever sees the original Kids
 *   STEM form below — completely unchanged from before this feature.
 * - A coordinator (sponsor_id set — see the sponsorship/coordinator work)
 *   has an admin-set `coordinator_scope` ('child' | 'adult' | 'both').
 *   'child'/'adult' lock the form to that single shape; 'both' shows a
 *   toggle so the coordinator picks per learner, exactly as requested.
 *
 * Both shapes post to the same POST /:parentId/children endpoint (see
 * server/src/routes/users.js), just with a different `learnerType` and
 * field set — the backend is the actual authority on what a given
 * account is allowed to submit, this is only about what to *show*.
 */
export default function AddChildPage() {
  const { user: authUser } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  // Part 8 legacy remediation — a Sponsor Account coordinator no longer
  // registers learners one at a time here; Bulk Registration
  // (SponsorBulkRegistrationPage.jsx) is now the only path for a
  // coordinator, so a coordinator hitting this URL is redirected
  // straight there instead of rendering the individual form below. An
  // ordinary parent (no sponsor_id) is completely unaffected — the form
  // beneath this guard is byte-for-byte the same as before.
  useEffect(() => {
    if (authUser?.sponsor_id) {
      navigate("/app/parent/bulk-registration", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.sponsor_id]);

  const scope = authUser?.sponsor_id ? authUser?.coordinator_scope || "child" : "child";
  const canPickType = scope === "both";
  const [learnerType, setLearnerType] = useState(scope === "adult" ? "adult" : "child");

  const [loadStatus, setLoadStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // Shown in a modal after a successful add rather than an instant
  // navigate-away, so the credentials the success toast already claims
  // to be "shown" actually are (Stage 4A) — also viewable later from
  // Sponsored Learners (see SponsoredLearnersPage.jsx), since these are
  // now persisted server-side until the learner's own first login.
  const [createdCredentials, setCreatedCredentials] = useState(null);

  // ---- Child (Kids STEM) fields — unchanged from before ---------------
  const [campusOptions, setCampusOptions] = useState([]);
  const [modules, setModules] = useState([]);
  const [learner, setLearner] = useState({ name: "", age: "", campus: "", schoolName: "", ownRoboticsKit: false });
  const [selectedModuleIds, setSelectedModuleIds] = useState([]);

  // ---- Adult fields — new -------------------------------------------
  const [adult, setAdult] = useState({ name: "", email: "", phone: "", campus: "", educationLevel: "None", ownRoboticsKit: false });
  const [offerings, setOfferings] = useState([]);
  const [offeringTypeId, setOfferingTypeId] = useState("");
  const [programmes, setProgrammes] = useState([]);
  const [programmeId, setProgrammeId] = useState("");
  const [classes, setClasses] = useState([]);
  const [classId, setClassId] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, openModules] = await Promise.all([fetchPublicSettings(), fetchOpenModules()]);
        if (cancelled) return;
        setCampusOptions((settings.campuses || []).map((c) => c.name));
        setModules(openModules);
        if (["adult", "both"].includes(scope)) {
          const offeringsResult = await fetchRegistrationOfferings();
          if (cancelled) return;
          setOfferings(offeringsResult.filter((o) => o.slug !== "kids_stem"));
        }
        setLoadStatus("ready");
      } catch {
        if (!cancelled) setLoadStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Programme list follows the chosen Offering Type; Batch/Cohort list
  // follows the chosen Programme — same cascading pattern RegisterPage.jsx
  // already uses for its own Offering → Programme → Batch picker.
  useEffect(() => {
    if (!offeringTypeId) {
      setProgrammes([]);
      setProgrammeId("");
      return;
    }
    let cancelled = false;
    fetchProgrammesFor({ offeringTypeId, audience: "adult" }).then((result) => {
      if (!cancelled) setProgrammes(result);
    });
    return () => {
      cancelled = true;
    };
  }, [offeringTypeId]);

  useEffect(() => {
    if (!programmeId) {
      setClasses([]);
      setClassId("");
      return;
    }
    let cancelled = false;
    fetchClassesFor(programmeId).then((result) => {
      if (!cancelled) setClasses(result);
    });
    return () => {
      cancelled = true;
    };
  }, [programmeId]);

  const pageTitle = useMemo(() => (canPickType ? "Add a learner" : learnerType === "adult" ? "Add an adult learner" : "Add a child"), [canPickType, learnerType]);

  function toggleModule(id) {
    setSelectedModuleIds((current) => (current.includes(id) ? current.filter((m) => m !== id) : [...current, id]));
  }

  async function handleSubmitChild() {
    if (!learner.name.trim()) {
      setError("Enter the child's name.");
      return;
    }
    if (learner.age !== "" && learner.age !== null && learner.age !== undefined) {
      const ageNum = Number(learner.age);
      if (!Number.isInteger(ageNum) || ageNum < 3 || ageNum > 21) {
        setError("Age must be a whole number between 3 and 21.");
        return;
      }
    }
    if (selectedModuleIds.length === 0) {
      setError("Choose at least one module.");
      return;
    }
    return addChild(authUser.id, {
      learnerType: "child",
      name: learner.name.trim(),
      age: learner.age || null,
      campus: learner.campus || null,
      schoolName: learner.schoolName || null,
      ownRoboticsKit: learner.ownRoboticsKit,
      // Pre-existing bug fix — identical to the RegisterPage.jsx
      // "Choose at least one module" bug fixed earlier: server/src/routes/users.js's
      // POST /:parentId/children reads req.body.courseIds, not `modules`.
      // This sibling "Add another child" flow had the exact same mismatch
      // and was never touched when the original registration flow was fixed.
      courseIds: selectedModuleIds,
    });
  }

  async function handleSubmitAdult() {
    if (!adult.name.trim() || !adult.email.trim()) {
      setError("Enter the learner's name and email.");
      return;
    }
    if (!classId) {
      setError("Choose an Offering, Programme, and Batch/Cohort.");
      return;
    }
    return addChild(authUser.id, {
      learnerType: "adult",
      name: adult.name.trim(),
      email: adult.email.trim(),
      phone: adult.phone.trim() || null,
      campus: adult.campus || null,
      educationLevel: adult.educationLevel,
      ownRoboticsKit: adult.ownRoboticsKit,
      classId,
    });
  }

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      const result = await (learnerType === "adult" ? handleSubmitAdult() : handleSubmitChild());
      if (!result) {
        // Client-side validation already set an error message and
        // returned undefined rather than calling the API.
        setSubmitting(false);
        return;
      }
      toast.success(result.message || "Learner added.");
      setCreatedCredentials({
        name: learnerType === "adult" ? adult.name : learner.name,
        username: result.learnerLoginEmail,
        password: result.learnerPassword,
        studentCode: result.studentCode,
      });
      setSubmitting(false);
    } catch (e) {
      setError(e.message || "Couldn't add this learner.");
      setSubmitting(false);
    }
  }

  if (authUser?.sponsor_id) return null; // redirecting to Bulk Registration (see effect above)

  if (loadStatus === "loading") {
    return (
      <div>
        <PageHeader title={pageTitle} />
        <Skeleton height={280} width="100%" />
      </div>
    );
  }

  if (loadStatus === "error") {
    return (
      <div>
        <PageHeader title={pageTitle} />
        <Alert variant="danger">Couldn't load the registration catalog. Please try again.</Alert>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={pageTitle}
        description={
          learnerType === "adult"
            ? "Registers an adult learner directly into a Programme and Batch/Cohort."
            : "This adds a new learner to your account. Complete payment afterwards to activate their access, same as your first registration."
        }
      />

      <Card padding>
        {canPickType && (
          <div style={{ display: "flex", gap: "var(--space-4)", marginBottom: "var(--space-4)" }}>
            <Radio name="learnerType" label="Child (Kids STEM)" checked={learnerType === "child"} onChange={() => setLearnerType("child")} />
            <Radio name="learnerType" label="Adult (Professional/Corporate/Bootcamp)" checked={learnerType === "adult"} onChange={() => setLearnerType("adult")} />
          </div>
        )}

        {learnerType === "child" ? (
          <>
            <LearnerBlock index={0} learner={learner} campusOptions={campusOptions} onChange={(_i, next) => setLearner(next)} onRemove={() => {}} />

            <div style={{ marginTop: "var(--space-2)" }}>
              <label className="text-label" style={{ display: "block", marginBottom: "var(--space-2)" }}>
                Modules
              </label>
              {modules.length === 0 ? (
                <p className="text-helper">No module is open for new enrolment right now — please check back soon or contact us.</p>
              ) : (
                <div style={{ display: "grid", gap: "var(--space-2)" }}>
                  {modules.map((m) => (
                    <label
                      key={m.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--space-2)",
                        border: "1px solid var(--border-default)",
                        borderRadius: "var(--radius-md)",
                        padding: "var(--space-2) var(--space-3)",
                        cursor: "pointer",
                      }}
                    >
                      <input type="checkbox" checked={selectedModuleIds.includes(m.id)} onChange={() => toggleModule(m.id)} />
                      <span>
                        <strong>{m.id}</strong> — {m.title}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="grid-2">
              <FormField label="Full name" required>
                <Input value={adult.name} onChange={(e) => setAdult((a) => ({ ...a, name: e.target.value }))} />
              </FormField>
              <FormField label="Email" required helperText="This becomes their login.">
                <Input type="email" value={adult.email} onChange={(e) => setAdult((a) => ({ ...a, email: e.target.value }))} />
              </FormField>
            </div>
            <div className="grid-2" style={{ marginTop: "var(--space-3)" }}>
              <FormField label="Phone">
                <Input value={adult.phone} onChange={(e) => setAdult((a) => ({ ...a, phone: e.target.value }))} />
              </FormField>
              <FormField label="Campus">
                <Select value={adult.campus} onChange={(e) => setAdult((a) => ({ ...a, campus: e.target.value }))}>
                  <option value="">— none / self-paced —</option>
                  {campusOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>

            <div style={{ marginTop: "var(--space-4)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--border-subtle)" }}>
              <p className="text-label" style={{ marginBottom: "var(--space-3)" }}>
                Offering, Programme &amp; Batch/Cohort
              </p>
              <div className="grid-2">
                <FormField label="Offering">
                  <Select
                    value={offeringTypeId}
                    onChange={(e) => {
                      setOfferingTypeId(e.target.value);
                      setProgrammeId("");
                      setClassId("");
                    }}
                  >
                    <option value="">— select —</option>
                    {offerings.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Programme">
                  <Select
                    value={programmeId}
                    onChange={(e) => {
                      setProgrammeId(e.target.value);
                      setClassId("");
                    }}
                    disabled={!offeringTypeId}
                  >
                    <option value="">— select —</option>
                    {programmes.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </div>
              <div style={{ marginTop: "var(--space-3)" }}>
                <FormField label="Batch / Cohort">
                  <Select value={classId} onChange={(e) => setClassId(e.target.value)} disabled={!programmeId}>
                    <option value="">— select —</option>
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </div>
            </div>
          </>
        )}

        {error && (
          <div style={{ marginTop: "var(--space-3)" }}>
            <Alert variant="danger">{error}</Alert>
          </div>
        )}

        <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
          <Button onClick={handleSubmit} loading={submitting} disabled={submitting}>
            {learnerType === "adult" ? "Add adult learner" : "Add child"}
          </Button>
          <Button variant="ghost" onClick={() => navigate("/app/parent")} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </Card>

      <Modal
        open={!!createdCredentials}
        onClose={() => navigate("/app/parent")}
        title="Learner added — save these credentials"
        footer={
          <>
            <Button variant="secondary" onClick={() => window.print()}>
              🖨 Print
            </Button>
            <Button onClick={() => navigate("/app/parent")}>Done</Button>
          </>
        }
      >
        {createdCredentials && (
          <div>
            <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
              Share these with {createdCredentials.name} so they can sign in. You can view them again later from Sponsored Learners.
            </p>
            <div className="grid-2" style={{ gap: "var(--space-2)" }}>
              <div>
                <span className="text-label">Username</span>
                <p style={{ fontFamily: "monospace" }}>{createdCredentials.username}</p>
              </div>
              <div>
                <span className="text-label">Password</span>
                <p style={{ fontFamily: "monospace" }}>{createdCredentials.password}</p>
              </div>
              <div>
                <span className="text-label">Student ID</span>
                <p style={{ fontFamily: "monospace" }}>{createdCredentials.studentCode}</p>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
