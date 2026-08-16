import { useState } from "react";
import { useAdminAdultLearners } from "./useAdminAdultLearners";
import { PageHeader, Card, Button, Badge, DataTable, LoadingState, ErrorState, UnauthorizedState, EmptyState } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import { LearnerClassModal, LearnerModulesModal, LearnerCampusModal } from "./AccountActionModals";
import { PaymentStatusModal } from "./PaymentActionModals";
import { ParticipantCreateModal, ParticipantCredentialsModal, InstructorsForLearnerModal } from "./ParticipantModals";

const PAYMENT_TONE = { current: "success", partial: "warning", unpaid: "danger", waived: "success" };
const PAYMENT_LABEL = { waived: "Waived (sponsored)" };

/**
 * Participants / Adult Learners (final admin migration pass). Migrates
 * legacy adminAdultLearners()/openParticipantModal()/editLearnerClass()/
 * editLearnerCampus()/viewAdultInstructors()/openPaymentStatusModal()
 * (dashboard.html) in full — same GET /api/users?role=learner&isAdult=1
 * contract and every row action legacy exposes.
 */
export default function AdminAdultLearnersPage() {
  const data = useAdminAdultLearners();
  const toast = useToast();

  const [classModalAccount, setClassModalAccount] = useState(null);
  const [campusModalAccount, setCampusModalAccount] = useState(null);
  const [modulesModalAccount, setModulesModalAccount] = useState(null);
  const [paymentModalAccount, setPaymentModalAccount] = useState(null);
  const [instructorsModal, setInstructorsModal] = useState(null); // { learner, instructors }
  const [createOpen, setCreateOpen] = useState(false);
  const [createdResult, setCreatedResult] = useState(null);

  async function openClassModal(row) {
    try {
      const full = await data.loadLearnerDetail(row.id);
      setClassModalAccount(full);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function openCampusModal(row) {
    try {
      const full = await data.loadLearnerDetail(row.id);
      setCampusModalAccount(full);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function openInstructorsModal(row) {
    try {
      const instructors = await data.loadInstructorsFor(row.id);
      setInstructorsModal({ learner: row, instructors });
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleCreateParticipant(payload) {
    const result = await data.createParticipantAccount(payload);
    setCreatedResult({ name: payload.name, email: payload.email, temporaryPassword: result.temporaryPassword });
    return result;
  }

  return (
    <div>
      <PageHeader
        title="Participants"
        description="Participants (role=learner, is_adult=1) cover Adult Professional, Corporate Training and Bootcamp learners — they manage/pay for their own access (or a Corporate Client does, per that programme's fee setup) with no parent account required. Their class and campus are set here independently of the child-learner promotion workflow. To assign an instructor, give that instructor the participant's module under Manage Accounts → Assign."
        actions={data.status === "ready" && data.catalogsReady && <Button onClick={() => setCreateOpen(true)}>+ Add Participant</Button>}
      />

      {data.status === "loading" && <LoadingState label="Loading Participants…" />}
      {data.status === "forbidden" && <UnauthorizedState description="Participants is limited to administrators." />}
      {data.status === "error" && <ErrorState description={data.error} action={{ label: "Try again", onClick: data.reload }} />}

      {data.status === "ready" && (
        <Card padding={false}>
          <DataTable
            columns={[
              {
                key: "name",
                header: "Name",
                render: (l) => (
                  <>
                    {l.name}
                    {l.student_code && (
                      <>
                        <br />
                        <span className="text-helper">{l.student_code}</span>
                      </>
                    )}
                  </>
                ),
              },
              { key: "email", header: "Email", render: (l) => l.email },
              { key: "campus", header: "Campus", render: (l) => l.campus || "—" },
              { key: "class", header: "Class", render: (l) => l.className || "—" },
              { key: "educationLevel", header: "Education level", render: (l) => l.education_level || "—" },
              { key: "paymentStatus", header: "Payment status", render: (l) => <Badge tone={PAYMENT_TONE[l.payment_status] || "neutral"}>{PAYMENT_LABEL[l.payment_status] || l.payment_status}</Badge> },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (l) => (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
                    <Button variant="ghost" size="sm" onClick={() => openClassModal(l)}>
                      Class
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openCampusModal(l)}>
                      Campus
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setModulesModalAccount(l)}>
                      Modules
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openInstructorsModal(l)}>
                      Instructors
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setPaymentModalAccount(l)}>
                      Payment
                    </Button>
                  </div>
                ),
              },
            ]}
            rows={data.learners}
            getRowKey={(l) => l.id}
            emptyState={<EmptyState title="No participants yet" />}
          />
        </Card>
      )}

      <LearnerClassModal account={classModalAccount} classes={data.classes} onClose={() => setClassModalAccount(null)} onSave={data.saveLearnerClass} />
      <LearnerCampusModal account={campusModalAccount} campuses={data.campuses} onClose={() => setCampusModalAccount(null)} onSave={data.saveLearnerCampus} />
      <LearnerModulesModal account={modulesModalAccount} modules={data.modules} onClose={() => setModulesModalAccount(null)} onSave={data.saveLearnerModules} />
      <PaymentStatusModal account={paymentModalAccount} onClose={() => setPaymentModalAccount(null)} onSave={data.savePaymentStatus} loadSummary={data.loadPaymentSummary} />
      <InstructorsForLearnerModal
        learner={instructorsModal?.learner}
        instructors={instructorsModal?.instructors || []}
        modules={data.modules}
        groupLabel="module"
        onClose={() => setInstructorsModal(null)}
      />
      <ParticipantCreateModal open={createOpen} offeringTypes={data.offeringTypes} onClose={() => setCreateOpen(false)} onCreated={handleCreateParticipant} />
      <ParticipantCredentialsModal result={createdResult} onClose={() => setCreatedResult(null)} />
    </div>
  );
}
