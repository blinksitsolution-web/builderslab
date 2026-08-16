import { Card, CardHeader, FormField, Input } from "../../components/ui";

/**
 * Fees panel (Phase 30). Mirrors legacy otRenderFeesPanel(): every field is
 * blank-means-null (fall back to global Site Settings → Fees) — an empty
 * input must be submitted as `null`, not `0` or `""`, exactly like legacy's
 * otReadFeesSettings()'s `v === "" ? null : Number(v)`.
 */
export default function OfferingTypeFeesPanel({ fees, onChange }) {
  const f = fees || {};

  function setField(key, raw) {
    onChange(key, raw === "" ? null : Number(raw));
  }

  return (
    <Card>
      <CardHeader title="Fees" subtitle="Leave a field blank to use the global fee from Site Settings → Fees." />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <FormField label="Registration fee (GHS)">
          <Input type="number" value={f.registrationGHS ?? ""} placeholder="e.g. 350" onChange={(e) => setField("registrationGHS", e.target.value)} />
        </FormField>
        <FormField label="Monthly fee (GHS)">
          <Input type="number" value={f.monthlyGHS ?? ""} placeholder="e.g. 180" onChange={(e) => setField("monthlyGHS", e.target.value)} />
        </FormField>
        <FormField label="Flat one-time fee (GHS)" helperText="Used instead of registration+monthly for a single-charge offering like a short course or Bootcamp.">
          <Input type="number" value={f.oneTimeFeeGHS ?? ""} placeholder="e.g. 600" onChange={(e) => setField("oneTimeFeeGHS", e.target.value)} />
        </FormField>
      </div>
      {/* ABRS v2.2 §15.7 — the multi-ward/sibling discount is a Discount
          Policy row (config data the pricing engine reads live), not an
          Offering Type settings field. This field used to sit here but
          nothing has read it for live pricing since the v41 migration
          seeded the real Discount Policy rows from it; editing it here no
          longer changes anything, so it's been removed rather than left
          silently inert. Configure the actual policy via the Pricing
          API's Discount Policies, optionally scoped to this Offering
          Type. */}
    </Card>
  );
}
