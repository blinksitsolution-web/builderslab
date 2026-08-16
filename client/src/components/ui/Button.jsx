import { forwardRef } from "react";
import Spinner from "./Spinner";
import styles from "./Button.module.css";

/**
 * @param {"primary"|"secondary"|"ghost"|"danger"} [variant]
 * @param {"sm"|"md"|"lg"} [size]
 * @param {boolean} [loading] - shows an inline spinner and disables interaction, keeping the button's width stable
 * @param {boolean} [fullWidth]
 */
const Button = forwardRef(function Button(
  { variant = "primary", size = "md", loading = false, fullWidth = false, disabled = false, type = "button", className = "", children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={[styles.btn, styles[variant], styles[size], fullWidth ? styles.fullWidth : "", className].filter(Boolean).join(" ")}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner size="sm" className={styles.spinner} aria-hidden="true" />}
      <span className={loading ? styles.loadingLabel : undefined}>{children}</span>
    </button>
  );
});

export default Button;
