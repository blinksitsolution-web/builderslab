import { useEffect, useRef, useState } from "react";

function formatRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

/**
 * Drives a live countdown from a server-frozen `deadlineAt` and listens for
 * the learner leaving the tab/window (Page Visibility API — the same
 * "strongest reliable, browser-supported signal" reasoning as the legacy
 * dashboard.html implementation; it cannot catch every possible OS-level
 * window arrangement, no browser API can promise that).
 *
 * CRITICAL: this is display-only. It never computes or extends a deadline —
 * `deadlineAt` always comes verbatim from the server (attempt.deadlineAt).
 * Refreshing the page and re-mounting this hook with the same deadlineAt
 * cannot reset or extend anything; the interval simply starts re-counting
 * down to the same frozen instant.
 *
 * @param {object} opts
 * @param {string|null} opts.deadlineAt - server-frozen ISO deadline, or null for an untimed/no-closing-date attempt
 * @param {boolean} opts.active - only ticks/listens while true (e.g. attempt status === "in_progress")
 * @param {() => void} opts.onExpire - called once, client-side-detected expiry (the server is re-checked by whatever request follows — this never finalizes anything itself)
 * @param {() => Promise<{ended:boolean, attempt:object}>} opts.reportViolation - calls the backend violation endpoint
 * @param {(res: {ended:boolean, attempt:object}) => void} opts.onViolationWarning - first violation, backend says attempt remains active
 * @param {(res: {ended:boolean, attempt:object}) => void} opts.onViolationEnd - second violation (or the backend discovered the attempt was already over), backend says attempt is over
 */
export function useAssessmentMonitor({ deadlineAt, active, onExpire, reportViolation, onViolationWarning, onViolationEnd }) {
  const [remainingMs, setRemainingMs] = useState(deadlineAt ? new Date(deadlineAt).getTime() - Date.now() : null);
  const [violationWarning, setViolationWarning] = useState(false);

  // Keep the latest callbacks/deadline in refs so the effect below doesn't
  // need to re-subscribe (and doesn't miss an update) every render.
  const stateRef = useRef({});
  stateRef.current = { deadlineAt, onExpire, reportViolation, onViolationWarning, onViolationEnd };

  useEffect(() => {
    setRemainingMs(deadlineAt ? new Date(deadlineAt).getTime() - Date.now() : null);
  }, [deadlineAt]);

  useEffect(() => {
    if (!active) return undefined;
    let ended = false;
    let intervalHandle = null;

    function tick() {
      const { deadlineAt: dl, onExpire: expire } = stateRef.current;
      if (ended || !dl) return;
      const ms = new Date(dl).getTime() - Date.now();
      setRemainingMs(ms);
      if (ms <= 0) {
        ended = true;
        if (intervalHandle) clearInterval(intervalHandle);
        expire();
      }
    }

    let reporting = false;

    function handleVisibilityChange() {
      if (ended || reporting || document.visibilityState !== "hidden") return;
      reporting = true;
      const { reportViolation: report, onViolationWarning: warn, onViolationEnd: end } = stateRef.current;
      report()
        .then((res) => {
          if (ended) return;
          if (res.ended) {
            ended = true;
            if (intervalHandle) clearInterval(intervalHandle);
            setViolationWarning(false);
            end(res);
          } else {
            setViolationWarning(true);
            warn(res);
          }
        })
        .catch(() => {})
        .finally(() => {
          reporting = false;
        });
    }

    if (stateRef.current.deadlineAt) {
      tick();
      intervalHandle = setInterval(tick, 1000);
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      ended = true;
      if (intervalHandle) clearInterval(intervalHandle);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [active]);

  return {
    remainingMs,
    remainingLabel: remainingMs == null ? null : formatRemaining(remainingMs),
    approachingExpiry: remainingMs != null && remainingMs > 0 && remainingMs <= 60000,
    violationWarning,
  };
}
