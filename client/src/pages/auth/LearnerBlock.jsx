import { FormField, Input, Select, Checkbox, Button } from "../../components/ui";

const CAMPUS_OTHER = "Other / not listed";

/**
 * One child's fields within Parent + Child registration (Group 1
 * migration of register.html's learnerBlockHtml()/addLearnerBlock()).
 * Controlled by the parent RegisterPage's `learners` array state instead
 * of the legacy page's DOM queries (`.learnerName`, `.learnerAge`, etc.) —
 * same fields, same "school name matching Campus unlocks that campus's
 * discounted fee" hint, same auto-generated-login note.
 */
export default function LearnerBlock({ index, learner, campusOptions, onChange, onRemove, error, deliveryMode, campusName }) {
  function set(field, value) {
    onChange(index, { ...learner, [field]: value });
  }

  // deliveryMode is only ever non-null once the parent has resolved an
  // actual Class/Cohort that itself carries a Delivery Mode (see
  // migrate.js's classes.delivery_mode) — every legacy/Kids-STEM-classic
  // registration (no class picker at all, or a class predating Delivery
  // Mode) passes deliveryMode=null here and this renders exactly as it
  // always has: a free Campus picker per child.
  const showFreeCampusPicker = !deliveryMode;
  const showReadOnlyCampus = deliveryMode === "ON_CAMPUS" || deliveryMode === "HYBRID";
  // deliveryMode === "ONLINE": no campus field at all — campus is null/
  // ignored for the enrollment path, and the server never trusts a
  // client-supplied value for an Online class regardless.

  return (
    <div style={{ border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-2)" }}>
        <strong>Child {index + 1}</strong>
        {index > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onRemove(index)}>
            Remove
          </Button>
        )}
      </div>

      <FormField label="Learner's full name" required error={error?.name}>
        <Input value={learner.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Elikem Dalike" />
      </FormField>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" }}>
        <FormField label="Learner's age" error={error?.age}>
          <Input type="number" min={6} value={learner.age} onChange={(e) => set("age", e.target.value)} placeholder="e.g. 11" />
        </FormField>
        {showFreeCampusPicker && (
          <FormField label="Campus">
            <Select value={learner.campus} onChange={(e) => set("campus", e.target.value)}>
              <option value="">Choose…</option>
              {campusOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              <option value={CAMPUS_OTHER}>{CAMPUS_OTHER}</option>
            </Select>
          </FormField>
        )}
        {showReadOnlyCampus && (
          <FormField label="Campus" helperText="Determined by the selected Batch/Cohort.">
            <Input value={campusName || "—"} disabled readOnly />
          </FormField>
        )}
      </div>

      <FormField label="School name" helperText="If the school name matches the selected Campus, this learner qualifies for that campus's discounted fees.">
        <Input value={learner.schoolName} onChange={(e) => set("schoolName", e.target.value)} placeholder="e.g. Deigratia International School" />
      </FormField>

      <Checkbox
        label="Would like to keep their own robotics kit (extra one-off fee applies)"
        checked={learner.ownRoboticsKit}
        onChange={(e) => set("ownRoboticsKit", e.target.checked)}
      />

      <p className="text-caption" style={{ marginTop: "var(--space-2)" }}>
        A login (email + password) is generated automatically for this learner — you'll see it on the confirmation page after payment.
      </p>
    </div>
  );
}
