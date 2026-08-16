import { useCallback, useEffect, useState } from "react";
import { useParentChildren } from "./useParentChildren";
import { fetchModules, fetchLessonsForModule, fetchAttendanceHistory } from "../../api/parent";
import { isAccessRestrictedError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * My Ward's Progress (Phase 22) — migrates legacy parentProgress()
 * (dashboard.html): one block per linked child (no Ward picker — legacy
 * shows every child at once here), each with per-module lesson-completion
 * %/quiz average, recent attendance, and submitted projects.
 *
 * GET /api/modules/:moduleId/lessons is gated by requireActiveAccessSelf,
 * which for a parent caller checks EVERY linked child at once (there's no
 * per-child scoping on that route — see server/src/middleware/auth.js).
 * So a single restricted ward can 403 lesson data for all of them; that's
 * surfaced as one page-level `lessonsRestricted` flag rather than
 * per-child, matching what the backend actually enforces. Attendance
 * (per-child-scoped) and quiz averages (already embedded in each child's
 * own record) are unaffected by that and still load independently.
 */
export function useParentProgress() {
  const { refresh } = useAuth();
  const { status: childrenStatus, errorMessage: childrenError, availableWards, reload: reloadChildren } = useParentChildren();
  const [status, setStatus] = useState("idle");
  const [lessonsRestricted, setLessonsRestricted] = useState(false);
  const [blocks, setBlocks] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);

  const load = useCallback(async () => {
    if (availableWards.length === 0) {
      setBlocks([]);
      setStatus("ready");
      return;
    }
    setStatus("loading");
    setLessonsRestricted(false);
    setErrorMessage(null);
    try {
      const modules = await fetchModules();
      const moduleById = Object.fromEntries(modules.map((m) => [m.id, m]));
      let restrictedHit = false;

      const nextBlocks = await Promise.all(
        availableWards.map(async (ward) => {
          const c = ward.data;
          const moduleIds = c.courseIds || [];

          const modRows = await Promise.all(
            moduleIds.map(async (mid) => {
              const mod = moduleById[mid];
              const prog = (c.progress || {})[mid] || { watched: {}, quizScores: {} };
              const scores = Object.values(prog.quizScores || {});
              const avgQuiz = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

              if (restrictedHit) {
                return { moduleId: mid, title: mod?.title || mid, pct: null, avgQuiz, restricted: true };
              }
              try {
                const lessons = await fetchLessonsForModule(mid);
                const pct = lessons.length ? Math.round((Object.keys(prog.watched || {}).length / lessons.length) * 100) : 0;
                return { moduleId: mid, title: mod?.title || mid, pct, avgQuiz, restricted: false };
              } catch (err) {
                if (isAccessRestrictedError(err)) {
                  restrictedHit = true;
                  return { moduleId: mid, title: mod?.title || mid, pct: null, avgQuiz, restricted: true };
                }
                return { moduleId: mid, title: mod?.title || mid, pct: null, avgQuiz, restricted: false };
              }
            })
          );

          const attendance = await fetchAttendanceHistory(c.id).catch(() => []);

          return {
            childId: c.id,
            childName: c.name,
            modules: modRows,
            attendance: attendance.slice(0, 10),
            projects: c.projects || [],
          };
        })
      );

      if (restrictedHit) setLessonsRestricted(true);
      setBlocks(nextBlocks);
      setStatus("ready");
    } catch (err) {
      if (isUnauthorizedError(err)) {
        await refresh();
        return;
      }
      setErrorMessage(err && err.message ? err.message : "Couldn't load your ward's progress.");
      setStatus("error");
    }
  }, [availableWards, refresh]);

  useEffect(() => {
    if (childrenStatus === "ready") load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childrenStatus, availableWards.map((w) => w.id).join(",")]);

  return { childrenStatus, childrenError, availableWards, reloadChildren, status, lessonsRestricted, blocks, errorMessage, reload: load };
}
