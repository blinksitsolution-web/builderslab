import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, FormField, Input, Button, LoadingState, ErrorState, UnauthorizedState } from "../../components/ui";
import { useToast } from "../../context/ToastContext";

/**
 * Campus Branding (Phase 27). Migrates legacy settingsCampusBranding()/
 * saveCampusBrandingProfile()/uploadCampusBrandingImage() — same
 * POST/PATCH /api/campus-branding and POST
 * /api/campus-branding/:campusName/{institution-logo,partner-logo,
 * signature,background} contracts. One profile per campus, used on that
 * campus's certificates instead of the org-wide certificate branding.
 */
export default function SettingsCampusBrandingTab({ settings }) {
  const tab = settings.tabs.campusBranding;

  if (tab.status === "loading" || tab.status === "idle") return <LoadingState label="Loading campus branding…" />;
  if (tab.status === "forbidden") return <UnauthorizedState description="Campus branding is limited to administrators." />;
  if (tab.status === "error") return <ErrorState description={tab.error} action={{ label: "Try again", onClick: () => settings.reload("campusBranding") }} />;

  const { campuses, profiles } = tab.data;
  const profileByCampus = new Map(profiles.map((p) => [p.campus_name, p]));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {campuses.length === 0 && <p style={{ opacity: 0.7 }}>Add a campus under the Campuses tab first.</p>}
      {campuses.map((c) => (
        <CampusBrandingCard key={c.id} campusName={c.name} profile={profileByCampus.get(c.name) || null} settings={settings} />
      ))}
    </div>
  );
}

function CampusBrandingCard({ campusName, profile, settings }) {
  const toast = useToast();
  const [partnerSchoolName, setPartnerSchoolName] = useState("");
  const [institutionName, setInstitutionName] = useState("");
  const [authorizedSignatory, setAuthorizedSignatory] = useState("");
  const [footer, setFooter] = useState("");
  const [saving, setSaving] = useState(false);

  const partnerLogoRef = useRef(null);
  const signatureRef = useRef(null);
  const backgroundRef = useRef(null);

  useEffect(() => {
    setPartnerSchoolName(profile?.partner_school_name || "");
    setInstitutionName(profile?.institution_name || "");
    setAuthorizedSignatory(profile?.authorized_signatory || "");
    setFooter(profile?.footer || "");
  }, [profile]);

  async function handleSave() {
    setSaving(true);
    try {
      await settings.saveCampusBranding(
        campusName,
        !!profile,
        { partnerSchoolName: partnerSchoolName.trim() || null, institutionName: institutionName.trim() || null, authorizedSignatory: authorizedSignatory.trim() || null, footer: footer.trim() || null },
        [
          ["partner-logo", partnerLogoRef.current?.files?.[0] || null],
          ["signature", signatureRef.current?.files?.[0] || null],
          ["background", backgroundRef.current?.files?.[0] || null],
        ]
      );
      [partnerLogoRef, signatureRef, backgroundRef].forEach((r) => {
        if (r.current) r.current.value = "";
      });
      toast.success(`Branding saved for ${campusName}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader title={campusName} subtitle={profile ? "Custom certificate branding configured" : "Using default certificate branding — no profile yet"} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <FormField label="Partner school name">
          <Input value={partnerSchoolName} onChange={(e) => setPartnerSchoolName(e.target.value)} />
        </FormField>
        <FormField label="Institution name on certificate">
          <Input value={institutionName} onChange={(e) => setInstitutionName(e.target.value)} />
        </FormField>
      </div>
      <FormField label="Authorized signatory">
        <Input value={authorizedSignatory} onChange={(e) => setAuthorizedSignatory(e.target.value)} />
      </FormField>
      <FormField label="Footer text">
        <Input value={footer} onChange={(e) => setFooter(e.target.value)} />
      </FormField>

      {/* The Institution logo shown on every certificate always comes from
         one authoritative, platform-wide source (Site Settings → Branding
         → Logo) — the same one Transcripts already use — so it can't be
         overridden per campus here. This upload used to write to
         `institution_logo_path`, a column certificates never actually read
         (a one-time migration seed, not a live source), so saving an image
         here silently did nothing to any certificate. The upload endpoint
         and column are left in place for backward compatibility but this
         control is removed so the admin UI doesn't promise something it
         can't do. */}
      <p style={{ fontSize: ".82rem", opacity: 0.7, marginTop: 4 }}>
        The Institution logo on certificates is set once for the whole platform under Site Settings → Branding, and
        appears on every certificate automatically — it isn't configured per campus.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 8 }}>
        <div>
          {profile?.partner_logo_path && <img src={profile.partner_logo_path} alt="" style={{ height: 36, marginBottom: 6, display: "block" }} />}
          <FormField label="Partner logo">
            <input ref={partnerLogoRef} type="file" accept="image/*" />
          </FormField>
        </div>
        <div>
          {profile?.signature_path && <img src={profile.signature_path} alt="" style={{ height: 36, marginBottom: 6, display: "block" }} />}
          <FormField label="Signature">
            <input ref={signatureRef} type="file" accept="image/*" />
          </FormField>
        </div>
        <div>
          {profile?.background_image_path && <img src={profile.background_image_path} alt="" style={{ height: 36, marginBottom: 6, display: "block" }} />}
          <FormField label="Background image">
            <input ref={backgroundRef} type="file" accept="image/*" />
          </FormField>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <Button onClick={handleSave} loading={saving}>
          Save {campusName} branding
        </Button>
      </div>
    </Card>
  );
}
