import { useRef } from "react";
import styles from "./Tabs.module.css";

/**
 * @param {{ key: string, label: string }[]} tabs
 * @param {string} active
 * @param {(key: string) => void} onChange
 */
export default function Tabs({ tabs, active, onChange }) {
  const refs = useRef({});

  function onKeyDown(e, index) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = tabs.length - 1;
    const nextTab = tabs[next];
    onChange(nextTab.key);
    refs.current[nextTab.key]?.focus();
  }

  return (
    <div className={styles.tablist} role="tablist">
      {tabs.map((tab, index) => {
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            ref={(el) => (refs.current[tab.key] = el)}
            role="tab"
            id={`tab-${tab.key}`}
            aria-selected={selected}
            aria-controls={`tabpanel-${tab.key}`}
            tabIndex={selected ? 0 : -1}
            className={[styles.tab, selected ? styles.active : ""].filter(Boolean).join(" ")}
            onClick={() => onChange(tab.key)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** Wraps a tab's content with the matching ARIA tabpanel wiring. */
export function TabPanel({ tabKey, active, children }) {
  if (tabKey !== active) return null;
  return (
    <div role="tabpanel" id={`tabpanel-${tabKey}`} aria-labelledby={`tab-${tabKey}`} className="animate-fade-in">
      {children}
    </div>
  );
}
