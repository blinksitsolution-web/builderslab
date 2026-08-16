import { useCallback, useEffect, useState } from "react";
import {
  fetchRoleTemplates,
  fetchPermissionCatalog,
  createRoleTemplate,
  updateRoleTemplate,
  duplicateRoleTemplate,
  setRoleTemplateActive,
  deleteRoleTemplate,
} from "../../api/roleTemplates";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Data/state for the Role Templates screen (Phase 19). Mirrors legacy
 * adminAccessControl()/renderRoleTemplateTable() (dashboard.html): load the
 * template list + permission catalog together, then the same
 * create/update/duplicate/enable-disable/delete actions against the
 * existing backend (server/src/routes/roleTemplates.js) — every one of
 * them Super-Administrator-only server-side regardless of what this hook
 * or RoleRoute already restrict client-side.
 *
 * `status` distinguishes "forbidden" from "error" the same way
 * useAccountManagement's catalog loading does: a 403 here is expected for
 * anyone RoleRoute's requireSuperAdmin guard didn't already keep out (e.g.
 * a stale client-side isSuperAdmin flag), not a broken page.
 */
export function useRoleTemplates() {
  const { refresh } = useAuth();

  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "error" | "forbidden"
  const [templates, setTemplates] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const [templatesResult, catalogResult] = await Promise.all([fetchRoleTemplates(), fetchPermissionCatalog()]);
      setTemplates(templatesResult);
      setCatalog(catalogResult);
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
  }, [refresh]);

  useEffect(() => {
    load();
  }, [load]);

  async function create(payload) {
    await createRoleTemplate(payload);
    await load();
  }

  async function update(id, payload) {
    await updateRoleTemplate(id, payload);
    await load();
  }

  async function duplicate(id) {
    await duplicateRoleTemplate(id);
    await load();
  }

  async function toggleActive(id, nextActive) {
    await setRoleTemplateActive(id, nextActive);
    await load();
  }

  async function remove(id) {
    await deleteRoleTemplate(id);
    await load();
  }

  return {
    status,
    templates,
    catalog,
    error,
    reload: load,
    create,
    update,
    duplicate,
    toggleActive,
    remove,
  };
}
