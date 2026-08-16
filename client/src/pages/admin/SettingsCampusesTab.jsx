import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, FormField, Input, Checkbox, Button, DataTable, Modal, Alert, LoadingState, ErrorState, UnauthorizedState } from "../../components/ui";
import { useToast } from "../../context/ToastContext";

/**
 * Campuses (Phase 27). Migrates legacy settingsCampuses()/addCampus()/
 * loadCampusList()/toggleCampusPartner()/removeCampus()/
 * openCampusProfileModal()/saveCampusProfile() — same POST/PATCH/DELETE
 * /api/modules/campuses and PUT /api/modules/campuses/:id/offerings
 * contracts.
 */
export default function SettingsCampusesTab({ settings }) {
  const tab = settings.tabs.campuses;
  const toast = useToast();

  const [name, setName] = useState("");
  const [isPartner, setIsPartner] = useState(false);
  const [adding, setAdding] = useState(false);
  const [profileCampus, setProfileCampus] = useState(null); // null = closed
  const [focusedOnce, setFocusedOnce] = useState(false);

  // Deep link from ProgrammeGroupsModal's "Configure campus offerings"
  // action: open that campus's profile modal (offerings tab already visible
  // inside it) as soon as the campus list has loaded. Runs once per visit —
  // `focusedOnce` stops it from reopening if the admin closes the modal and
  // this tab re-renders.
  useEffect(() => {
    if (focusedOnce) return;
    if (tab.status !== "ready" || !settings.focusCampusId) return;
    const match = (tab.data?.campuses || []).find((c) => c.id === settings.focusCampusId);
    if (match) setProfileCampus(match);
    setFocusedOnce(true);
  }, [tab.status, tab.data, settings.focusCampusId, focusedOnce]);

  if (tab.status === "loading" || tab.status === "idle") return <LoadingState label="Loading campuses…" />;
  if (tab.status === "forbidden") return <UnauthorizedState description="Campus management is limited to administrators." />;
  if (tab.status === "error") return <ErrorState description={tab.error} action={{ label: "Try again", onClick: () => settings.reload("campuses") }} />;

  const { campuses, offeringTypes } = tab.data;

  async function handleAddCampus() {
    if (!name.trim()) return;
    setAdding(true);
    try {
      await settings.addCampus({ name: name.trim(), isPartner });
      setName("");
      setIsPartner(false);
      toast.success("Campus added.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleTogglePartner(id, checked) {
    try {
      await settings.toggleCampusPartner(id, checked);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleRemove(id) {
    try {
      await settings.removeCampus(id);
      toast.success("Campus removed.");
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card>
        <CardHeader
          title="Add a campus / partner school"
          subtitle='Mark a school as a "partner school" to automatically give its learners the cheaper registration and monthly fee set in Fees. Full profile (location, image, contact, available offerings) can be added after creating — click "Edit profile" on the row below.'
        />
        <FormField label="Campus / school name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. St. Peter's International School" />
        </FormField>
        <Checkbox label="This is a partner school (cheaper fees)" checked={isPartner} onChange={(e) => setIsPartner(e.target.checked)} />
        <div style={{ marginTop: 12 }}>
          <Button onClick={handleAddCampus} loading={adding}>
            Add campus
          </Button>
        </div>
      </Card>

      <Card padding={false}>
        <DataTable
          columns={[
            {
              key: "campus",
              header: "Campus",
              render: (c) => (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {c.image_path && <img src={c.image_path} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: "cover" }} />}
                  <div>
                    {c.name}
                    {c.location && <div style={{ fontSize: ".82rem", opacity: 0.7 }}>{c.location}</div>}
                  </div>
                </div>
              ),
            },
            {
              key: "partner",
              header: "Partner status",
              render: (c) => <Checkbox label="Partner school" checked={!!c.is_partner} onChange={(e) => handleTogglePartner(c.id, e.target.checked)} />,
            },
            {
              key: "offerings",
              header: "Class eligibility",
              render: (c) =>
                (c.offeringTypeIds || []).length === 0 ? (
                  <span style={{ fontSize: ".82rem", opacity: 0.75 }}>Unrestricted — no offerings configured yet</span>
                ) : (
                  <span style={{ fontSize: ".82rem" }}>
                    Restricted to {c.offeringTypeIds.length} offering type{c.offeringTypeIds.length === 1 ? "" : "s"}
                  </span>
                ),
            },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (c) => (
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Button variant="ghost" size="sm" onClick={() => setProfileCampus(c)}>
                    Edit profile
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleRemove(c.id)}>
                    Remove
                  </Button>
                </div>
              ),
            },
          ]}
          rows={campuses}
          getRowKey={(c) => c.id}
        />
      </Card>

      <CampusProfileModal
        campus={profileCampus}
        offeringTypes={offeringTypes}
        open={!!profileCampus}
        onClose={() => setProfileCampus(null)}
        onSave={settings.saveCampusProfile}
      />
    </div>
  );
}

function CampusProfileModal({ campus, offeringTypes, open, onClose, onSave }) {
  const toast = useToast();
  const imageRef = useRef(null);
  const [location, setLocation] = useState("");
  const [partnerSchoolName, setPartnerSchoolName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactAddress, setContactAddress] = useState("");
  const [selectedOfferings, setSelectedOfferings] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    if (!open || !campus) return;
    setLocation(campus.location || "");
    setPartnerSchoolName(campus.partner_school_name || "");
    setContactPhone(campus.contact_phone || "");
    setContactEmail(campus.contact_email || "");
    setContactAddress(campus.contact_address || "");
    setSelectedOfferings(new Set(campus.offeringTypeIds || []));
    setFormError(null);
    if (imageRef.current) imageRef.current.value = "";
  }, [open, campus]);

  if (!open || !campus) return null;

  function toggleOffering(id) {
    setSelectedOfferings((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSave() {
    setFormError(null);
    setSaving(true);
    try {
      await onSave(
        campus.id,
        {
          location: location.trim(),
          partnerSchoolName: partnerSchoolName.trim(),
          contactPhone: contactPhone.trim(),
          contactEmail: contactEmail.trim(),
          contactAddress: contactAddress.trim(),
          image: imageRef.current?.files?.[0] || null,
        },
        Array.from(selectedOfferings)
      );
      toast.success("Campus profile saved.");
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
      title={`Campus profile — ${campus.name}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Save profile
          </Button>
        </>
      }
    >
      <p style={{ fontSize: ".85rem", opacity: 0.75, marginBottom: 14 }}>Shown on the public Landing Page's Campuses section.</p>
      <FormField label="Location">
        <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Airport Ridge, Takoradi" />
      </FormField>
      <FormField label="Partner school name">
        <Input value={partnerSchoolName} onChange={(e) => setPartnerSchoolName(e.target.value)} placeholder="Only if hosted inside a partner school" />
      </FormField>
      <FormField label="Campus image">
        <input ref={imageRef} type="file" accept="image/*" />
      </FormField>
      {campus.image_path && <img src={campus.image_path} alt="" style={{ height: 60, borderRadius: 6, margin: "6px 0" }} />}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <FormField label="Contact phone">
          <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
        </FormField>
        <FormField label="Contact email">
          <Input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
        </FormField>
      </div>
      <FormField label="Contact address">
        <Input value={contactAddress} onChange={(e) => setContactAddress(e.target.value)} />
      </FormField>
      <FormField label="Available Learning Offerings at this campus">
        {/* FormField wraps a single form control (Children.only) — this
           block used to pass three sibling elements (two <p> + a <div>)
           directly, which threw a "React.Children.only" render exception
           the instant this modal opened. With no ErrorBoundary anywhere
           in the app (see AppShell.jsx), that exception unmounted the
           entire React tree, producing the blank page on Edit Campus.
           Wrapping everything in one <div> restores a single child while
           changing nothing visually. */}
        <div>
          <p style={{ fontSize: ".82rem", opacity: 0.75, marginTop: -4, marginBottom: 8 }}>
            Shown on the public landing page's Campuses section, <strong>and</strong> controls which offering types may be
            scheduled as ON_CAMPUS classes here. Leave everything unchecked to keep this campus{" "}
            <strong>unrestricted</strong> (any offering type may be scheduled here, and no list is shown publicly). Checking
            one or more boxes <strong>restricts</strong> this campus to only those offering types for both purposes.
          </p>
          <p style={{ fontSize: ".82rem", fontWeight: 600, marginBottom: 8 }}>
            {selectedOfferings.size === 0
              ? "Current state: unrestricted (no offerings selected)."
              : `Current state: restricted to ${selectedOfferings.size} offering type${selectedOfferings.size === 1 ? "" : "s"}.`}
          </p>
          <div>
            {(offeringTypes || []).length === 0 && <p style={{ fontSize: ".85rem", opacity: 0.7 }}>No Learning Offering Types yet.</p>}
            {(offeringTypes || []).map((t) => (
              <Checkbox
                key={t.id}
                label={`${t.icon || ""} ${t.name}`.trim()}
                checked={selectedOfferings.has(t.id)}
                onChange={() => toggleOffering(t.id)}
              />
            ))}
          </div>
        </div>
      </FormField>
      {formError && <Alert variant="danger">{formError}</Alert>}
    </Modal>
  );
}
