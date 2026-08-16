import { useState } from "react";
import { Card, CardHeader, FormField, Input, Select, Button, Badge, DataTable, LoadingState, ErrorState, UnauthorizedState } from "../../components/ui";
import { useToast } from "../../context/ToastContext";

const CALENDAR_PERIOD_TYPES = ["registration", "lesson", "midterm", "end_of_term_exam", "retake", "payment_deadline", "transcript_release", "certificate_release", "holiday"];

/**
 * Academic Calendar (Phase 27). Migrates legacy settingsAcademicCalendar()/
 * loadAcademicYearList()/addAcademicYear()/activateAcademicYear()/
 * selectAcademicYear()/addAcademicTerm()/activateAcademicTerm()/
 * selectAcademicTerm()/addCalendarPeriod()/deleteCalendarPeriodRow() — same
 * /api/academic-calendar/{years,terms,periods} contracts. Selection state
 * (which year/term is being managed) is held in the hook's cached tab
 * data, matching legacy's module-level _selectedCalYearId/_selectedCalTermId.
 */
export default function SettingsCalendarTab({ settings }) {
  const tab = settings.tabs.calendar;
  const toast = useToast();

  const [yearName, setYearName] = useState("");
  const [yearStart, setYearStart] = useState("");
  const [yearEnd, setYearEnd] = useState("");
  const [addingYear, setAddingYear] = useState(false);

  const [termName, setTermName] = useState("");
  const [addingTerm, setAddingTerm] = useState(false);

  const [periodType, setPeriodType] = useState(CALENDAR_PERIOD_TYPES[0]);
  const [periodLabel, setPeriodLabel] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [addingPeriod, setAddingPeriod] = useState(false);

  if (tab.status === "loading" || tab.status === "idle") return <LoadingState label="Loading academic calendar…" />;
  if (tab.status === "forbidden") return <UnauthorizedState description="The Academic Calendar is limited to administrators." />;
  if (tab.status === "error") return <ErrorState description={tab.error} action={{ label: "Try again", onClick: () => settings.reload("calendar") }} />;

  const { years, selectedYearId, terms, selectedTermId, periods } = tab.data;

  async function handleAddYear() {
    if (!yearName.trim()) return;
    setAddingYear(true);
    try {
      await settings.addAcademicYear({ name: yearName.trim(), startDate: yearStart || null, endDate: yearEnd || null });
      setYearName("");
      setYearStart("");
      setYearEnd("");
      toast.success("Academic year added.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setAddingYear(false);
    }
  }

  async function handleActivateYear(id) {
    try {
      await settings.makeYearActive(id);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleAddTerm() {
    if (!termName.trim() || !selectedYearId) return;
    setAddingTerm(true);
    try {
      await settings.addAcademicTerm({ academicYearId: selectedYearId, name: termName.trim(), sortOrder: terms.length + 1 });
      setTermName("");
      toast.success("Term added.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setAddingTerm(false);
    }
  }

  async function handleActivateTerm(id) {
    try {
      await settings.makeTermActive(id, selectedYearId);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleAddPeriod() {
    if (!periodStart) return toast.error("Start date is required.");
    setAddingPeriod(true);
    try {
      await settings.addCalendarPeriod({ termId: selectedTermId, type: periodType, label: periodLabel.trim() || null, startDate: periodStart, endDate: periodEnd || null });
      setPeriodLabel("");
      setPeriodStart("");
      setPeriodEnd("");
      toast.success("Calendar period added.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setAddingPeriod(false);
    }
  }

  async function handleDeletePeriod(id) {
    try {
      await settings.removeCalendarPeriod(id, selectedTermId);
      toast.success("Calendar period removed.");
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card>
        <CardHeader title="Add an Academic Year" />
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
          <FormField label="Name">
            <Input value={yearName} onChange={(e) => setYearName(e.target.value)} placeholder="e.g. 2026/2027" />
          </FormField>
          <FormField label="Start date">
            <Input type="date" value={yearStart} onChange={(e) => setYearStart(e.target.value)} />
          </FormField>
          <FormField label="End date">
            <Input type="date" value={yearEnd} onChange={(e) => setYearEnd(e.target.value)} />
          </FormField>
        </div>
        <div style={{ marginTop: 12 }}>
          <Button onClick={handleAddYear} loading={addingYear}>
            Add year
          </Button>
        </div>
      </Card>

      <Card padding={false}>
        <div style={{ padding: 16, paddingBottom: 0 }}>
          <h3 style={{ margin: 0 }}>Academic Years</h3>
        </div>
        <DataTable
          columns={[
            { key: "name", header: "Year", render: (y) => <span>{y.name} {y.is_active && <Badge tone="success">Active</Badge>}</span> },
            { key: "dates", header: "Dates", render: (y) => `${y.start_date || "—"} → ${y.end_date || "—"}` },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (y) => (
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  {!y.is_active && (
                    <Button variant="ghost" size="sm" onClick={() => handleActivateYear(y.id)}>
                      Set active
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => settings.selectYear(y.id)}>
                    Manage terms
                  </Button>
                </div>
              ),
            },
          ]}
          rows={years}
          getRowKey={(y) => y.id}
        />
      </Card>

      {selectedYearId && (
        <Card>
          <CardHeader title="Terms" />
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
            <FormField label="New term name">
              <Input value={termName} onChange={(e) => setTermName(e.target.value)} placeholder="e.g. Term 1" />
            </FormField>
          </div>
          <div style={{ marginTop: 8 }}>
            <Button onClick={handleAddTerm} loading={addingTerm}>
              Add term
            </Button>
          </div>
          <div style={{ marginTop: 12 }}>
            <DataTable
              columns={[
                { key: "name", header: "Term", render: (t) => <span>{t.name} {t.is_active && <Badge tone="success">Active</Badge>}</span> },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  render: (t) => (
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      {!t.is_active && (
                        <Button variant="ghost" size="sm" onClick={() => handleActivateTerm(t.id)}>
                          Set active (Term Transition)
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => settings.selectTerm(t.id)}>
                        Manage calendar periods
                      </Button>
                    </div>
                  ),
                },
              ]}
              rows={terms}
              getRowKey={(t) => t.id}
            />
          </div>
        </Card>
      )}

      {selectedTermId && (
        <Card>
          <CardHeader title="Calendar periods for this term" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <FormField label="Type">
              <Select value={periodType} onChange={(e) => setPeriodType(e.target.value)}>
                {CALENDAR_PERIOD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Label (optional)">
              <Input value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)} placeholder="e.g. Christmas Break" />
            </FormField>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <FormField label="Start date">
              <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
            </FormField>
            <FormField label="End date (optional)">
              <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
            </FormField>
          </div>
          <div style={{ margin: "8px 0 12px" }}>
            <Button onClick={handleAddPeriod} loading={addingPeriod}>
              Add period
            </Button>
          </div>
          <DataTable
            columns={[
              { key: "type", header: "Type", render: (p) => p.type.replace(/_/g, " ") },
              { key: "label", header: "Label", render: (p) => p.label || "—" },
              { key: "dates", header: "Dates", render: (p) => `${p.start_date}${p.end_date ? ` → ${p.end_date}` : ""}` },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (p) => (
                  <Button variant="ghost" size="sm" onClick={() => handleDeletePeriod(p.id)}>
                    Delete
                  </Button>
                ),
              },
            ]}
            rows={periods}
            getRowKey={(p) => p.id}
          />
        </Card>
      )}
    </div>
  );
}
