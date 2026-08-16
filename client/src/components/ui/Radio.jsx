import { forwardRef } from "react";
import styles from "./Choice.module.css";

const Radio = forwardRef(function Radio({ label, className = "", ...rest }, ref) {
  const input = <input ref={ref} type="radio" className={[styles.input, className].filter(Boolean).join(" ")} {...rest} />;
  if (!label) return input;
  return (
    <label className={styles.option}>
      {input}
      {label}
    </label>
  );
});

export default Radio;
