import { Component } from "react";
import Button from "./Button";
import styles from "./StateBlock.module.css";

/**
 * Last-resort safety net for uncaught render exceptions (undefined data,
 * a bad prop contract like React.Children.only, a bad map over undefined,
 * etc.). React unmounts the whole subtree under whatever throws — without
 * a boundary somewhere above it, that subtree is the *entire app*
 * (AppShell mounts a single <Outlet/>), which is exactly how isolated
 * page/modal bugs were turning into full blank-page failures.
 *
 * This does NOT replace fixing the actual bug (Children.only, undefined
 * data, etc.) at its root cause — it's the backstop for whatever the next
 * undiscovered one turns out to be, per Part 5/6 of the remediation: never
 * render a completely blank page, and never do so by broadly suppressing
 * exceptions. Errors are still logged to the console for debugging; nothing
 * here silently swallows anything.
 *
 * Usage: wrap a boundary — a page's content, a modal's body — not the
 * whole tree with one instance if you want a crash in one area to leave
 * the rest (nav, other open panels) usable. See AppShell.jsx for the
 * outer instance and CampusProfileModal-style usages for a scoped one.
 *
 * @param {React.ReactNode} children
 * @param {string} [title]
 * @param {string} [description]
 * @param {() => void} [onReset] - called in addition to internal state reset, e.g. to reload data
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error("Unhandled error caught by ErrorBoundary:", error, info?.componentStack);
  }

  handleRetry() {
    this.props.onReset?.();
    this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;

    const { title = "Something went wrong", description = "This part of the page hit an unexpected error. You can try again, or navigate elsewhere with the menu." } = this.props;

    return (
      <div className={styles.wrap}>
        <span className={[styles.icon, styles.danger].join(" ")}>
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" fill="none" />
            <path d="M12 8v5M12 16h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.description}>{description}</p>
        <div className={styles.action}>
          <Button variant="primary" size="sm" onClick={this.handleRetry}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
}
