import { useEffect, useRef } from "react";

/**
 * Keeps the server's copy of the learner's in-progress answers current so
 * that if the attempt ends via a server-detected expiry (rather than a
 * live submit/violation call that already carries the current answers),
 * finalizing still uses the learner's actual last-known selections instead
 * of an empty answer set (see FIX_NOTES_exam_ca_closing_timer_violation_controls.md,
 * "New /answers autosave endpoint"). This never grades or ends anything by
 * itself — it only calls the existing autosave endpoint.
 *
 * @param {any[]} answers - current in-memory answers array
 * @param {(answers:any[]) => Promise<any>} saveFn
 * @param {boolean} active - only autosaves while true (e.g. attempt status === "in_progress")
 */
export function useAnswerAutosave(answers, saveFn, active) {
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const saveFnRef = useRef(saveFn);
  saveFnRef.current = saveFn;

  const debounceHandle = useRef(null);
  const lastSaved = useRef(null);

  useEffect(() => {
    if (!active) return undefined;

    function saveNow() {
      const current = answersRef.current;
      // Skip a redundant save if nothing has changed since the last one —
      // the periodic safety-net interval would otherwise hit the endpoint
      // every 15s even with no new selections.
      const serialized = JSON.stringify(current);
      if (serialized === lastSaved.current) return;
      lastSaved.current = serialized;
      saveFnRef.current(current).catch(() => {
        // A failed autosave isn't shown as a hard error — the same
        // selections are retried on the next debounce/interval tick, and
        // final submission always sends the complete answers array
        // directly regardless of autosave status.
        lastSaved.current = null;
      });
    }

    const intervalHandle = setInterval(saveNow, 15000);
    return () => {
      clearInterval(intervalHandle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!active) return undefined;
    if (debounceHandle.current) clearTimeout(debounceHandle.current);
    debounceHandle.current = setTimeout(() => {
      const serialized = JSON.stringify(answersRef.current);
      if (serialized === lastSaved.current) return;
      lastSaved.current = serialized;
      saveFnRef.current(answersRef.current).catch(() => {
        lastSaved.current = null;
      });
    }, 800);
    return () => {
      if (debounceHandle.current) clearTimeout(debounceHandle.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, active]);
}
