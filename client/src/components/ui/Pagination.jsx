import IconButton from "./IconButton";
import styles from "./Pagination.module.css";

function windowedPages(page, totalPages, span = 1) {
  const pages = new Set([1, totalPages]);
  for (let p = page - span; p <= page + span; p++) {
    if (p >= 1 && p <= totalPages) pages.add(p);
  }
  return Array.from(pages).sort((a, b) => a - b);
}

/**
 * @param {number} page - 1-indexed current page
 * @param {number} totalPages
 * @param {(page: number) => void} onChange
 */
export default function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null;
  const pages = windowedPages(page, totalPages);

  return (
    <nav className={styles.nav} aria-label="Pagination">
      <IconButton label="Previous page" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </IconButton>

      {pages.map((p, i) => {
        const prev = pages[i - 1];
        const showGap = prev !== undefined && p - prev > 1;
        return (
          <span key={p} className={styles.pageGroup}>
            {showGap && <span className={styles.ellipsis}>&hellip;</span>}
            <button
              type="button"
              className={[styles.page, p === page ? styles.active : ""].filter(Boolean).join(" ")}
              aria-current={p === page ? "page" : undefined}
              onClick={() => onChange(p)}
            >
              {p}
            </button>
          </span>
        );
      })}

      <IconButton label="Next page" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </IconButton>
    </nav>
  );
}
