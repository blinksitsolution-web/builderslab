import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, FormField, Input, Textarea, Select, Checkbox, Button, Badge, DataTable, Modal, Alert, LoadingState, ErrorState, UnauthorizedState } from "../../components/ui";
import { useToast } from "../../context/ToastContext";

const TEMPLATE_TYPES = [
  { value: "module_completion", label: "Module Completion" },
  { value: "graduation", label: "Graduation" },
  { value: "honor", label: "Certificate of Honor" },
  { value: "recognition", label: "Certificate of Recognition" },
];

// Sample values used purely for the live preview below — never sent anywhere.
const PREVIEW_SAMPLE = {
  student_name: "Ama Owusu",
  module_name: "Programming & Scratching",
  grade: "A",
  campus: "Accra Main",
  partner_school: "Riverside Academy",
  issue_date: "12 July 2026",
  certificate_number: "CERT-ACC-2026-014",
};
function renderPreview(text) {
  return String(text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => String(PREVIEW_SAMPLE[key] ?? m));
}

/**
 * Certificate Settings (Phase 27). Migrates legacy
 * settingsCertificateTemplates()/saveCertOrgSettings()/
 * saveCertSignatures()/openCertTemplateModal()/saveCertTemplateModal()/
 * loadCertificateTemplateList()/toggleCertTemplateActive()/
 * duplicateCertTemplate() — same /api/certificate-templates and
 * /api/certificate-templates/org-settings contracts.
 */
export default function SettingsCertificatesTab({ settings }) {
  const tab = settings.tabs.certificates;
  const toast = useToast();

  const [institutionName, setInstitutionName] = useState("");
  const [programName, setProgramName] = useState("");
  const [savingOrg, setSavingOrg] = useState(false);

  const [sigCount, setSigCount] = useState(1);
  const [sig1Name, setSig1Name] = useState("");
  const [sig1Title, setSig1Title] = useState("");
  const [sig2Name, setSig2Name] = useState("");
  const [sig2Title, setSig2Title] = useState("");
  const sig1FileRef = useRef(null);
  const sig2FileRef = useRef(null);
  const [savingSignatures, setSavingSignatures] = useState(false);

  const [editorTemplate, setEditorTemplate] = useState(undefined); // undefined = closed, null = new, object = edit

  useEffect(() => {
    if (tab.status !== "ready") return;
    const org = tab.data.org;
    setInstitutionName(org.institutionName || "");
    setProgramName(org.programName || "");
    setSigCount(Number(org.signatureCount) === 2 ? 2 : 1);
    setSig1Name(org.signature1?.name || "");
    setSig1Title(org.signature1?.title || "");
    setSig2Name(org.signature2?.name || "");
    setSig2Title(org.signature2?.title || "");
  }, [tab.status, tab.data]);

  if (tab.status === "loading" || tab.status === "idle") return <LoadingState label="Loading certificate settings…" />;
  if (tab.status === "forbidden") return <UnauthorizedState description="Certificate settings are limited to administrators." />;
  if (tab.status === "error") return <ErrorState description={tab.error} action={{ label: "Try again", onClick: () => settings.reload("certificates") }} />;

  const { org, templates } = tab.data;

  async function handleSaveOrg() {
    setSavingOrg(true);
    try {
      await settings.saveCertOrgSettings({ institutionName: institutionName.trim(), programName: programName.trim() });
      toast.success("Institution details saved.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingOrg(false);
    }
  }

  async function handleSaveSignatures() {
    setSavingSignatures(true);
    try {
      await settings.saveCertSignatures({
        signatureCount: sigCount,
        signature1Name: sig1Name.trim(),
        signature1Title: sig1Title.trim(),
        signature2Name: sigCount === 2 ? sig2Name.trim() : undefined,
        signature2Title: sigCount === 2 ? sig2Title.trim() : undefined,
        signature1File: sig1FileRef.current?.files?.[0] || null,
        signature2File: sigCount === 2 ? sig2FileRef.current?.files?.[0] || null : null,
      });
      if (sig1FileRef.current) sig1FileRef.current.value = "";
      if (sig2FileRef.current) sig2FileRef.current.value = "";
      toast.success("Certificate signature(s) saved.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingSignatures(false);
    }
  }

  async function handleToggleActive(t) {
    try {
      await settings.toggleTemplateActive(t.id, !t.isActive);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleDuplicate(t) {
    try {
      await settings.duplicateTemplate(t.id);
      toast.success("Template duplicated.");
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card>
        <CardHeader title="Institution details" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <FormField label="Institution name">
            <Input value={institutionName} onChange={(e) => setInstitutionName(e.target.value)} />
          </FormField>
          <FormField label="Program name">
            <Input value={programName} onChange={(e) => setProgramName(e.target.value)} />
          </FormField>
        </div>
        <div style={{ marginTop: 12 }}>
          <Button onClick={handleSaveOrg} loading={savingOrg}>
            Save
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Certificate signature(s)" subtitle="Uploaded once here, these appear on every certificate — no need to set anything up per campus." />
        <FormField label="Number of signatures on the certificate">
          <Select value={sigCount} onChange={(e) => setSigCount(Number(e.target.value))}>
            <option value={1}>One signature</option>
            <option value={2}>Two signatures</option>
          </Select>
        </FormField>

        <div style={{ background: "var(--bg-soft, #faf7f2)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <h4 style={{ margin: "0 0 8px" }}>Signature 1{sigCount === 2 ? " (left)" : ""}</h4>
          {org.signature1?.path && <img src={org.signature1.path} alt="" style={{ height: 44, marginBottom: 8, display: "block" }} />}
          <FormField label="Upload signature image">
            <input ref={sig1FileRef} type="file" accept="image/*" />
          </FormField>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <FormField label="Name">
              <Input value={sig1Name} onChange={(e) => setSig1Name(e.target.value)} />
            </FormField>
            <FormField label="Title (e.g. Executive Director)">
              <Input value={sig1Title} onChange={(e) => setSig1Title(e.target.value)} />
            </FormField>
          </div>
        </div>

        {sigCount === 2 && (
          <div style={{ background: "var(--bg-soft, #faf7f2)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <h4 style={{ margin: "0 0 8px" }}>Signature 2 (right)</h4>
            {org.signature2?.path && <img src={org.signature2.path} alt="" style={{ height: 44, marginBottom: 8, display: "block" }} />}
            <FormField label="Upload signature image">
              <input ref={sig2FileRef} type="file" accept="image/*" />
            </FormField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <FormField label="Name">
                <Input value={sig2Name} onChange={(e) => setSig2Name(e.target.value)} />
              </FormField>
              <FormField label="Title (e.g. Executive Director)">
                <Input value={sig2Title} onChange={(e) => setSig2Title(e.target.value)} />
              </FormField>
            </div>
          </div>
        )}
        <Button onClick={handleSaveSignatures} loading={savingSignatures}>
          Save signature(s)
        </Button>
      </Card>

      <Card padding={false}>
        <div style={{ padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Certificate templates</h3>
          <Button size="sm" onClick={() => setEditorTemplate(null)}>
            + New template
          </Button>
        </div>
        <DataTable
          columns={[
            { key: "name", header: "Name", render: (t) => <span>{t.name} <Badge tone={t.isActive ? "success" : "neutral"}>{t.isActive ? "Active" : "Inactive"}</Badge></span> },
            { key: "type", header: "Type", render: (t) => t.type.replace(/_/g, " ") },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (t) => (
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Button variant="ghost" size="sm" onClick={() => setEditorTemplate(t)}>
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleToggleActive(t)}>
                    {t.isActive ? "Deactivate" : "Activate"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleDuplicate(t)}>
                    Duplicate
                  </Button>
                </div>
              ),
            },
          ]}
          rows={templates}
          getRowKey={(t) => t.id}
        />
      </Card>

      <CertTemplateModal
        template={editorTemplate}
        open={editorTemplate !== undefined}
        institutionName={institutionName}
        onClose={() => setEditorTemplate(undefined)}
        onSave={settings.saveCertTemplate}
      />
    </div>
  );
}

function CertTemplateModal({ template, open, institutionName, onClose, onSave }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [type, setType] = useState(TEMPLATE_TYPES[0].value);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");
  const [dateFormat, setDateFormat] = useState("DD MMMM YYYY");
  const [numberFormat, setNumberFormat] = useState("CERT-{campus}-{year}-{seq}");
  const [placeholders, setPlaceholders] = useState("");
  const [showStats, setShowStats] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setName(template?.name || "");
    setType(template?.type || TEMPLATE_TYPES[0].value);
    setTitle(template?.title || "");
    setBody(template?.body || "");
    setFooter(template?.footer || "");
    setDateFormat(template?.date_format || "DD MMMM YYYY");
    setNumberFormat(template?.number_format || "CERT-{campus}-{year}-{seq}");
    setPlaceholders((template?.placeholders || []).join(", "));
    setShowStats(!!template?.showAcademicStats);
    setFormError(null);
  }, [open, template]);

  if (!open) return null;

  async function handleSave() {
    setFormError(null);
    if (!name.trim()) {
      setFormError("Name is required.");
      return;
    }
    setSaving(true);
    try {
      await onSave(template?.id || null, {
        name: name.trim(),
        type,
        title: title.trim(),
        body: body.trim(),
        footer: footer.trim() || null,
        dateFormat: dateFormat.trim(),
        numberFormat: numberFormat.trim(),
        placeholders: placeholders.split(",").map((s) => s.trim()).filter(Boolean),
        showAcademicStats: showStats,
      });
      toast.success(template ? "Template updated." : "Template created.");
      onClose();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${template ? "Edit" : "New"} certificate template`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            {template ? "Save changes" : "Create template"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px", minWidth: 280 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <FormField label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Module Completion Certificate" />
            </FormField>
            <FormField label="Type">
              <Select value={type} onChange={(e) => setType(e.target.value)}>
                {TEMPLATE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <FormField label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Certificate of Module Completion" />
          </FormField>
          <FormField label="Body (use {{placeholders}})">
            <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="This certifies that {{student_name}} has completed {{module_name}} with a grade of {{grade}}." />
          </FormField>
          <FormField label="Footer (optional)">
            <Input value={footer} onChange={(e) => setFooter(e.target.value)} />
          </FormField>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <FormField label="Date format">
              <Input value={dateFormat} onChange={(e) => setDateFormat(e.target.value)} />
            </FormField>
            <FormField label="Certificate number format">
              <Input value={numberFormat} onChange={(e) => setNumberFormat(e.target.value)} />
            </FormField>
          </div>
          <FormField label="Placeholders (comma-separated)">
            <Input value={placeholders} onChange={(e) => setPlaceholders(e.target.value)} placeholder="student_name, module_name, grade, campus, partner_school, issue_date, certificate_number" />
          </FormField>
          <Checkbox label="Show modules/grades/transcript stats on this certificate" checked={showStats} onChange={(e) => setShowStats(e.target.checked)} />
        </div>
        <div style={{ flex: "1 1 320px", minWidth: 280 }}>
          <p style={{ fontSize: ".82rem", opacity: 0.75, marginBottom: 6 }}>Live preview (sample data — placeholders are filled in)</p>
          <div style={{ border: "1px solid var(--border, #e5ddd0)", borderRadius: 8, padding: 16, maxWidth: 520 }}>
            <div style={{ textAlign: "center", fontSize: ".78rem", opacity: 0.7, marginBottom: 6 }}>{institutionName}</div>
            <h2 style={{ textAlign: "center" }}>{renderPreview(title) || <span style={{ opacity: 0.5 }}>Title preview…</span>}</h2>
            <p style={{ textAlign: "center", marginTop: 10 }}>{renderPreview(body) || <span style={{ opacity: 0.5 }}>Body preview…</span>}</p>
            {footer && <p style={{ textAlign: "center", marginTop: 14, fontSize: ".82rem", opacity: 0.75 }}>{renderPreview(footer)}</p>}
          </div>
        </div>
      </div>
      {formError && <Alert variant="danger">{formError}</Alert>}
    </Modal>
  );
}
