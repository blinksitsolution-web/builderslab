import { Checkbox } from "../../components/ui";

// "learningOfferings" -> "Learning Offerings" — same heading transform as
// legacy permissionCheckboxesHtml()'s `mod.replace(/([A-Z])/g, " $1")...`.
function humanizeModuleName(mod) {
  return mod.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

/**
 * Renders every permission in `groups` (as returned by
 * GET /api/role-templates/permission-catalog, see api/roleTemplates.js) as
 * a checkbox grid, one section per module — the same catalog rendering
 * legacy permissionCheckboxesHtml() shares between the Custom Permission
 * Set builder and the Role Template editor (dashboard.html), now shared
 * here between RoleTemplateEditorModal and ManageAccessModal instead of
 * being duplicated.
 *
 * @param {Record<string, Record<string,string>>} groups - module -> { actionKey: label }
 * @param {Set<string>} checked - currently-checked "module.action" keys
 * @param {(key: string) => void} onToggle
 * @param {boolean} [disabled] - true for the Super Administrator template, whose permissions can't be reduced
 */
export default function PermissionCheckboxGrid({ groups, checked, onToggle, disabled = false }) {
  if (!groups) return null;
  return (
    <div>
      {Object.entries(groups).map(([mod, actions]) => (
        <div key={mod} style={{ marginBottom: "var(--space-3)", paddingBottom: "var(--space-3)", borderBottom: "1px dashed var(--border-subtle)" }}>
          <p className="text-label" style={{ margin: "0 0 var(--space-2)" }}>
            {humanizeModuleName(mod)}
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1) var(--space-4)" }}>
            {Object.entries(actions).map(([action, label]) => {
              const key = `${mod}.${action}`;
              return <Checkbox key={key} label={label} checked={checked.has(key)} disabled={disabled} onChange={() => onToggle(key)} />;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
