import { forwardRef } from "react";
import styles from "./FormControls.module.css";

const Input = forwardRef(function Input({ invalid = false, className = "", ...rest }, ref) {
  return <input ref={ref} className={[styles.control, invalid ? styles.invalid : "", className].filter(Boolean).join(" ")} {...rest} />;
});

export default Input;
