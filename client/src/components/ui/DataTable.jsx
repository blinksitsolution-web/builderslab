import Skeleton from "./Skeleton";
import EmptyState from "./EmptyState";
import styles from "./DataTable.module.css";

/**
 * Foundation only — enough structure for future portals to build real
 * tables (grades, attendance, learners, transcripts, etc.) on top of,
 * without re-solving responsive behavior or empty/loading states each
 * time.
 *
 * @param {{ key: string, header: string, render?: (row: any) => React.ReactNode, align?: "left"|"right"|"center" }[]} columns
 * @param {any[]} rows
 * @param {(row: any) => string|number} getRowKey
 * @param {boolean} [loading]
 * @param {React.ReactNode} [emptyState] - defaults to a generic EmptyState
 */
export default function DataTable({ columns, rows, getRowKey = (row, i) => i, loading = false, emptyState }) {
  if (loading) {
    return (
      <div className={styles.wrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={styles[c.align || "left"]}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key}>
                    <Skeleton height={16} width="80%" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return emptyState || <EmptyState title="Nothing here yet" description="There's no data to show for this view." />;
  }

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={styles[c.align || "left"]}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={getRowKey(row, i)} className={styles.row}>
              {columns.map((c) => (
                <td key={c.key} data-label={c.header} className={styles[c.align || "left"]}>
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
