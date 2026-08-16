import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import IconButton from "./IconButton";
import styles from "./Modal.module.css";

/**
 * @param {boolean} open
 * @param {() => void} onClose
 * @param {string} title - required: becomes the dialog's accessible name
 * @param {"sm"|"md"|"lg"} [size]
 * @param {React.ReactNode} [footer]
 */
export default function Modal({ open, onClose, title, size = "md", footer, children }) {
  const containerRef = useFocusTrap(open, onClose);

  // Lock background scroll while open — a modal covering the page but
  // leaving the page scrollable underneath it is a common, easily-avoided
  // usability bug.
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
      <div ref={containerRef} className={[styles.dialog, styles[size]].join(" ")} role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1}>
        <div className={styles.header}>
          <h2 id="modal-title" className={styles.title}>
            {title}
          </h2>
          <IconButton label="Close dialog" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </IconButton>
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
