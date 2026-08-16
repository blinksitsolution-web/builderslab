import styles from "./Skeleton.module.css";

/**
 * @param {number|string} [width]
 * @param {number|string} [height]
 * @param {"text"|"circle"|"rect"} [variant]
 */
export default function Skeleton({ width = "100%", height = 14, variant = "rect", className = "" }) {
  const dims = { width: typeof width === "number" ? `${width}px` : width, height: typeof height === "number" ? `${height}px` : height };
  return <span className={[styles.skeleton, styles[variant], className].filter(Boolean).join(" ")} style={dims} aria-hidden="true" />;
}
