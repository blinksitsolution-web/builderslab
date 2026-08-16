import { Card, CardHeader, FormField, Input, Textarea, Select, Checkbox } from "../../components/ui";

/**
 * Landing Page panel (Phase 30). Mirrors legacy otRenderLandingPanel()/
 * otReadLandingSettings() exactly — controls this offering type's card in
 * the public Landing Page's "Featured Learning Offerings" section and its
 * own Enrol button. `features` is a newline-separated textarea in the UI
 * but an array on the wire, same as legacy.
 */
export default function OfferingTypeLandingPanel({ landing, onChange }) {
  const l = landing || {};

  return (
    <Card>
      <CardHeader title="Landing Page" subtitle={'Controls this offering\'s card in the public Landing Page\'s "Featured Learning Offerings" section, and its own Enrol button.'} />
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <FormField label="Feature level">
          <Select value={l.featureLevel || "standard"} onChange={(e) => onChange("featureLevel", e.target.value)}>
            <option value="featured">Featured</option>
            <option value="standard">Standard</option>
            <option value="hidden">Hidden (not shown on Landing Page)</option>
          </Select>
        </FormField>
        <FormField label="Tagline">
          <Input value={l.tagline || ""} placeholder="Short one-liner shown on the card" onChange={(e) => onChange("tagline", e.target.value)} />
        </FormField>
        <FormField label="Landing description">
          <Textarea rows={2} value={l.description || ""} onChange={(e) => onChange("description", e.target.value)} />
        </FormField>
        <FormField label="Image URL">
          <Input value={l.imagePath || ""} placeholder="/uploads/… or https://…" onChange={(e) => onChange("imagePath", e.target.value)} />
        </FormField>
        <FormField label="Features (one per line)">
          <Textarea rows={3} value={(l.features || []).join("\n")} onChange={(e) => onChange("features", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))} />
        </FormField>
        <FormField label="Display order">
          <Input type="number" value={l.sortOrder ?? 0} onChange={(e) => onChange("sortOrder", Number(e.target.value) || 0)} />
        </FormField>
        <h4 style={{ marginTop: 8, marginBottom: 0, fontSize: ".92rem" }}>Enrol Button</h4>
        <FormField label="Button text">
          <Input value={l.enrolButtonText || "Enrol now"} onChange={(e) => onChange("enrolButtonText", e.target.value)} />
        </FormField>
        <FormField label="Destination override" helperText="Blank = this offering's default registration flow.">
          <Input value={l.enrolDestination || ""} placeholder="e.g. register.html or #contact" onChange={(e) => onChange("enrolDestination", e.target.value)} />
        </FormField>
        <FormField label="Opens in">
          <Select value={l.enrolOpenBehavior || "same_tab"} onChange={(e) => onChange("enrolOpenBehavior", e.target.value)}>
            <option value="same_tab">Same tab</option>
            <option value="new_tab">New tab</option>
          </Select>
        </FormField>
        <Checkbox label="Show Enrol button for this offering" checked={l.enrolVisible !== false} onChange={(e) => onChange("enrolVisible", e.target.checked)} />
      </div>
    </Card>
  );
}
