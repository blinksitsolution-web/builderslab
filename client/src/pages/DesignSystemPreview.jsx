import { useState } from "react";
import Hero from "../components/hero/Hero";
import { useToast } from "../context/ToastContext";
import {
  Button,
  IconButton,
  Input,
  Select,
  Textarea,
  Checkbox,
  Radio,
  FormField,
  Card,
  CardHeader,
  CardFooter,
  Badge,
  StatusIndicator,
  Alert,
  Modal,
  Drawer,
  Dropdown,
  Tabs,
  TabPanel,
  Breadcrumbs,
  PageHeader,
  DataTable,
  Pagination,
  EmptyState,
  LoadingState,
  Skeleton,
  ErrorState,
  UnauthorizedState,
  ConfirmationDialog,
} from "../components/ui";

const SAMPLE_ROWS = [
  { id: 1, name: "Ama Boateng", cohort: "Cohort 12", status: "active", score: "94%" },
  { id: 2, name: "Kwesi Owusu", cohort: "Cohort 12", status: "pending", score: "—" },
  { id: 3, name: "Yaa Asante", cohort: "Cohort 11", status: "suspended", score: "61%" },
];

const STATUS_TONE = { active: "positive", pending: "caution", suspended: "critical" };

/**
 * Internal, dev-only preview of the shared component library (Phase 3).
 * Not linked from any real navigation and uses only inline sample data —
 * never fetches from the LMS API.
 */
export default function DesignSystemPreview() {
  const toast = useToast();
  const [tab, setTab] = useState("controls");
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [page, setPage] = useState(3);
  const [loadingDemo, setLoadingDemo] = useState(false);

  return (
    <div>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Design system", href: "#" }, { label: "Preview" }]} />}
        title="Design system preview"
        description="Internal reference for the shared component library established in Phase 3 — typography, controls, states, and layout patterns future portals will build on."
      />

      <Hero
        eyebrow="Visual foundation"
        title="A premium, education-first interface"
        description="This hero pattern is reusable for authentication, dashboard welcome banners, and major portal entry points — not wired into any real page yet."
        actions={
          <>
            <Button variant="secondary">Primary action</Button>
            <Button variant="ghost" className="on-dark">
              Secondary action
            </Button>
          </>
        }
      />

      <Section title="Typography">
        <h1 className="text-page-title">Page title / h1</h1>
        <h2 className="text-section-title">Section heading / h2</h2>
        <h3>Card / subsection heading / h3</h3>
        <p className="text-body">
          Body text uses a humanist system-sans stack for readability across every device, while headings use a classic serif stack for a premium,
          editorial feel — no webfont download required.
        </p>
        <p className="text-label">Label text</p>
        <p className="text-helper">Helper text sits beneath a form field to add context without demanding attention.</p>
        <p className="text-caption">Caption text — smallest, for captions and dense metadata.</p>
        <p className="text-data">Data / table text 12,480.50</p>
      </Section>

      <Section title="Buttons">
        <Row>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <Button variant="primary" loading={loadingDemo} onClick={() => setLoadingDemo((v) => !v)}>
            {loadingDemo ? "Loading" : "Toggle loading"}
          </Button>
        </Row>
        <Row>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <IconButton label="Add item">
            <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </IconButton>
        </Row>
      </Section>

      <Section title="Form controls">
        <div className="grid-2">
          <FormField label="Full name" required helperText="As it appears on official records.">
            <Input placeholder="Ama Boateng" />
          </FormField>
          <FormField label="Email" error="Enter a valid email address.">
            <Input type="email" placeholder="you@example.com" />
          </FormField>
          <FormField label="Cohort">
            <Select defaultValue="">
              <option value="" disabled>
                Select a cohort
              </option>
              <option>Cohort 11</option>
              <option>Cohort 12</option>
            </Select>
          </FormField>
          <FormField label="Notes" helperText="Optional — visible to instructors only.">
            <Textarea rows={3} placeholder="Add a note…" />
          </FormField>
        </div>
        <Row>
          <Checkbox label="Email me updates" defaultChecked />
          <Checkbox label="Disabled option" disabled />
          <Radio label="Option A" name="demo-radio" defaultChecked />
          <Radio label="Option B" name="demo-radio" />
        </Row>
      </Section>

      <Section title="Cards, badges & status">
        <div className="grid-2">
          <Card>
            <CardHeader title="Continuous Assessment" subtitle="Term 2 · Week 4" actions={<Badge tone="brand">New</Badge>} />
            <p className="text-body">Reusable card pattern with header/body/footer slots for future portal content.</p>
            <CardFooter>
              <Button variant="ghost" size="sm">
                Dismiss
              </Button>
              <Button variant="primary" size="sm">
                View
              </Button>
            </CardFooter>
          </Card>
          <div>
            <Row>
              <Badge tone="neutral">Neutral</Badge>
              <Badge tone="brand">Brand</Badge>
              <Badge tone="success">Success</Badge>
              <Badge tone="warning">Warning</Badge>
              <Badge tone="danger">Danger</Badge>
              <Badge tone="info">Info</Badge>
            </Row>
            <Row>
              <StatusIndicator tone="positive">Active</StatusIndicator>
              <StatusIndicator tone="caution">Pending payment</StatusIndicator>
              <StatusIndicator tone="critical">Suspended</StatusIndicator>
              <StatusIndicator tone="neutral">Archived</StatusIndicator>
            </Row>
          </div>
        </div>
      </Section>

      <Section title="Alerts & toasts">
        <Alert variant="info" title="Heads up">
          This is an informational alert for page-level messages.
        </Alert>
        <Alert variant="success" title="Saved" onDismiss={() => {}}>
          Changes were saved successfully.
        </Alert>
        <Alert variant="warning" title="Action needed">
          Some records are missing required fields.
        </Alert>
        <Alert variant="danger" title="Failed to save">
          Please check the highlighted fields and try again.
        </Alert>
        <Row>
          <Button variant="ghost" size="sm" onClick={() => toast.success("Saved successfully.")}>
            Trigger success toast
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toast.error("Something went wrong.")}>
            Trigger error toast
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toast.info("Heads up — new terms posted.")}>
            Trigger info toast
          </Button>
        </Row>
      </Section>

      <Section title="Modal, drawer & confirmation">
        <Row>
          <Button onClick={() => setModalOpen(true)}>Open modal</Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            Open confirmation
          </Button>
          <Button variant="ghost" onClick={() => setDrawerOpen(true)}>
            Open drawer
          </Button>
        </Row>
        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Example modal"
          footer={
            <>
              <Button variant="ghost" onClick={() => setModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setModalOpen(false)}>
                Save
              </Button>
            </>
          }
        >
          <p className="text-body">Modal content area — focus is trapped inside while open, and Escape or the backdrop closes it.</p>
          <FormField label="Example field">
            <Input placeholder="Try tabbing through this dialog" />
          </FormField>
        </Modal>
        <ConfirmationDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => toast.success("Confirmed.")}
          title="Remove this learner?"
          confirmLabel="Remove"
          confirmVariant="danger"
        >
          <p className="text-body">This action can't be undone.</p>
        </ConfirmationDialog>
        <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} side="right" title="Example drawer">
          <p className="text-body">Drawers share the same focus-trap and Escape behavior as Modal, sliding in from the edge instead of centering.</p>
        </Drawer>
      </Section>

      <Section title="Dropdown, tabs & breadcrumbs">
        <Row>
          <Dropdown
            trigger={<Button variant="ghost">Row actions ▾</Button>}
            items={[
              { label: "View details", onSelect: () => toast.info("Viewing details.") },
              { label: "Edit", onSelect: () => {} },
              { label: "Remove", onSelect: () => {}, danger: true },
            ]}
          />
        </Row>
        <Tabs
          tabs={[
            { key: "controls", label: "Overview" },
            { key: "data", label: "Data" },
            { key: "states", label: "States" },
          ]}
          active={tab}
          onChange={setTab}
        />
        <TabPanel tabKey="controls" active={tab}>
          <p className="text-body">Tabs use full ARIA tablist semantics with arrow-key navigation.</p>
        </TabPanel>
        <TabPanel tabKey="data" active={tab}>
          <p className="text-body">This panel would hold the data view.</p>
        </TabPanel>
        <TabPanel tabKey="states" active={tab}>
          <p className="text-body">This panel would hold state-related settings.</p>
        </TabPanel>
      </Section>

      <Section title="Data table & pagination">
        <DataTable
          columns={[
            { key: "name", header: "Name" },
            { key: "cohort", header: "Cohort" },
            { key: "status", header: "Status", render: (row) => <StatusIndicator tone={STATUS_TONE[row.status]}>{row.status}</StatusIndicator> },
            { key: "score", header: "Score", align: "right" },
          ]}
          rows={SAMPLE_ROWS}
          getRowKey={(row) => row.id}
        />
        <div style={{ marginTop: "var(--space-4)" }}>
          <Pagination page={page} totalPages={9} onChange={setPage} />
        </div>
      </Section>

      <Section title="Loading, skeleton, empty, error & unauthorized states">
        <div className="grid-2">
          <Card>
            <p className="text-label">Loading</p>
            <LoadingState label="Fetching records…" />
          </Card>
          <Card>
            <p className="text-label">Skeleton</p>
            <Skeleton variant="circle" width={40} height={40} />
            <div style={{ marginTop: "var(--space-2)" }}>
              <Skeleton height={12} width="90%" />
            </div>
            <div style={{ marginTop: "var(--space-2)" }}>
              <Skeleton height={12} width="70%" />
            </div>
          </Card>
          <Card>
            <EmptyState title="No submissions yet" description="Once learners submit work, it will show up here." action={{ label: "Refresh", onClick: () => {} }} />
          </Card>
          <Card>
            <ErrorState action={{ label: "Try again", onClick: () => {} }} />
          </Card>
          <Card>
            <UnauthorizedState action={{ label: "Back to overview", onClick: () => {} }} />
          </Card>
        </div>
      </Section>

      <p className="text-caption">Resize the window to verify responsive behavior — the sidebar becomes a Drawer, cards stack, and the table collapses to labeled rows below the tablet breakpoint.</p>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ marginTop: "var(--space-10)" }}>
      <h2 className="text-section-title">{title}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>{children}</div>
    </section>
  );
}

function Row({ children }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "center" }}>{children}</div>;
}
