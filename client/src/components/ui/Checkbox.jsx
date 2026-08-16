import { forwardRef } from "react";
import styles from "./Choice.module.css";

/**
 * Native checkbox with its own inline label — used for standalone
 * boolean options (terms acceptance, "remember me", table row select).
 * For a checkbox inside a validated form field with helper/error text,
 * wrap in FormField instead and omit `label` here.
 */
const Checkbox = forwardRef(function Checkbox({ label, className = "", ...rest }, ref) {
  const input = <input ref={ref} type="checkbox" className={[styles.input, className].filter(Boolean).join(" ")} {...rest} />;
  if (!label) return input;
  return (
    <label className={styles.option}>
      {input}
      {label}
    </label>
  );
});

export default Checkbox;
