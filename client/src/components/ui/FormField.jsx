import { Children, cloneElement, isValidElement, useId } from "react";
import styles from "./FormField.module.css";

/**
 * Wraps a single form control (Input/Select/Textarea/Checkbox/Radio) with a
 * label, optional helper text, and an error message. Wires up `id`,
 * `aria-describedby`, and `aria-invalid` on the child automatically so
 * every field in the system gets the same accessible label/description
 * association without each portal having to do it by hand.
 *
 * @param {string} label
 * @param {string} [helperText]
 * @param {string} [error]
 * @param {boolean} [required]
 */
export default function FormField({ label, helperText, error, required = false, children, className = "" }) {
  const autoId = useId();
  const child = Children.only(children);
  const fieldId = (isValidElement(child) && child.props.id) || autoId;
  const helperId = `${fieldId}-helper`;
  const errorId = `${fieldId}-error`;
  const describedBy = [helperText && helperId, error && errorId].filter(Boolean).join(" ") || undefined;

  const control = isValidElement(child)
    ? cloneElement(child, {
        id: fieldId,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        invalid: !!error,
      })
    : child;

  return (
    <div className={[styles.field, className].filter(Boolean).join(" ")}>
      <label htmlFor={fieldId} className={styles.label}>
        {label}
        {required && (
          <span className={styles.required} aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </label>
      {control}
      {helperText && !error && (
        <p id={helperId} className={styles.helper}>
          {helperText}
        </p>
      )}
      {error && (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
