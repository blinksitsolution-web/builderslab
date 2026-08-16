import { useRef, useState } from "react";
import { useInstructorTopics } from "./useInstructorTopics";
import { createTopic, setTopicCompleted } from "../../api/instructor";
import { useToast } from "../../context/ToastContext";
import { PageHeader, Card, Button, FormField, Input, Textarea, Select, Checkbox, Skeleton, EmptyState, ErrorState } from "../../components/ui";

function defaultMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function TopicRow({ topic, onToggleCompleted }) {
  return (
    <Card padding>
      <span className="text-label">{topic.month_label}</span>
      <h3 style={{ marginTop: "var(--space-2)" }}>{topic.title}</h3>
      {topic.body && <p>{topic.body}</p>}
      {topic.file_path && (
        <a href={topic.file_path} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-primary-700)", fontWeight: "var(--font-weight-semibold)" }}>
          📄 View attached file
        </a>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "var(--space-3)" }}>
        <p className="text-helper" style={{ margin: 0 }}>
          Posted by {topic.posted_by} · {(topic.date || "").slice(0, 10)}
        </p>
        <Checkbox
          label={topic.completed ? `Completed ${topic.completed_date || ""}` : "Mark as completed"}
          checked={!!topic.completed}
          onChange={(e) => onToggleCompleted(topic.id, e.target.checked)}
        />
      </div>
    </Card>
  );
}

/**
 * Instructor Monthly Topics (Phase 12). Migrates legacy instructorTopics()
 * / postTopic() / toggleTopicCompleted() (dashboard.html) — same
 * endpoints (GET/POST /api/topics, PATCH /api/topics/:id/complete).
 */
export default function InstructorTopicsPage() {
  const toast = useToast();
  const { teaching, moduleId, setModuleId, classId, setClassId, status, topics, errorMessage, reload, eligibleInstances, learningInstanceId, setLearningInstanceId } =
    useInstructorTopics();
  const [monthLabel, setMonthLabel] = useState(defaultMonth());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const fileRef = useRef(null);

  if (teaching.status === "loading") {
    return (
      <div>
        <PageHeader title="Monthly Topics" />
        <Skeleton height={120} width="100%" />
      </div>
    );
  }
  if (teaching.status === "error") {
    return <ErrorState description={teaching.errorMessage} action={{ label: "Try again", onClick: teaching.reload }} />;
  }
  if (teaching.modules.length === 0) {
    return (
      <div>
        <PageHeader title="Monthly Topics" />
        <EmptyState title="No modules assigned yet" description="Once an administrator assigns you to a module, you can post monthly topics here." />
      </div>
    );
  }

  const selectedClass = teaching.classes.find((c) => c.id === classId) || null;

  async function handlePost() {
    if (!title.trim() || !monthLabel.trim()) return toast.error("Fill in the month and title.");
    // Same "must pick which run before authoring" guard Examinations uses
    // when a module currently has more than one Active Run you're
    // assigned to.
    if (eligibleInstances.length > 1 && !learningInstanceId) {
      return toast.error("This module has more than one active run you're assigned to — choose which one this topic is for.");
    }
    setPosting(true);
    try {
      await createTopic({
        moduleId,
        monthLabel: monthLabel.trim(),
        title: title.trim(),
        body: body.trim(),
        file: fileRef.current?.files?.[0] || null,
        classId: classId || undefined,
        learningInstanceId: learningInstanceId || undefined,
      });
      toast.success("Topic posted.");
      setTitle("");
      setBody("");
      if (fileRef.current) fileRef.current.value = "";
      reload();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setPosting(false);
    }
  }

  async function handleToggleCompleted(topicId, completed) {
    try {
      await setTopicCompleted(topicId, completed);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div>
      <PageHeader title="Monthly Topics" description="Post a read-ahead topic for parents and learners." />
      <Card padding>
        <h3 style={{ marginTop: 0 }}>Post this month's topic</h3>
        <FormField label="Course">
          <Select value={moduleId || ""} onChange={(e) => setModuleId(e.target.value)}>
            {teaching.modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </Select>
        </FormField>
        {/* Same concurrent-Runs pattern as Examinations — only rendered
            when this module currently has more than one Active Run
            you're assigned to. */}
        {eligibleInstances.length > 1 && (
          <FormField label="Which run/cohort?" helperText="This module currently has more than one active run you're assigned to — choose which one this topic is for.">
            <Select value={learningInstanceId || ""} onChange={(e) => setLearningInstanceId(e.target.value)}>
              <option value="">Choose…</option>
              {eligibleInstances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name || i.id}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <FormField label="Class" helperText="Optional — leave as 'All classes' to post it for every class studying this module.">
          <Select value={classId || ""} onChange={(e) => setClassId(e.target.value || null)}>
            <option value="">All classes</option>
            {teaching.classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </FormField>
        {selectedClass?.campusName && (
          <p className="text-helper" style={{ marginTop: "calc(-1 * var(--space-2))", marginBottom: "var(--space-3)" }}>
            Campus: {selectedClass.campusName}
          </p>
        )}
        <FormField label="Month">
          <Input value={monthLabel} onChange={(e) => setMonthLabel(e.target.value)} placeholder="YYYY-MM" />
        </FormField>
        <FormField label="Topic title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Sensors & Automation" />
        </FormField>
        <FormField label="Details">
          <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        </FormField>
        <FormField label="Attach a file" helperText="Optional">
          <input ref={fileRef} type="file" />
        </FormField>
        <Button variant="primary" loading={posting} onClick={handlePost}>
          Post topic
        </Button>
      </Card>

      <section style={{ marginTop: "var(--space-8)" }}>
        <h2 className="text-section-title">Topics posted so far</h2>
        <p className="text-helper" style={{ marginTop: "calc(-1 * var(--space-2))" }}>
          Showing topics for the Course/Run/Class selected above — change them to see topics from your other assignments.
        </p>
        {status === "loading" && <Skeleton height={80} width="100%" />}
        {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}
        {status === "ready" && topics.length === 0 && <EmptyState title="No topics posted yet" description="Topics you post for this module will show up here." />}
        {status === "ready" && topics.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {topics.map((t) => (
              <TopicRow key={t.id} topic={t} onToggleCompleted={handleToggleCompleted} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
