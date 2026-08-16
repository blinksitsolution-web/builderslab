import { Link } from "react-router-dom";
import styles from "./PublicHeader.module.css";

/**
 * "Sign in" points at the already-migrated React login route
 * (/app/login — Phase 4); "Enrol now" (enrolHref) now resolves to the
 * migrated React registration route by default (/app/register — Group 1,
 * final non-admin migration), unless an admin has configured a custom
 * enrolDestination for the targeted offering (see publicUtils.js
 * resolveEnrolDestination()).
 */
export default function PublicHeader({ logoSrc, enrolHref, enrolLabel }) {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <a href="/" className={styles.brand}>
          <img src={logoSrc} alt="Dalijay Tech Hub logo" className={styles.logo} />
          <span className={styles.brandName}>
            The Builders&rsquo; Lab
            <small>Dalijay Tech Hub</small>
          </span>
        </a>
        <nav className={styles.nav} aria-label="Primary">
          <a href="#about">About</a>
          <a href="#offerings">Offerings</a>
          <a href="#pathway">How it works</a>
          <a href="#campuses">Campuses</a>
          <a href="#news">News</a>
          <a href="#contact">Contact</a>
        </nav>
        <div className={styles.actions}>
          <Link to="/app/login" className={styles.signIn}>
            Sign in
          </Link>
          <a href={enrolHref} className={styles.enrol}>
            {enrolLabel}
          </a>
        </div>
      </div>
    </header>
  );
}
