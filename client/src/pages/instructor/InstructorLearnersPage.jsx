import { useState } from "react";
import { useInstructorLearners } from "./useInstructorLearners";
import { PageHeader, Card, Badge, Button, FormField, Input, Select, DataTable, EmptyState, ErrorState } from "../../components/ui";
import PromotionRecommendationModal from "./PromotionRecommendationModal";
import { useToast } from "../../context/ToastContext";

/**
 * Instructor My Learners (Phase 12). Migrates legacy instructorLearners()
 * / filterLearners() (dashboard.html) — same fields (name, campus, class,
 * fee status), same search/campus/class filters, same GET /api/users
 * endpoint and server-enforced scope.
 *
 * Promotion Subsystem (ABRS v2.1 §12), Checkpoint 4 report Remaining work
 * item 2 — adds a "Recommend" action per learner, opening
 * PromotionRecommendationModal. Only shown for learners who currently
 * have a Programme Level assigned (class_id) — an instructor recommends
 * for a learner's current level, so there's nothing to recommend against
 * otherwise. The server independently re-checks that this instructor is
 * actually assigned to the learner's current class before accepting it.
 */
export default function InstructorLearnersPage() {
  const { teaching, status, learners, campuses, errorMessage, search, setSearch, campus, setCampus, classId, setClassId, reload } = useInstructorLearners();
  const toast = useToast();
  const [recommendLearner, setRecommendLearner] = useState(null);

  return (
    <div>
      <PageHeader title="My Learners" description="Learners in the classes and modules you're assigned to teach." />
      <Card padding>
        <div className="grid-3">
          <FormField label="Search by name">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type a name…" />
          </FormField>
          <FormField label="Campus">
            <Select value={campus} onChange={(e) => setCampus(e.target.value)}>
              <option value="">All campuses</option>
              {campuses.map((c) => (
                <option key={c.id || c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Class">
            <Select value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">All my classes</option>
              {teaching.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </Card>

      <div style={{ marginTop: "var(--space-6)" }}>
        {status === "error" ? (
          <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />
        ) : (
          <DataTable
            loading={status === "loading"}
            rows={learners}
            getRowKey={(l) => l.id}
            emptyState={<EmptyState title="No matching learners" description="Try a different name, campus, or class filter." />}
            columns={[
              { key: "name", header: "Name", render: (l) => l.name },
              { key: "campus", header: "Campus", render: (l) => l.campus || "—" },
              { key: "className", header: "Class", render: (l) => l.className || "—" },
              {
                key: "fees",
                header: "Fees",
                render: (l) => <Badge tone={l.payment_status === "current" ? "success" : "danger"}>{l.payment_status || "—"}</Badge>,
              },
              {
                key: "promotion",
                header: "",
                render: (l) =>
                  l.class_id ? (
                    <Button variant="ghost" size="sm" onClick={() => setRecommendLearner(l)}>
                      Recommend
                    </Button>
                  ) : (
                    "—"
                  ),
              },
            ]}
          />
        )}
      </div>

      <PromotionRecommendationModal
        learner={recommendLearner}
        onClose={() => setRecommendLearner(null)}
        onSubmitted={() => toast.success(`Recommendation recorded for ${recommendLearner?.name}.`)}
      />
    </div>
  );
}
