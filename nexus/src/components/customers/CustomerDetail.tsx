"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deleteCustomerAction, type CustomerEditContext } from "@/app/actions/customerEditing";
import { formatDate, formatMoney } from "@/lib/format";
import {
  BusinessCentralCustomer,
  BusinessCentralCustomerLedgerEntry,
  BusinessCentralSalesInvoice,
} from "@/types/database";
import { CustomerForm, customerFormValues } from "./CustomerForm";
import { DELETE_CONFIRM } from "./CustomersClient";

interface CustomerDetailProps {
  customer: BusinessCentralCustomer;
  invoices: BusinessCentralSalesInvoice[];
  ledgerEntries: BusinessCentralCustomerLedgerEntry[];
  edit?: CustomerEditContext;
}

function ReadonlyField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-[11px] uppercase tracking-wide text-foreground-subtle">
        {label}
      </p>
      <div className="text-sm text-foreground">{value}</div>
    </div>
  );
}

function FieldCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-raised p-4 card-shadow">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{title}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {children}
      </div>
    </div>
  );
}

export function CustomerDetail({ customer, invoices, ledgerEntries, edit }: CustomerDetailProps) {
  const router = useRouter();
  const canEdit = edit?.canEdit === true;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const remove = () => {
    if (!window.confirm(DELETE_CONFIRM)) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteCustomerAction(customer.id);
      if (res.ok) router.push("/customers");
      else setError(res.error);
    });
  };

  const address = [customer.address_line_1, customer.address_line_2]
    .filter(Boolean)
    .join(", ");
  const cityLine = [customer.city, customer.state, customer.postal_code]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <Button asChild variant="ghost" size="icon-sm">
          <Link href="/customers" aria-label="Back to customers">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {customer.display_name}
            </h1>
            {customer.blocked && customer.blocked !== "" && (
              <Badge variant="destructive">Blocked: {customer.blocked}</Badge>
            )}
          </div>
          <p className="mt-1 font-mono text-xs text-foreground-muted">
            {customer.bc_customer_number ?? "No BC number"}
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={() => setEditing(true)}>
              <Pencil className="size-4" />
              Edit
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={remove}>
              <Trash2 className="size-4" />
              Delete
            </Button>
          </div>
        )}
      </header>

      {error && (
        <div role="alert" className="border-b border-border bg-destructive-subtle px-5 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-5xl space-y-4">
          {canEdit && edit && editing && (
            <CustomerForm
              customer={{ id: customer.id, values: customerFormValues(customer) }}
              templates={edit.templates}
              selectOptions={edit.selectOptions}
              onCancel={() => setEditing(false)}
              onDone={() => {
                setEditing(false);
                router.refresh();
              }}
            />
          )}
          <FieldCard title="Profile and contact">
            <ReadonlyField label="Name" value={customer.display_name} />
            <ReadonlyField label="Email" value={customer.email ?? "—"} />
            <ReadonlyField label="Phone" value={customer.phone_number ?? "—"} />
            <ReadonlyField label="Website" value={customer.website ?? "—"} />
            <ReadonlyField label="Address" value={address || "—"} />
            <ReadonlyField label="City / State / Postal" value={cityLine || "—"} />
            <ReadonlyField label="Country" value={customer.country ?? "—"} />
          </FieldCard>

          <FieldCard title="Commercial terms">
            <ReadonlyField label="Currency" value={customer.currency_code ?? "—"} />
            <ReadonlyField
              label="Payment terms"
              value={customer.payment_terms_id ?? "—"}
            />
            <ReadonlyField
              label="Blocked"
              value={
                customer.blocked && customer.blocked !== "" ? (
                  <Badge variant="destructive">{customer.blocked}</Badge>
                ) : (
                  <Badge variant="success">No</Badge>
                )
              }
            />
            <ReadonlyField
              label="Balance"
              value={formatMoney(customer.balance, customer.currency_code)}
            />
          </FieldCard>

          <div className="rounded-xl border border-border bg-surface-raised card-shadow">
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Sales invoices</h3>
            </div>
            {invoices.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-foreground-muted">
                No invoices synced for this customer.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-border text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-foreground-subtle">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Number</th>
                      <th className="px-4 py-2.5 font-medium">Posting date</th>
                      <th className="px-4 py-2.5 font-medium">Due date</th>
                      <th className="px-4 py-2.5 text-right font-medium">Total (incl. tax)</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {invoices.map((invoice) => (
                      <tr key={invoice.id}>
                        <td className="px-4 py-2.5 font-mono text-xs text-foreground-muted">
                          {invoice.bc_invoice_number ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 text-foreground-muted">
                          {formatDate(invoice.posting_date)}
                        </td>
                        <td className="px-4 py-2.5 text-foreground-muted">
                          {formatDate(invoice.due_date)}
                        </td>
                        <td className="px-4 py-2.5 text-right text-foreground">
                          {formatMoney(
                            invoice.total_amount_including_tax,
                            invoice.currency_code
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-foreground-muted">
                          {invoice.status ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-surface-raised card-shadow">
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Ledger entries</h3>
            </div>
            {ledgerEntries.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-foreground-muted">
                No ledger entries synced for this customer.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-border text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-foreground-subtle">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Posting date</th>
                      <th className="px-4 py-2.5 font-medium">Document type</th>
                      <th className="px-4 py-2.5 font-medium">Document number</th>
                      <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                      <th className="px-4 py-2.5 text-right font-medium">Remaining</th>
                      <th className="px-4 py-2.5 font-medium">Open</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {ledgerEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td className="px-4 py-2.5 text-foreground-muted">
                          {formatDate(entry.posting_date)}
                        </td>
                        <td className="px-4 py-2.5 text-foreground-muted">
                          {entry.document_type ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-foreground-muted">
                          {entry.document_no ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right text-foreground">
                          {formatMoney(entry.amount, entry.currency_code)}
                        </td>
                        <td className="px-4 py-2.5 text-right text-foreground">
                          {formatMoney(entry.remaining_amount, entry.currency_code)}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge variant={entry.open ? "warning" : "secondary"}>
                            {entry.open ? "Open" : "Closed"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
