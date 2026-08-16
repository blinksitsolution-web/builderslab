import styles from "./PageContainer.module.css";

/** Consistent max-width + responsive padding wrapper for page content, sitting inside AppShell's content area. */
export default function PageContainer({ children, className = "" }) {
  return <div className={[styles.container, className].filter(Boolean).join(" ")}>{children}</div>;
}
