import { useEffect, useRef, useState } from "react";
import styles from "./PublicSections.module.css";

/**
 * Scroll-triggered entrance wrapper for landing page content (Phase 29 —
 * motion pass). Adds `.revealVisible` the first time the element crosses
 * into the viewport, then stops observing — a one-shot reveal, not a
 * scroll-linked animation, so it stays cheap and never fights the user's
 * scroll direction. Falls back to immediately-visible when
 * IntersectionObserver isn't available. Actual motion (opacity/transform)
 * lives in PublicSections.module.css's .reveal/.revealVisible pair, and is
 * collapsed globally under prefers-reduced-motion by styles/motion.css.
 */
export default function Reveal({ as: Tag = "div", delay = 0, className = "", style, children, ...rest }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.unobserve(el);
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -10% 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      className={[styles.reveal, visible ? styles.revealVisible : "", className].filter(Boolean).join(" ")}
      style={delay ? { transitionDelay: `${delay}ms`, ...style } : style}
      {...rest}
    >
      {children}
    </Tag>
  );
}
