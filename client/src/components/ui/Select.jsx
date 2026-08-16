import { forwardRef } from "react";
import styles from "./FormControls.module.css";

/**
 * Wraps a native <select> (kept native deliberately — a custom listbox
 * reimplementation is worse for keyboard/screen-reader users on every
 * platform than the OS-native picker).
 */
const Select = forwardRef(function Select({ invalid = false, className = "", children, ...rest }, ref) {
  return (
    <div className={styles.selectWrap}>
      <select ref={ref} className={[styles.control, styles.select, invalid ? styles.invalid : "", className].filter(Boolean).join(" ")} {...rest}>
        {children}
      </select>
      <svg className={styles.selectIcon} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
});

export default Select;
