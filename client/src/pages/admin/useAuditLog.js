import { useCallback, useEffect, useState } from "react";
import { fetchAuditLog, fetchAuditLogFilters } from "../../api/auditLog";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Data/state for the Audit Trail screen. Super-Administrator-only, same
 * "forbidden vs error" distinction useRoleTemplates uses — a 403 here is
 * expected for anyone RoleRoute's requireSuperAdmin guard didn't already
 * keep out, not a broken page.
 *
 * Filters are held here (not in the page component) so changing one
 * automatically re-fetches page 1 of the matching results.
 */
export function useAuditLog() {
  const { refresh } = useAuth();

  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "error" | "forbidden"
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState(null);

  const [filterOptions, setFilterOptions] = useState({ entityTypes: [], actions: [] });

  const [search, setSearch] = useState("");
  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const pageSize = 25;

  const load = useCallback(
    async (targetPage = 1) => {
      setStatus((s) => (s === "ready" ? "ready" : "loading")); // keep showing the table while refetching a filter change
      setError(null);
      try {
        const result = await fetchAuditLog({
          page: targetPage,
          pageSize,
          search: search || undefined,
          entityType: entityType || undefined,
          action: action || undefined,
          from: from || undefined,
          to: to || undefined,
        });
        setEntries(result.entries);
        setTotal(result.total);
        setPage(result.page);
        setTotalPages(result.totalPages);
        setStatus("ready");
      } catch (e) {
        if (isUnauthorizedError(e)) {
          await refresh();
          return;
        }
        if (isForbiddenError(e)) {
          setStatus("forbidden");
          return;
        }
        setError(e.message);
        setStatus("error");
      }
    },
    [refresh, search, entityType, action, from, to]
  );

  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, entityType, action, from, to]);

  useEffect(() => {
    fetchAuditLogFilters()
      .then(setFilterOptions)
      .catch(() => {
        /* filter dropdowns just stay empty — not fatal to the page */
      });
  }, []);

  return {
    status,
    entries,
    total,
    page,
    totalPages,
    error,
    filterOptions,
    search,
    setSearch,
    entityType,
    setEntityType,
    action,
    setAction,
    from,
    setFrom,
    to,
    setTo,
    goToPage: (p) => load(p),
    reload: () => load(page),
  };
}
