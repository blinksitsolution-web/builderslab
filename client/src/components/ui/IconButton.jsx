import { forwardRef } from "react";
import styles from "./IconButton.module.css";

/**
 * Icon-only button. `label` is required and becomes the accessible name
 * (aria-label) — icon-only controls must never rely on the icon alone to
 * convey meaning.
 * @param {"ghost"|"solid"} [variant]
 * @param {"sm"|"md"} [size]
 */
const IconButton = forwardRef(function IconButton({ label, variant = "ghost", size = "md", className = "", children, ...rest }, ref) {
  return (
    <button ref={ref} type="button" aria-label={label} title={label} className={[styles.iconBtn, styles[variant], styles[size], className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </button>
  );
});

export default IconButton;
