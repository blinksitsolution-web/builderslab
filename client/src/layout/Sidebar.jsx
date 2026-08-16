import NavList from "./NavList";
import styles from "./Sidebar.module.css";

export default function Sidebar({ items }) {
  return (
    <aside className={styles.sidebar}>
      {/* Links back to the public site — there used to be no way back to
          the landing page from inside any portal at all (see also
          Topbar.jsx's mobile brand link and AuthLayout.jsx for the
          login/register/forgot-password side of the same fix). */}
      <a href="/" className={styles.brand}>
        <span className={styles.mark} aria-hidden="true">
          BL
        </span>
        <span className={styles.wordmark}>The Builders&rsquo; Lab</span>
      </a>
      {/* Independently scrollable so a long list (e.g. the grouped Admin
          nav — see navConfig.js) never pushes the brand off-screen or
          grows the sidebar past the viewport. */}
      <div className={styles.navScroll}>
        <NavList items={items} />
      </div>
    </aside>
  );
}
