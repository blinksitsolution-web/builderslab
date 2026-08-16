import { useState } from "react";
import { useAdminSponsors } from "./useAdminSponsors";
import { PageHeader, Card, Button, Badge, DataTable, LoadingState, ErrorState, UnauthorizedState, Modal } from "../../components/ui";
import SponsorModal from "./SponsorModal";
import CreateCoordinatorModal from "./CreateCoordinatorModal";
import CoordinatorsModal from "./CoordinatorsModal";
import { useToast } from "../../context/ToastContext";

const TYPE_LABEL = { ngo: "NGO", mp: "Member of Parliament", corporate: "Corporate", individual: "Individual", other: "Other" };

/**
 * Sponsors — NGOs, MPs, corporates, or individuals covering a learner's
 * fees (see the architecture discussion this implements: sponsorship as
 * a first-class entity rather than an ad hoc admin note). Mirrors
 * AdminCorporateClientsPage.jsx's structure — same kind of org entity,
 * same list/create/edit/activate-deactivate shape — plus a roster view
 * per sponsor for reporting back to them.
 *
 * Attaching/detaching a sponsor to a specific learner happens from
 * AccountDetailDrawer.jsx, not here — this page manages the sponsor
 * roster itself and shows who's currently under each one.
 */
export default function AdminSponsorsPage() {
  const data = useAdminSponsors();
  const toast = useToast();
  const [editorSponsor, setEditorSponsor] = useState(undefined); // undefined = closed, null = new, object = edit
  const [rosterSponsor, setRosterSponsor] = useState(null);
  const [coordinatorSponsor, setCoordinatorSponsor] = useState(null);
  const [coordinatorsViewSponsor, setCoordinatorsViewSponsor] = useState(null);
  const [rosterLearners, setRosterLearners] = useState(null);
  const [rosterLoading, setRosterLoading] = useState(false);

  async function handleToggleActive(s) {
    try {
      await data.toggleActive(s.id, s.isActive);
    } catch (e) {
      toast.error(e.message || "Couldn't update this sponsor.");
    }
  }

  async function openRoster(s) {
    setRosterSponsor(s);
    setRosterLoading(true);
    try {
      const result = await data.loadLearners(s.id);
      setRosterLearners(result.learners);
    } finally {
      setRosterLoading(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Sponsors"
        description="NGOs, Members of Parliament, corporates, or individuals covering a learner's fees. Attach a sponsor to a learner from their account detail view."
        actions={data.status === "ready" && <Button onClick={() => setEditorSponsor(null)}>+ New Sponsor</Button>}
      />

      {data.status === "loading" && <LoadingState label="Loading Sponsors…" />}
      {data.status === "forbidden" && <UnauthorizedState description="Sponsors is limited to administrators." />}
      {data.status === "error" && <ErrorState description={data.error} action={{ label: "Try again", onClick: data.reload }} />}

      {data.status === "ready" && (
        <>
          <Card padding={false}>
            <DataTable
              columns={[
                { key: "name", header: "Name", render: (s) => <b>{s.name}</b> },
                { key: "type", header: "Type", render: (s) => TYPE_LABEL[s.type] || s.type },
                { key: "contactName", header: "Contact", render: (s) => s.contactName || "—" },
                { key: "contactEmail", header: "Email", render: (s) => s.contactEmail || "—" },
                {
                  key: "learnerCount",
                  header: "Learners",
                  render: (s) => (
                    <Button variant="ghost" size="sm" onClick={() => openRoster(s)}>
                      {s.learnerCount}
                      {s.maxLearners != null ? ` / ${s.maxLearners}` : ""} {s.learnerCount === 1 ? "learner" : "learners"}
                    </Button>
                  ),
                },
                { key: "status", header: "Status", render: (s) => <Badge tone={s.isActive ? "success" : "neutral"}>{s.isActive ? "Active" : "Inactive"}</Badge> },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  render: (s) => (
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <Button variant="ghost" size="sm" onClick={() => setCoordinatorsViewSponsor(s)}>
                        Coordinators
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setCoordinatorSponsor(s)} disabled={!s.isActive}>
                        + Coordinator
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditorSponsor(s)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleToggleActive(s)}>
                        {s.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  ),
                },
              ]}
              rows={data.sponsors}
              getRowKey={(s) => s.id}
              emptyState={<div style={{ padding: 24, color: "var(--text-muted, #6b7280)" }}>No sponsors yet.</div>}
            />
          </Card>

          <SponsorModal open={editorSponsor !== undefined} existingSponsor={editorSponsor} onClose={() => setEditorSponsor(undefined)} onSave={data.saveSponsor} />

          <CreateCoordinatorModal sponsor={coordinatorSponsor} onClose={() => setCoordinatorSponsor(null)} onCreated={data.reload} />

          <CoordinatorsModal sponsor={coordinatorsViewSponsor} onClose={() => setCoordinatorsViewSponsor(null)} />

          <Modal open={!!rosterSponsor} onClose={() => setRosterSponsor(null)} title={rosterSponsor ? `Learners sponsored by ${rosterSponsor.name}` : ""} size="md">
            {rosterLoading && <LoadingState label="Loading roster…" />}
            {!rosterLoading && rosterLearners && rosterLearners.length === 0 && <p>No learners currently attached to this sponsor.</p>}
            {!rosterLoading && rosterLearners && rosterLearners.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {rosterLearners.map((l) => (
                  <li key={l.id} style={{ marginBottom: 8 }}>
                    <b>{l.name}</b> — {l.email || l.phone || "no contact on file"}
                  </li>
                ))}
              </ul>
            )}
          </Modal>
        </>
      )}
    </div>
  );
}
