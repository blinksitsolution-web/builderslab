import { useState } from "react";
import { Card, Badge, Button, ConfirmationDialog, Alert } from "../../components/ui";

const PAYMENT_TONE = { current: "success", partial: "warning", waived: "success" };
const PAYMENT_LABEL = { current: "Fees current", partial: "Paid in part", waived: "Sponsored" };

export default function WardCard({ ward, onRemove }) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (ward.unavailable) {
    return (
      <Card padding>
        <p className="text-body" style={{ margin: 0 }}>
          Couldn't load this child's account right now.
        </p>
        {ward.error && (
          <p className="text-helper" style={{ margin: 0 }}>
            {ward.error}
          </p>
        )}
      </Card>
    );
  }

  const child = ward.data;
  const paymentTone = PAYMENT_TONE[child.payment_status] || "danger";
  const paymentLabel = PAYMENT_LABEL[child.payment_status] || "Fees due";

  return (
    <Card padding className="animate-fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--space-3)", marginBottom: "var(--space-2)" }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{child.name}</h3>
          {child.campus && (
            <p className="text-helper" style={{ margin: 0 }}>
              {child.campus}
            </p>
          )}
        </div>
        <Badge tone={paymentTone}>{paymentLabel}</Badge>
      </div>

      <p className="text-helper" style={{ marginBottom: child.accessRestricted ? "var(--space-3)" : 0 }}>
        {(child.courseIds || []).length} course(s) enrolled · {(child.projects || []).length} project(s) submitted
      </p>

      {child.accessRestricted && (
        <Alert variant="warning" title="Access restricted">
          {child.accessRestrictedReason === "payment" ? "This account has an outstanding payment restriction." : "This account currently has restricted access."}
        </Alert>
      )}

      <div style={{ marginTop: "var(--space-4)" }}>
        <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
          Remove this child
        </Button>
      </div>

      <ConfirmationDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => onRemove(child.id)}
        title={`Remove ${child.name}?`}
        confirmLabel="Remove"
        confirmVariant="danger"
      >
        <p className="text-body">This unlinks {child.name} from your account. An administrator can restore this later if needed.</p>
      </ConfirmationDialog>
    </Card>
  );
}
