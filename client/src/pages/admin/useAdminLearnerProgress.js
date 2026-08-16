import { useCallback, useEffect, useState } from "react";
import { fetchAccounts, fetchUser, fetchLessonsForModule } from "../../api/admin";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Learner Progress (final admin migration pass). Migrates legacy
 * adminLearnerProgress() (dashboard.html) exactly — there is no dedicated
 * report endpoint for this; legacy assembles it client-side from
 * GET /api/users (role=learner), GET /api/users/:id (each learner's
 * enrolled modules + watched-lesson progress), and
 * GET /api/modules/:id/lessons (each enrolled module's lesson count), then
 * computes watched/total per module. This reproduces that exact data flow
 * rather than inventing a new backend endpoint (see api/admin.js).
 *
 * Lesson lists are cached per module across learners in this same report
 * run — legacy re-fetches per learner per module, which is correct but
 * wasteful when many learners share the same modules; caching here doesn't
 * change the computed result, only how many times an identical
 * GET /api/modules/:id/lessons call is made.
 */
export function useAdminLearnerProgress() {
  const { refresh } = useAuth();

  const [status, setStatus] = useState("loading"); // loading | ready | error | forbidden
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const learners = await fetchAccounts({ role: "learner" });
      const lessonCountCache = new Map();
      async function lessonCountFor(moduleId) {
        if (lessonCountCache.has(moduleId)) return lessonCountCache.get(moduleId);
        const lessons = await fetchLessonsForModule(moduleId);
        lessonCountCache.set(moduleId, lessons.length);
        return lessons.length;
      }

      const computed = await Promise.all(
        learners.map(async (l) => {
          const full = await fetchUser(l.id);
          const modules = full.courseIds || [];
          const moduleSummaries = await Promise.all(
            modules.map(async (mid) => {
              const totalLessons = await lessonCountFor(mid);
              const prog = (full.progress || {})[mid] || { watched: {} };
              const watchedCount = Object.keys(prog.watched || {}).length;
              const pct = totalLessons ? Math.round((watchedCount / totalLessons) * 100) : 0;
              return { moduleId: mid, pct };
            })
          );
          return { id: l.id, name: l.name, campus: l.campus, moduleSummaries };
        })
      );

      setRows(computed);
      setStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      if (isForbiddenError(e)) {
        setStatus("forbidden");
        setError(e.message);
        return;
      }
      setStatus("error");
      setError(e.message);
    }
  }, [refresh]);

  useEffect(() => {
    load();
  }, [load]);

  return { status, error, rows, reload: load };
}
