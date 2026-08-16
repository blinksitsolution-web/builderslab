import { FormField, Select } from "../../components/ui";

/**
 * Shared "Ward" dropdown (Phase 22) — every legacy parent screen beyond
 * the overview (Certificates, Continuous Assessment, Transcripts,
 * Progress, Payments, My Programmes) opens with the same `<select
 * id="...Child">` populated from the parent's linked children. One
 * component instead of six copies.
 */
export default function WardPicker({ wards, selectedId, onChange, label = "Ward" }) {
  if (wards.length === 0) return null;
  return (
    <FormField label={label}>
      <Select value={selectedId || ""} onChange={(e) => onChange(e.target.value)}>
        {wards.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </Select>
    </FormField>
  );
}
