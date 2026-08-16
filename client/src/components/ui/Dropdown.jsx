import { useEffect, useRef, useState } from "react";
import styles from "./Dropdown.module.css";

/**
 * Lightweight action menu — for a handful of commands (row actions, the
 * profile menu), not a full listbox. For choosing among options in a form,
 * use Select (native) instead; this is specifically for triggering
 * actions.
 *
 * @param {React.ReactNode} trigger
 * @param {{ label: string, onSelect: () => void, danger?: boolean, disabled?: boolean }[]} items
 * @param {"start"|"end"} [align]
 */
export default function Dropdown({ trigger, items, align = "end" }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    // Move focus to the first menu item so keyboard users land inside the menu.
    menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.root} ref={rootRef}>
      <button type="button" className={styles.trigger} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {trigger}
      </button>
      {open && (
        <div ref={menuRef} role="menu" className={[styles.menu, styles[align]].join(" ")}>
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={[styles.item, item.danger ? styles.danger : ""].filter(Boolean).join(" ")}
              onClick={() => {
                setOpen(false);
                item.onSelect?.();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
