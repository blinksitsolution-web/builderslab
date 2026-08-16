import { useEffect, useState } from "react";
import { Card, CardHeader, FormField, Input, Textarea, Button } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import CmsTabState from "./CmsTabState";

/**
 * Hero & Contact (Phase 28). Migrates legacy settingsLanding()/saveHero()/
 * saveContact() — same PATCH /api/settings/hero and /api/settings/contact
 * contracts.
 */
export default function CmsHeroContactTab({ cms }) {
  const tab = cms.tabs.hero;
  const toast = useToast();

  const [eyebrow, setEyebrow] = useState("");
  const [title, setTitle] = useState("");
  const [lead, setLead] = useState("");
  const [savingHero, setSavingHero] = useState(false);

  const [facebook, setFacebook] = useState("");
  const [tiktok, setTiktok] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [savingContact, setSavingContact] = useState(false);

  useEffect(() => {
    if (tab.status !== "ready") return;
    setEyebrow(tab.data.hero.eyebrow || "");
    setTitle(tab.data.hero.title || "");
    setLead(tab.data.hero.lead || "");
    setFacebook(tab.data.contact.facebook || "");
    setTiktok(tab.data.contact.tiktok || "");
    setWhatsapp(tab.data.contact.whatsapp || "");
    setPhone(tab.data.contact.phone || "");
    setEmail(tab.data.contact.email || "");
    setWebsite(tab.data.contact.website || "");
  }, [tab.status, tab.data]);

  async function handleSaveHero() {
    setSavingHero(true);
    try {
      await cms.saveHero({ eyebrow, title, lead });
      toast.success("Landing page hero updated.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingHero(false);
    }
  }

  async function handleSaveContact() {
    setSavingContact(true);
    try {
      await cms.saveContact({ facebook, tiktok, whatsapp, phone, email, website });
      toast.success("Contact details updated.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingContact(false);
    }
  }

  return (
    <CmsTabState tab={tab} loadingLabel="Loading hero & contact content…" forbiddenDescription="Landing Page CMS is limited to administrators." onRetry={() => cms.reload("hero")}>
      {() => (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card>
            <CardHeader title="Hero section" />
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <FormField label="Eyebrow text">
                <Input value={eyebrow} onChange={(e) => setEyebrow(e.target.value)} />
              </FormField>
              <FormField label="Headline">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              </FormField>
              <FormField label="Lead paragraph">
                <Textarea rows={3} value={lead} onChange={(e) => setLead(e.target.value)} />
              </FormField>
            </div>
            <div style={{ marginTop: 12 }}>
              <Button onClick={handleSaveHero} loading={savingHero}>
                Save hero content
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader title="Contact details" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <FormField label="Facebook">
                <Input value={facebook} onChange={(e) => setFacebook(e.target.value)} />
              </FormField>
              <FormField label="TikTok">
                <Input value={tiktok} onChange={(e) => setTiktok(e.target.value)} />
              </FormField>
              <FormField label="WhatsApp">
                <Input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} />
              </FormField>
              <FormField label="Phone">
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
              </FormField>
              <FormField label="Email">
                <Input value={email} onChange={(e) => setEmail(e.target.value)} />
              </FormField>
              <FormField label="Website">
                <Input value={website} onChange={(e) => setWebsite(e.target.value)} />
              </FormField>
            </div>
            <div style={{ marginTop: 12 }}>
              <Button onClick={handleSaveContact} loading={savingContact}>
                Save contact details
              </Button>
            </div>
          </Card>
        </div>
      )}
    </CmsTabState>
  );
}
