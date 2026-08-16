import { useNavigate } from "react-router-dom";
import IconButton from "../components/ui/IconButton";
import Dropdown from "../components/ui/Dropdown";
import Avatar from "../components/ui/Avatar";
import NotificationBell from "./NotificationBell";
import styles from "./Topbar.module.css";

/**
 * @param {() => void} onOpenNav - opens the mobile nav Drawer (hidden on desktop, where Sidebar is always visible)
 * @param {{ name: string, role: string, is_adult?: boolean, avatarPath?: string|null } } user
 * @param {() => void} onLogout
 */
export default function Topbar({ onOpenNav, user, onLogout }) {
  const navigate = useNavigate();

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        <IconButton label="Open navigation" className={styles.navToggle} onClick={onOpenNav}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </IconButton>
        {/* Every account portal now links back to the public site from
           here (mobile) and from Sidebar.jsx's brand mark (desktop) —
           there used to be no way back to the landing page from inside
           a portal at all. */}
        <a href="/" className={styles.brandMobile}>
          The Builders&rsquo; Lab
        </a>
      </div>

      <div className={styles.right}>
        {/* Was a pure visual placeholder — no onClick, no data behind it
           at all. Now backed by the existing messages table (see
           routes/messages.js's /unread-count and /recent, added
           alongside this). */}
        {user && <NotificationBell role={user.role} />}

        {user && (
          <Dropdown
            align="end"
            trigger={
              <span className={styles.profile}>
                <Avatar avatarPath={user.avatarPath} name={user.name} size="md" />
                <span className={styles.profileMeta}>
                  <span className={styles.profileName}>{user.name}</span>
                  <span className={styles.profileRole}>
                    {user.role}
                    {user.is_adult ? " · adult" : ""}
                  </span>
                </span>
              </span>
            }
            items={[
              { label: "My profile", onSelect: () => navigate("/app/profile") },
              { label: "Visit website", onSelect: () => window.open("/", "_blank", "noopener,noreferrer") },
              { label: "Sign out", onSelect: onLogout, danger: true },
            ]}
          />
        )}
      </div>
    </header>
  );
}
