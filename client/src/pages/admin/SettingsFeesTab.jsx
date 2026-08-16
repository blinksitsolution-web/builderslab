import { useEffect, useState } from "react";
import { Card, CardHeader, FormField, Input, Select, Button, DataTable, LoadingState, ErrorState, UnauthorizedState, IconButton } from "../../components/ui";
import { useToast } from "../../context/ToastContext";

/**
 * Fees & Payment Accounts (Phase 27). Migrates legacy settingsFees()/
 * saveFees()/addPaymentAccount()/loadPaymentAccountsList()/
 * removePaymentAccount() — same PATCH /api/settings/fees and
 * POST/DELETE /api/settings/payment-accounts contracts.
 */
export default function SettingsFeesTab({ settings }) {
  const tab = settings.tabs.fees;
  const toast = useToast();

  const [fees, setFees] = useState(null);
  const [saving, setSaving] = useState(false);
  const [network, setNetwork] = useState("MTN");
  const [number, setNumber] = useState("");
  const [accountName, setAccountName] = useState("Dalijay Tech Hub");
  const [addingAccount, setAddingAccount] = useState(false);

  useEffect(() => {
    if (tab.status === "ready") setFees(tab.data.fees || {});
  }, [tab.status, tab.data]);

  if (tab.status === "loading" || tab.status === "idle") return <LoadingState label="Loading fees…" />;
  if (tab.status === "forbidden") return <UnauthorizedState description="Fees & Payment Accounts are limited to administrators with Site Settings access." />;
  if (tab.status === "error") return <ErrorState description={tab.error} action={{ label: "Try again", onClick: () => settings.reload("fees") }} />;
  if (!fees) return null;

  function set(field) {
    return (e) => setFees((f) => ({ ...f, [field]: e.target.value }));
  }

  async function handleSaveFees() {
    setSaving(true);
    try {
      await settings.saveFees({
        registrationGHS: Number(fees.registrationGHS),
        monthlyGHS: Number(fees.monthlyGHS),
        termlyGHS: Number(fees.termlyGHS),
        partnerSchoolRegistrationGHS: Number(fees.partnerSchoolRegistrationGHS),
        partnerSchoolMonthlyGHS: Number(fees.partnerSchoolMonthlyGHS),
        ownRoboticsKitFeeGHS: Number(fees.ownRoboticsKitFeeGHS),
      });
      toast.success("Fees updated — they apply to new charges immediately.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleAddAccount() {
    if (!number.trim()) return toast.error("Account number is required.");
    setAddingAccount(true);
    try {
      await settings.createPaymentAccount({ network, accountNumber: number.trim(), accountName: accountName.trim() });
      setNumber("");
      toast.success("Payment account added.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setAddingAccount(false);
    }
  }

  async function handleRemoveAccount(id) {
    try {
      await settings.removePaymentAccount(id);
      toast.success("Payment account removed.");
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card>
        <CardHeader title="Standard fee amounts" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <FormField label="Registration fee (GHS)">
            <Input type="number" value={fees.registrationGHS ?? ""} onChange={set("registrationGHS")} />
          </FormField>
          <FormField label="Monthly fee (GHS)">
            <Input type="number" value={fees.monthlyGHS ?? ""} onChange={set("monthlyGHS")} />
          </FormField>
          <FormField label="Termly fee (GHS)">
            <Input type="number" value={fees.termlyGHS ?? ""} onChange={set("termlyGHS")} />
          </FormField>
        </div>
      </Card>

      <Card>
        <CardHeader title="Partner-school rate" subtitle="Learners whose current school is marked as a partner school (Settings → Campuses) automatically get these cheaper rates instead of the standard ones above." />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <FormField label="Partner-school registration fee (GHS)">
            <Input type="number" value={fees.partnerSchoolRegistrationGHS ?? ""} onChange={set("partnerSchoolRegistrationGHS")} />
          </FormField>
          <FormField label="Partner-school monthly fee (GHS)">
            <Input type="number" value={fees.partnerSchoolMonthlyGHS ?? ""} onChange={set("partnerSchoolMonthlyGHS")} />
          </FormField>
        </div>
      </Card>

      <Card>
        <CardHeader title="Own robotics kit surcharge" subtitle="Added on top of the registration fee for any learner who chooses to keep their own robotics kit." />
        <FormField label="Surcharge (GHS)">
          <Input type="number" value={fees.ownRoboticsKitFeeGHS ?? ""} onChange={set("ownRoboticsKitFeeGHS")} />
        </FormField>
      </Card>

      <Card>
        <CardHeader
          title="Multi-ward discount"
          subtitle="A parent registering more than one child pays the normal fee for the first child; this discount applies to the 2nd child onward only."
        />
        {/* ABRS v2.2 §15.7 — this is now a Discount Policy row (config
            data the pricing engine reads live), not a site_settings field.
            These two numbers are read-only here — genuinely current, not
            stale — but changing them requires editing the Discount Policy
            itself (POST/PATCH /api/pricing/discount-policies) since there
            is not yet a dedicated Discount Policy management screen. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <FormField label="Registration discount (%) — currently in effect">
            <Input type="number" value={fees.liveSiblingDiscountPercents?.registration ?? 0} disabled />
          </FormField>
          <FormField label="Monthly fee discount (%) — currently in effect">
            <Input type="number" value={fees.liveSiblingDiscountPercents?.monthly ?? 0} disabled />
          </FormField>
        </div>
        <p style={{ color: "var(--text-muted, #6b7280)", fontSize: 13, marginTop: 8, marginBottom: 0 }}>
          Read-only — this reflects the active Discount Policy record. Adjust it via the Pricing API's Discount
          Policies (a dedicated screen for this is on the roadmap); editing it here has no effect.
        </p>
        <div style={{ marginTop: 12 }}>
          <Button onClick={handleSaveFees} loading={saving}>
            Save all fees
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Add a payment account" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <FormField label="Network">
            <Select value={network} onChange={(e) => setNetwork(e.target.value)}>
              <option>MTN</option>
              <option>Vodafone</option>
              <option>AirtelTigo</option>
            </Select>
          </FormField>
          <FormField label="Account number">
            <Input value={number} onChange={(e) => setNumber(e.target.value)} />
          </FormField>
          <FormField label="Account name">
            <Input value={accountName} onChange={(e) => setAccountName(e.target.value)} />
          </FormField>
        </div>
        <div style={{ marginTop: 12 }}>
          <Button onClick={handleAddAccount} loading={addingAccount}>
            Add account
          </Button>
        </div>
      </Card>

      <Card padding={false}>
        <DataTable
          columns={[
            { key: "network", header: "Network", render: (a) => a.network },
            { key: "number", header: "Number", render: (a) => a.account_number },
            { key: "name", header: "Name", render: (a) => a.account_name },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (a) => (
                <IconButton label="Remove account" onClick={() => handleRemoveAccount(a.id)}>
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </IconButton>
              ),
            },
          ]}
          rows={tab.data.paymentAccounts}
          getRowKey={(a) => a.id}
        />
      </Card>
    </div>
  );
}
