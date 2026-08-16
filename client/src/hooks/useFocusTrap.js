import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Traps Tab/Shift+Tab focus within the returned ref while `active` is true,
 * restores focus to the previously-focused element on close, and closes on
 * Escape via `onClose`. Shared by Modal and Drawer — both need identical
 * keyboard behavior per Phase 3's accessibility requirements.
 *
 * Bug fix: `onClose` used to sit in the setup effect's dependency array.
 * Any caller that passes an inline/non-memoized `onClose` (e.g. a local
 * `handleClose` wrapper, common across the app's modals) gets a new
 * function reference on every parent re-render — including the re-render
 * caused by typing a single character into a field inside the modal. That
 * re-ran this whole effect on every keystroke, which re-grabbed
 * `document.activeElement` and immediately refocused the first focusable
 * element in the modal (almost always the header's Close button), because
 * the effect couldn't tell "the modal just opened" apart from "onClose's
 * identity happened to change". `onClose` is now read from a ref that's
 * kept up to date separately, so the initial-focus/trap setup effect only
 * re-runs when `active` itself flips — typing no longer touches it.
 */
export function useFocusTrap(active, onClose) {
  const containerRef = useRef(null);
  const previouslyFocused = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return undefined;

    previouslyFocused.current = document.activeElement;
    const container = containerRef.current;
    const focusables = () => (container ? Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)) : []);

    const first = focusables()[0];
    (first || container)?.focus();

    function onKeyDown(e) {
      if (e.key === "Escape") {
        onCloseRef.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused.current && previouslyFocused.current.focus) {
        previouslyFocused.current.focus();
      }
    };
    // Intentionally excludes onClose — see comment above. active is the
    // only thing that should re-run focus-trap setup/teardown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return containerRef;
}
