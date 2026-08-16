import { Card, CardHeader, FormField, Select, Checkbox } from "../../components/ui";

/**
 * Certificates panel (Phase 30). Mirrors legacy's inline certificate
 * template checklist + default-template select in openOfferingTypeModal().
 * `templates` is the full certificate template list (GET
 * /api/certificate-templates, same as legacy's DTL.certificateTemplatesAll()).
 */
export default function OfferingTypeCertificatesPanel({ certificates, templates, onToggleTemplate, onChangeDefault }) {
  const c = certificates || { availableTemplateIds: [], defaultTemplateId: null };
  const availableIds = c.availableTemplateIds || [];

  return (
    <Card>
      <CardHeader title="Certificates" />
      <FormField label="Available certificate templates">
        {templates.length === 0 ? (
          <p style={{ color: "var(--text-muted, #6b7280)", margin: 0 }}>No certificate templates yet — add one in Site Settings → Certificate Settings.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {templates.map((t) => (
              <Checkbox key={t.id} label={t.name} checked={availableIds.includes(t.id)} onChange={(e) => onToggleTemplate(t.id, e.target.checked)} />
            ))}
          </div>
        )}
      </FormField>
      <FormField label="Default template">
        <Select value={c.defaultTemplateId || ""} onChange={(e) => onChangeDefault(e.target.value || null)}>
          <option value="">— None —</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </FormField>
    </Card>
  );
}
