import { useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import styles from "./NavList.module.css";

/**
 * Renders a nav item's icon (every role's nav items carry one — see
 * navConfig.js). Kept as its own tiny component so a future item without
 * an icon never leaves a layout gap (the flex row simply has one less
 * child) rather than crashing.
 */
function ItemIcon({ icon: Icon }) {
  if (!Icon) return null;
  return <Icon className={styles.icon} size={18} aria-hidden="true" strokeWidth={1.75} />;
}

function isItemActive(item, pathname) {
  if (!item.to) return false;
  return item.to === "/app" ? pathname === "/app" : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/**
 * A single flat link — either a real React route (NavLink, so it gets
 * live active-state styling) or a `legacy: true` bridge to a
 * still-static dashboard.html anchor (plain <a>, since react-router
 * can't own that navigation).
 */
function LinkItem({ item, onNavigate, theme }) {
  const className = ({ isActive }) => [styles.item, styles[theme], isActive ? styles.active : ""].filter(Boolean).join(" ");
  if (item.legacy) {
    return (
      <a href={item.to} onClick={onNavigate} className={[styles.item, styles[theme]].filter(Boolean).join(" ")}>
        <ItemIcon icon={item.icon} />
        <span className={styles.label}>{item.label}</span>
      </a>
    );
  }
  return (
    <NavLink to={item.to} end={item.to === "/app"} onClick={onNavigate} className={className}>
      <ItemIcon icon={item.icon} />
      <span className={styles.label}>{item.label}</span>
    </NavLink>
  );
}

/**
 * A collapsible section (Admin nav — see navConfig.js's ADMIN_NAV_STRUCTURE).
 * Starts expanded automatically when the current route belongs to one of
 * its items, collapsed otherwise, so a many-item admin nav stays scannable
 * without ever hiding where you currently are.
 */
function GroupItem({ group, onNavigate, theme, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const groupId = `navgroup-${group.key}`;

  return (
    <div className={styles.group}>
      <button
        type="button"
        className={[styles.groupHeader, styles[theme]].filter(Boolean).join(" ")}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={groupId}
      >
        <ItemIcon icon={group.icon} />
        <span className={styles.label}>{group.label}</span>
        <ChevronDown className={[styles.chevron, open ? styles.chevronOpen : ""].filter(Boolean).join(" ")} size={16} aria-hidden="true" />
      </button>
      <div id={groupId} className={[styles.groupBody, open ? styles.groupBodyOpen : ""].filter(Boolean).join(" ")}>
        <ul className={styles.sublist}>
          {group.items.map((item) => (
            <li key={item.to}>
              <LinkItem item={item} onNavigate={onNavigate} theme={theme} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Primary nav renderer, shared by the desktop Sidebar (theme="dark") and
 * the MobileNavDrawer (theme="light"). Each entry in `items` is either a
 * plain link (every non-admin role's flat array — unchanged) or, for the
 * Admin role, may instead carry an `items` array, in which case it's
 * rendered as a collapsible group instead of a single link. The group
 * whose route is currently active auto-expands on first render (see
 * isItemActive), so grouping never hides the page you're already on.
 */
export default function NavList({ items, onNavigate, theme = "dark" }) {
  const { pathname } = useLocation();

  // Computed once per mount (and again if the item list itself changes,
  // e.g. permissions load in) rather than on every render, so toggling a
  // group open/closed by hand doesn't get overridden by this check.
  const activeGroupKey = useMemo(() => {
    for (const item of items) {
      if (item.items && item.items.some((sub) => isItemActive(sub, pathname))) return item.key;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  return (
    <nav aria-label="Primary" className={styles.nav}>
      <ul className={styles.list}>
        {items.map((item) =>
          item.items ? (
            <li key={item.key}>
              <GroupItem group={item} onNavigate={onNavigate} theme={theme} defaultOpen={item.key === activeGroupKey} />
            </li>
          ) : (
            <li key={item.to}>
              <LinkItem item={item} onNavigate={onNavigate} theme={theme} />
            </li>
          )
        )}
      </ul>
    </nav>
  );
}
