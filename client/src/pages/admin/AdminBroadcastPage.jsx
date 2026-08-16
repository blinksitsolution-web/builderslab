import { useAdminBroadcast } from "./useAdminBroadcast";
import { PageHeader, Card, Button, FormField, Input, Textarea } from "../../components/ui";
import { useToast } from "../../context/ToastContext";

/**
 * Broadcast Messages (final admin migration pass). Migrates legacy
 * adminBroadcast()/sendBroadcast() (dashboard.html) — sends one message to
 * every parent in a single call.
 */
export default function AdminBroadcastPage() {
  const data = useAdminBroadcast();
  const toast = useToast();

  async function handleSend() {
    try {
      const sentTo = await data.send();
      toast.success(`Sent to ${sentTo} parent(s).`);
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div>
      <PageHeader title="Broadcast Messages" />
      <Card padding>
        <h3 className="text-section-title">Send a reminder to all parents</h3>
        <FormField label="Subject" style={{ marginTop: "var(--space-3)" }}>
          <Input value={data.subject} onChange={(e) => data.setSubject(e.target.value)} placeholder="e.g. Fees due reminder" />
        </FormField>
        <FormField label="Message" style={{ marginTop: "var(--space-3)" }}>
          <Textarea rows={4} value={data.body} onChange={(e) => data.setBody(e.target.value)} />
        </FormField>
        <Button style={{ marginTop: "var(--space-3)" }} loading={data.sending} onClick={handleSend}>
          Send to all parents
        </Button>
      </Card>
    </div>
  );
}
