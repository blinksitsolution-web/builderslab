import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import IconButton from "./IconButton";
import styles from "./Drawer.module.css";

/**
 * @param {boolean} open
 * @param {() => void} onClose
 * @param {"left"|"right"} [side]
 * @param {string} [title]
 */
export default function Drawer({ open, onClose, side = "left", title, children }) {
  const containerRef = useFocusTrap(open, onClose);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div
        ref={containerRef}
        className={[styles.panel, styles[side]].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={title || "Navigation"}
        tabIndex={-1}
      >
        <div className={styles.header}>
          {title && <span className={styles.title}>{title}</span>}
          <IconButton label="Close menu" onClick={onClose} className={styles.close}>
            <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </IconButton>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>,
    document.body
  );
}
