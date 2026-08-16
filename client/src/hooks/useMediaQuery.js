import { useEffect, useState } from "react";
import { BREAKPOINTS } from "../lib/breakpoints";

/**
 * Subscribes to a raw media query string, e.g. useMediaQuery("(min-width: 768px)").
 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (typeof window !== "undefined" ? window.matchMedia(query).matches : false));

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** Convenience: true once the viewport reaches the design system's "md" breakpoint (tablet+). */
export function useIsDesktop() {
  return useMediaQuery(`(min-width: ${BREAKPOINTS.lg}px)`);
}

/** True when the user's OS is set to reduce motion — components use this to skip JS-driven animation (CSS handles its own via motion.css). */
export function usePrefersReducedMotion() {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
