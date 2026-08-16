import { useState } from "react";
import { useAdminLearningInstances } from "./useAdminLearningInstances";
import { PageHeader, Card, Button, Badge, Select, FormField, DataTable, LoadingState, ErrorState, UnauthorizedState } from "../../components/ui";
import LearningInstanceModal from "./LearningInstanceModal";
import { useToast } from "../../context/ToastContext";

const LI_STATUS_LABEL = { upcoming: "Upcoming", active: "Active", completed: "Completed", archived: "Archived", cancelled: "Cancelled" };
const LI_STATUS_TONE = { upcoming: "neutral", active: "success", completed: "warning", archived: "neutral", cancelled: "danger" };

/**
 * Learning Instances (Phase 32). Migrates legacy adminLearningInstances()/
 * loadLearningInstancesList()/openLearningInstanceModal()/
 * saveLearningInstance()/transitionLearningInstance() (dashboard.html) in
 * full — same /api/learning-instances... contract.
 *
 * Third and final step in the Learning Offering Types → Programmes →
 * Learning Instances chain.
 */
export default function AdminLearningInstancesPage() {
  const data = useAdminLearningInstances();
  const toast = useToast();
  const [editorInstance, setEditorInstance] = useState(undefined); // undefined = closed, null = new, object = edit
  const [openingId, setOpeningId] = useState(null);

  async function openEditor(row) {
    if (!row) {
      setEditorInstance(null);
      return;
    }
    // Same as legacy's openLearningInstanceModal(id) — fetch the single
    // instance fresh rather than trusting the list row alone. Previously
    // unguarded: a failed fetch (e.g. the Run was deleted/archived by
    // someone else between page load and this click) rejected with no
    // try/catch, so the click silently did nothing — no modal, no error,
    // no feedback at all. Report the failure and refresh the list (the
    // stale row that caused it is removed) instead of failing silently.
    setOpeningId(row.id);
    try {
      const fresh = await data.getInstance(row.id);
      setEditorInstance(fresh);
    } catch (e) {
      toast.error(e.message || "Couldn't load this Learning Instance — it may have been removed.");
      data.reload();
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Learning Instances"
        description={'One scheduled run of a Programme or a Module — e.g. "Robotics & IoT — Jan 2026 Cohort" — with its own start/end dates and lifecycle status. A Programme/Module may have more than one Active run at a time — each keeps its own Academic Calendar and registration window.'}
        actions={data.status === "ready" && <Button onClick={() => openEditor(null)}>+ New Learning Instance</Button>}
      />

      {data.status === "loading" && <LoadingState label="Loading Learning Instances…" />}
      {data.status === "forbidden" && <UnauthorizedState description="Learning Instances is limited to administrators." />}
      {data.status === "error" && <ErrorState description={data.error} action={{ label: "Try again", onClick: () => data.reload() }} />}

      {data.status === "ready" && (
        <>
          <div style={{ maxWidth: 220, marginBottom: 16 }}>
            <FormField label="Filter by status">
              <Select value={data.statusFilter} onChange={(e) => data.changeStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                {Object.entries(LI_STATUS_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>

          <Card padding={false}>
            <DataTable
              columns={[
                { key: "name", header: "Name", render: (li) => <b>{li.name || "(unnamed run)"}</b> },
                { key: "offeringType", header: "Offering Type", render: (li) => li.offeringTypeName },
                {
                  key: "programmeOrModule",
                  header: "Programme/Course",
                  render: (li) => {
                    const primaryLabel = li.programmeId ? `Programme: ${li.programmeName || "—"}` : `Course: ${li.courseTitle || "—"}`;
                    const extra = (li.targets ? li.targets.length : 1) - 1;
                    return extra > 0 ? `${primaryLabel} (+${extra} more)` : primaryLabel;
                  },
                },
                { key: "startDate", header: "Start", render: (li) => li.startDate || "—" },
                { key: "endDate", header: "End", render: (li) => li.endDate || "—" },
                { key: "status", header: "Status", render: (li) => <Badge tone={LI_STATUS_TONE[li.status]}>{LI_STATUS_LABEL[li.status] || li.status}</Badge> },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  render: (li) => (
                    <Button variant="ghost" size="sm" loading={openingId === li.id} onClick={() => openEditor(li)}>
                      Edit / Manage
                    </Button>
                  ),
                },
              ]}
              rows={data.instances}
              getRowKey={(li) => li.id}
              emptyState={<div style={{ padding: 24, color: "var(--text-muted, #6b7280)" }}>No Learning Instances yet.</div>}
            />
          </Card>

          <LearningInstanceModal
            open={editorInstance !== undefined}
            existingInstance={editorInstance}
            offeringTypes={data.offeringTypes}
            programmes={data.programmes}
            modules={data.modules}
            campuses={data.campuses}
            onClose={() => setEditorInstance(undefined)}
            onSave={data.saveInstance}
            onTransition={data.transitionInstance}
            onAddTarget={data.addTarget}
            onRemoveTarget={data.removeTarget}
            onSetStructure={data.setStructure}
            onSetOperationalConfig={data.setOperationalConfigFor}
            onSetPeriodTargets={data.setTargetsForPeriod}
            onSetPeriodPaymentRequirement={data.setPaymentRequirementForPeriod}
            onUpdateActivatedCourse={data.updateActivatedCourse}
            onAssignCourse={data.assignCourseToInstance}
            onRemoveCourse={data.removeCourseFromInstance}
            onLoadOperationalGroups={data.loadOperationalGroups}
            onAddOperationalGroup={data.addOperationalGroup}
            onEditOperationalGroup={data.editOperationalGroup}
            onRemoveOperationalGroup={data.removeOperationalGroup}
          />
        </>
      )}
    </div>
  );
}
