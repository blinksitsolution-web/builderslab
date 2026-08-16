import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminProgrammes } from "./useAdminProgrammes";
import { PageHeader, Card, Button, Badge, DataTable, LoadingState, ErrorState, UnauthorizedState } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import ProgrammeModal from "./ProgrammeModal";
import ProgrammeGroupsModal from "./ProgrammeGroupsModal";
import ParticipationStructuresModal from "./ParticipationStructuresModal";

/**
 * Programmes (Phase 31). Migrates legacy adminProgrammes()/
 * loadProgrammesList()/openProgrammeModal()/saveProgramme()/
 * toggleProgrammeActive() (dashboard.html) in full, including the inline
 * Batches/Cohorts (Learning Groups) editor — same
 * /api/learning-offerings/programmes... and /api/classes... contract.
 *
 * Second step in Learning Offering Types → Programmes → Learning
 * Instances. Learning Instances themselves are not migrated here.
 */
export default function AdminProgrammesPage() {
  const data = useAdminProgrammes();
  const toast = useToast();
  const navigate = useNavigate();
  const [editorProgramme, setEditorProgramme] = useState(undefined); // undefined = closed, null = new, object = edit
  const [groupsProgrammeId, setGroupsProgrammeId] = useState(null);
  const [structuresProgrammeId, setStructuresProgrammeId] = useState(null);

  async function handleToggleActive(p) {
    try {
      await data.toggleActive(p.id, p.isActive);
      toast.success(p.isActive ? "Deactivated." : "Activated.");
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div>
      <PageHeader
        title="Programmes"
        description="A Programme is scoped to a Learning Offering Type (and, for Corporate Training, a Corporate Client). Manage each programme's Course Library, Participation Structures, and Batches/Cohorts (or Programme Levels, where a Participation Structure uses progression) from here."
        actions={data.status === "ready" && <Button onClick={() => setEditorProgramme(null)}>+ New Programme</Button>}
      />

      {data.status === "loading" && <LoadingState label="Loading Programmes…" />}
      {data.status === "forbidden" && <UnauthorizedState description="Programmes is limited to administrators." />}
      {data.status === "error" && <ErrorState description={data.error} action={{ label: "Try again", onClick: data.reload }} />}

      {data.status === "ready" && (
        <>
          <Card padding={false}>
            <DataTable
              columns={[
                {
                  key: "name",
                  header: "Programme",
                  render: (p) => (
                    <span>
                      <b>{p.name}</b>
                      {p.durationLabel && <div style={{ color: "var(--text-muted, #6b7280)", fontSize: 12 }}>{p.durationLabel}</div>}
                    </span>
                  ),
                },
                { key: "offeringType", header: "Offering Type", render: (p) => p.offeringTypeName },
                { key: "corporateClient", header: "Corporate Client", render: (p) => p.corporateClientName || "—" },
                { key: "groupLabel", header: "Group label", render: (p) => p.learningGroupLabel || "Class" },
                { key: "status", header: "Status", render: (p) => <Badge tone={p.isActive ? "success" : "neutral"}>{p.isActive ? "Active" : "Inactive"}</Badge> },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  render: (p) => (
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <Button variant="ghost" size="sm" onClick={() => setStructuresProgrammeId(p.id)}>
                        Participation Structures
                      </Button>
                      {/* ABRS v2.1 Admin Workflow Redesign checkpoint, Part 3 — this label
                          is resolved server-side from the Programme's own Participation
                          Structure configuration (usesProgrammeLevels), never a hardcoded
                          programme/offering-type name, so it can never disagree with what
                          ParticipationStructuresModal reports for the same Programme. */}
                      <Button variant="ghost" size="sm" onClick={() => setGroupsProgrammeId(p.id)}>
                        {p.usesProgrammeLevels ? "Programme Levels" : "Batches/Cohorts"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditorProgramme(p)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleToggleActive(p)}>
                        {p.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  ),
                },
              ]}
              rows={data.programmes}
              getRowKey={(p) => p.id}
              emptyState={<div style={{ padding: 24, color: "var(--text-muted, #6b7280)" }}>No programmes yet.</div>}
            />
          </Card>

          <ProgrammeModal
            open={editorProgramme !== undefined}
            existingProgramme={editorProgramme}
            offeringTypes={data.offeringTypes}
            corporateClients={data.corporateClients}
            onClose={() => setEditorProgramme(undefined)}
            onSave={data.saveProgramme}
            onNavigate={navigate}
            onOpenParticipationStructures={(pid) => {
              setEditorProgramme(undefined);
              setStructuresProgrammeId(pid);
            }}
            onOpenProgrammeLevels={(pid) => {
              setEditorProgramme(undefined);
              setGroupsProgrammeId(pid);
            }}
          />

          <ProgrammeGroupsModal
            open={groupsProgrammeId !== null}
            programmeId={groupsProgrammeId}
            onClose={() => setGroupsProgrammeId(null)}
            onChanged={data.reload}
            // ABRS v2.2 §11 — fee/delivery/campus/capacity/instructor/schedule
            // now live on Operational Groups, configured from that Programme's
            // active Programme Run, not from this Programme Level editor.
            onManageOperationalGroups={() => {
              setGroupsProgrammeId(null);
              navigate("/app/admin/learning-instances");
            }}
          />

          <ParticipationStructuresModal
            open={structuresProgrammeId !== null}
            programmeId={structuresProgrammeId}
            onClose={() => setStructuresProgrammeId(null)}
            onChanged={data.reload}
          />
        </>
      )}
    </div>
  );
}
