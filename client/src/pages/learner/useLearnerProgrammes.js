import { useCallback, useEffect, useState } from "react";
import { fetchEnrolments } from "../../api/parent";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * My Programmes (final migration pass) — migrates legacy
 * learnerProgrammes()/renderMyProgrammesPanel() (dashboard.html) for a
 * learner viewing their own account. `fetchEnrolments` is the exact same
 * generic wrapper ParentProgrammesPage/useParentProgrammes already use
 * (api/parent.js's GET /api/enrolments/mine?targetUserId=<id> —
 * server/src/routes/enrolments.js's resolveTargetLearner() already
 * accepts the learner calling for themself, not just a parent calling on
 * a child's behalf), so this reuses it directly rather than adding a
 * learner-specific duplicate — same pattern useLearnerPayments.js already
 * established with fetchPayments.
 *
 * Legacy only shows this panel to adult learners at all — a non-adult
 * learner's additional-programme enrolment is handled entirely by their
 * parent's portal (learnerProgrammes() returns a static message and never
 * calls DTL.myEnrolments for a non-adult). This hook mirrors that: it
 * does nothing (and makes no request) when the account isn't an adult
 * learner.
 */
export function useLearnerProgrammes() {
  const { user: authUser, refresh } = useAuth();
  const isAdult = !!authUser?.is_adult;
  const [status, setStatus] = useState(isAdult ? "loading" : "not-applicable");
  const [errorMessage, setErrorMessage] = useState(null);
  const [enrolments, setEnrolments] = useState([]);

  const load = useCallback(async () => {
    if (!authUser || !isAdult) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const rows = await fetchEnrolments(authUser.id);
      setEnrolments(rows);
      setStatus("ready");
    } catch (err) {
      if (isUnauthorizedError(err)) {
        await refresh();
        return;
      }
      setErrorMessage(err && err.message ? err.message : "Couldn't load programmes.");
      setStatus("error");
    }
  }, [authUser, isAdult, refresh]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id, isAdult]);

  return { isAdult, status, errorMessage, enrolments, reload: load };
}
