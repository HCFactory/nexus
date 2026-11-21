"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { FileText, Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { billcomPaymentDisplay, hawaiiToday } from "@/lib/billcom/paymentDisplay";
import { formatDate, formatMoney } from "@/lib/format";
import { BusinessCentralSalesInvoice } from "@/types/database";

/** Bill.com payment status stored for an invoice (by the sync or the invoice page). */
export interface StoredBillcomStatus {
  match: "found" | "mismatch";
  status: string | null;
  dueAmount: number | null;
  dueDate: string | null;
}

type BillcomFilter = "all" | "paid" | "pastdue" | "open" | "unmatched";
const TONE_CLASS = { success: "font-medium text-success", destructive: "font-medium text-destructive", plain: "text-foreground-muted" } as const;

interface SalesInvoicesClientProps {
  invoices: BusinessCentralSalesInvoice[];
  /** Stored Bill.com status by BC invoice id; omitted when this environment has no Bill.com. */
  billcomStatus?: Record<string, StoredBillcomStatus> | null;
  /** Business date for "Past due" (Hawaii); defaults to today. */
  today?: string;
  /** Pre-fills the search box (e.g. from ?q= when linked from a sales order). */
  initialSearch?: string;
}

/** The invoice's page in Nexus, keyed by BC's invoice id. */
const invoicePage = (invoice: BusinessCentralSalesInvoice) => `/receivables/invoices/${encodeURIComponent(invoice.bc_invoice_id)}`;

const SELECT_CLASSNAME =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

export function SalesInvoicesClient({ invoices, initialSearch, billcomStatus = null, today = hawaiiToday() }: SalesInvoicesClientProps) {
  const [billcomFilter, setBillcomFilter] = useState<BillcomFilter>("all");
  /** What the Bill.com column shows, and the filter group it falls in. */
  const billcomCell = (invoice: BusinessCentralSalesInvoice): { label: string; className: string; group: Exclude<BillcomFilter, "all"> } => {
    const s = billcomStatus?.[invoice.bc_invoice_id];
    if (!s) return { label: "—", className: "text-foreground-subtle", group: "unmatched" };
    if (s.match === "mismatch") return { label: "Doesn't match", className: "text-foreground-muted", group: "unmatched" };
    const shown = billcomPaymentDisplay(s, today);
    return { label: shown.label, className: TONE_CLASS[shown.tone], group: shown.key === "paid" ? "paid" : shown.key === "pastdue" ? "pastdue" : "open" };
  };
  const [search, setSearch] = useState(initialSearch ?? "");
  const [status, setStatus] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const statuses = useMemo(() => {
    const distinct = new Set<string>();
    for (const invoice of invoices) {
      if (invoice.status) distinct.add(invoice.status);
    }
    return Array.from(distinct).sort();
  }, [invoices]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return invoices.filter((invoice) => {
      if (query) {
        const matches =
          (invoice.bc_invoice_number ?? "").toLowerCase().includes(query) ||
          (invoice.customer_name ?? "").toLowerCase().includes(query) ||
          (invoice.external_document_number ?? "").toLowerCase().includes(query);
        if (!matches) return false;
      }
      if (status !== "all" && invoice.status !== status) return false;
      if (fromDate && (!invoice.posting_date || invoice.posting_date < fromDate)) return false;
      if (toDate && (!invoice.posting_date || invoice.posting_date > toDate)) return false;
      if (billcomStatus && billcomFilter !== "all" && billcomCell(invoice).group !== billcomFilter) return false;
      return true;
    });
    // billcomCell only reads billcomStatus and today.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices, search, status, fromDate, toDate, billcomStatus, billcomFilter, today]);

  const isTruncated = invoices.length === 500;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-0 flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Sales invoices
          </h1>
          <p className="mt-1 text-xs text-foreground-subtle">
            {invoices.length} posted invoice{invoices.length === 1 ? "" : "s"} synced from Business Central
          </p>
        </div>
      </header>

      {isTruncated && (
        <div className="border-b border-border bg-warning-subtle px-5 py-2 text-sm text-warning">
          Showing the 500 most recent posted invoices.
        </div>
      )}

      {invoices.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-10">
          <div className="max-w-sm space-y-4 text-center">
            <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-primary-subtle text-primary">
              <FileText className="size-7" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-foreground">
                No posted sales invoices synced yet
              </h2>
              <p className="text-sm text-foreground-muted">
                No posted sales invoices synced yet.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden p-3 lg:p-4">
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-raised card-shadow">
            <div className="space-y-3 border-b border-border p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by invoice number, customer, or document number"
                  className="pl-9 pr-9"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="absolute right-2 top-1/2 rounded-md p-1 -translate-y-1/2 text-foreground-subtle transition-colors hover:bg-surface hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  className={SELECT_CLASSNAME}
                  aria-label="Filter by status"
                >
                  <option value="all">All statuses</option>
                  {statuses.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                {billcomStatus && (
                  <select
                    value={billcomFilter}
                    onChange={(event) => setBillcomFilter(event.target.value as BillcomFilter)}
                    className={SELECT_CLASSNAME}
                    aria-label="Bill.com status"
                  >
                    <option value="all">All Bill.com</option>
                    <option value="paid">Paid</option>
                    <option value="pastdue">Past due</option>
                    <option value="open">Open</option>
                    <option value="unmatched">Not matched</option>
                  </select>
                )}
                <label className="flex items-center gap-1.5 text-xs text-foreground-muted">
                  From
                  <Input
                    type="date"
                    value={fromDate}
                    onChange={(event) => setFromDate(event.target.value)}
                    className="h-9 w-auto"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-xs text-foreground-muted">
                  To
                  <Input
                    type="date"
                    value={toDate}
                    onChange={(event) => setToDate(event.target.value)}
                    className="h-9 w-auto"
                  />
                </label>
              </div>
              <div className="text-xs text-foreground-muted">
                {search.trim() || status !== "all" || fromDate || toDate || billcomFilter !== "all"
                  ? `Showing ${filtered.length} of ${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`
                  : `Showing ${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-foreground-muted">
                  No invoices match the current filters.
                </p>
              ) : (
                <table className="min-w-full divide-y divide-border text-sm">
                  <thead className="sticky top-0 bg-surface-raised text-left text-xs uppercase tracking-wide text-foreground-subtle">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Invoice #</th>
                      <th className="px-4 py-2.5 font-medium">BC Invoice No.</th>
                      <th className="px-4 py-2.5 font-medium">Customer</th>
                      <th className="px-4 py-2.5 font-medium">Posting date</th>
                      <th className="px-4 py-2.5 font-medium">Due date</th>
                      <th className="px-4 py-2.5 font-medium">Currency</th>
                      <th className="px-4 py-2.5 text-right font-medium">Total incl. tax</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                      {billcomStatus && <th className="px-4 py-2.5 font-medium">Bill.com</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filtered.map((invoice) => (
                      <tr key={invoice.id} className="transition-colors hover:bg-surface">
                        <td className="p-0">
                          {invoice.external_document_number ? (
                            <Link href={invoicePage(invoice)} className="block px-4 py-2.5 font-medium text-primary hover:underline">
                              {invoice.external_document_number}
                            </Link>
                          ) : (
                            <span className="block px-4 py-2.5 text-foreground-muted">—</span>
                          )}
                        </td>
                        <td className="p-0">
                          <Link href={invoicePage(invoice)} className="block px-4 py-2.5 font-mono text-xs text-foreground-muted hover:underline">
                            {invoice.bc_invoice_number ?? "—"}
                          </Link>
                        </td>
                        <td className="p-0">
                          {invoice.customer_number ? (
                            <Link
                              href={`/customers?search=${encodeURIComponent(invoice.customer_number)}`}
                              className="block px-4 py-2.5 font-medium text-primary hover:underline"
                            >
                              {invoice.customer_name ?? invoice.customer_number}
                            </Link>
                          ) : (
                            <span className="block px-4 py-2.5 text-foreground">
                              {invoice.customer_name ?? "—"}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-foreground-muted">
                          {formatDate(invoice.posting_date)}
                        </td>
                        <td className="px-4 py-2.5 text-foreground-muted">
                          {formatDate(invoice.due_date)}
                        </td>
                        <td className="px-4 py-2.5 text-foreground-muted">
                          {invoice.currency_code ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right text-foreground">
                          {formatMoney(invoice.total_amount_including_tax, invoice.currency_code)}
                        </td>
                        <td className="px-4 py-2.5 text-foreground-muted">
                          {invoice.status ?? "—"}
                        </td>
                        {billcomStatus && (() => {
                          const cell = billcomCell(invoice);
                          return (
                            <td className="px-4 py-2.5">
                              <span className={cell.className}>{cell.label}</span>
                            </td>
                          );
                        })()}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
