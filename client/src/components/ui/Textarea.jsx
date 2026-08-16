import { forwardRef } from "react";
import styles from "./FormControls.module.css";

const Textarea = forwardRef(function Textarea({ invalid = false, className = "", ...rest }, ref) {
  return <textarea ref={ref} className={[styles.control, styles.textarea, invalid ? styles.invalid : "", className].filter(Boolean).join(" ")} {...rest} />;
});

export default Textarea;
