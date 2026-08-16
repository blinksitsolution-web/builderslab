import { Card, CardHeader, FormField, Input, Select, Checkbox } from "../../components/ui";
import { OFFERING_SETTINGS_SECTIONS, TRISTATE_OPTIONS } from "./offeringTypeSettingsData";

/**
 * Renders every generic section from OFFERING_SETTINGS_SECTIONS
 * (Enrollment, Academic Structure, Assessments, Academic Records,
 * Payments, AI, Visibility, Instructor Portal Terminology). Mirrors
 * legacy's otRenderField()/otReadSettings() — generic over the field
 * list, so a new section/field there renders and saves automatically.
 *
 * `settings` is the current section values (from an existing type, or the
 * default settings-schema for a new one). `onChange(sectionKey, fieldKey, value)`
 * updates the parent's draft state.
 */
export default function OfferingTypeSettingsSections({ settings, onChange }) {
  return (
    <>
      {OFFERING_SETTINGS_SECTIONS.map((sec) => (
        <Card key={sec.key}>
          <CardHeader title={sec.title} />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {sec.fields.map((f) => {
              const value = settings?.[sec.key] ? settings[sec.key][f.key] : undefined;
              return (
                <SettingField
                  key={f.key}
                  field={f}
                  value={value}
                  onChange={(v) => onChange(sec.key, f.key, v)}
                />
              );
            })}
          </div>
        </Card>
      ))}
    </>
  );
}

function SettingField({ field, value, onChange }) {
  if (field.type === "tristate") {
    const v = value === "yes" || value === "no" || value === "optional" ? value : "optional";
    return (
      <FormField label={field.label}>
        <Select value={v} onChange={(e) => onChange(e.target.value)}>
          {TRISTATE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </FormField>
    );
  }
  if (field.type === "text") {
    return (
      <FormField label={field.label}>
        <Input value={value || ""} placeholder={field.placeholder || ""} onChange={(e) => onChange(e.target.value)} />
      </FormField>
    );
  }
  return <Checkbox label={field.label} checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
}
