"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, FileText, Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { billcomPaymentDisplay, hawaiiToday } from "@/lib/billcom/paymentDisplay";
import { formatDate, formatMoney } from "@/lib/format";
import {
  SALES_INVOICE_PAGE_SIZE,
  SALES_INVOICE_STATUSES,
  salesInvoiceListSearch,
  type BillcomFilter,
  type SalesInvoiceListParams,
  type SalesInvoiceListRow,
} from "@/lib/receivables/salesInvoiceList";

/** Bill.com payment status stored for an invoice (by the sync or the invoice page). */
export interface StoredBillcomStatus {
  match: "found" | "mismatch";
  status: string | null;
  dueAmount: number | null;
  dueDate: string | null;
}

const TONE_CLASS = { success: "font-medium text-success", destructive: "font-medium text-destructive", plain: "text-foreground-muted" } as const;
const SEARCH_PAUSE_MS = 300;

interface SalesInvoicesClientProps {
  /** This page of invoices (searched, filtered and paged on the server). */
  invoices: SalesInvoiceListRow[];
  /** How many invoices match in total. */
  total: number;
  /** The search, filters and page currently shown (from the page address). */
  params: SalesInvoiceListParams;
  /** Stored Bill.com status by BC invoice id; omitted when this environment has no Bill.com. */
  billcomStatus?: Record<string, StoredBillcomStatus> | null;
  /** Business date for "Past due" (Hawaii); defaults to today. */
  today?: string;
  error?: string | null;
}

/** The invoice's page in Nexus, keyed by BC's invoice id. */
const invoicePage = (invoice: SalesInvoiceListRow) => `/receivables/invoices/${encodeURIComponent(invoice.bc_invoice_id)}`;

const SELECT_CLASSNAME =
  "h-8 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";
const PAGE_BUTTON_CLASSNAME =
  "inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-xs text-foreground transition-colors hover:bg-surface disabled:pointer-events-none disabled:opacity-40";

export function SalesInvoicesClient({ invoices, total, params, error = null, billcomStatus = null, today = hawaiiToday() }: SalesInvoicesClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  // What the boxes show and the next address builds on: the last change asked
  // for, even while the server is still loading it.
  const [view, setView] = useState(params);
  const [search, setSearch] = useState(params.search);
  /** A typed search is waiting for the pause before it runs. */
  const [typing, setTyping] = useState(false);
  const requested = useRef(params);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);

  // A new address (this page's own change arriving, or a link like the sidebar's):
  // the boxes follow it, except a search still being typed.
  const [shownParams, setShownParams] = useState(params);
  if (shownParams !== params) {
    setShownParams(params);
    setView(params);
    if (!typing) setSearch(params.search);
  }
  useEffect(() => { requested.current = params; }, [params]);

  /** Show other invoices: the server searches, filters and pages; any filter change starts at page 1. */
  const go = (changes: Partial<SalesInvoiceListParams>) => {
    const next = { ...requested.current, page: 1, ...changes };
    // A search still waiting to run goes along with this change.
    if (searchTimer.current && !("search" in changes)) {
      clearTimeout(searchTimer.current);
      searchTimer.current = null;
      setTyping(false);
      next.search = search.trim();
    }
    requested.current = next;
    setView(next);
    startTransition(() => router.replace(`${pathname}${salesInvoiceListSearch(next)}`, { scroll: false }));
  };
  const onSearch = (value: string) => {
    setSearch(value);
    setTyping(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null;
      setTyping(false);
      if (value.trim() !== requested.current.search) go({ search: value.trim() });
    }, SEARCH_PAUSE_MS);
  };
  /** Dates apply once complete: typing a year by keyboard passes through 0002, 0020… first. */
  const onDate = (key: "from" | "to", value: string) => {
    if (value === "" || value >= "1900-01-01") go({ [key]: value });
    else setView((v) => ({ ...v, [key]: value }));
  };

  /** What the Bill.com column shows. */
  const billcomCell = (invoice: SalesInvoiceListRow): { label: string; className: string } => {
    const s = billcomStatus?.[invoice.bc_invoice_id];
    if (!s) return { label: "—", className: "text-foreground-subtle" };
    if (s.match === "mismatch") return { label: "Doesn't match", className: "text-foreground-muted" };
    const shown = billcomPaymentDisplay(s, today);
    return { label: shown.label, className: TONE_CLASS[shown.tone] };
  };

  const filtering = Boolean(params.search || params.status !== "all" || params.from || params.to || (billcomStatus && params.billcom !== "all"));
  const nothingSynced = !error && total === 0 && !filtering;
  const firstShown = (params.page - 1) * SALES_INVOICE_PAGE_SIZE + 1;
  const lastShown = firstShown + invoices.length - 1;
  const hasNext = params.page * SALES_INVOICE_PAGE_SIZE < total;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-0 flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Sales invoices
          </h1>
          <p className="mt-1 text-xs text-foreground-subtle">
            Posted invoices synced from Business Central
          </p>
        </div>
      </header>

      {error && (
        <div role="alert" className="border-b border-border bg-destructive-subtle px-5 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {nothingSynced ? (
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
            <div className="space-y-2 border-b border-border px-3 py-2.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
                <Input
                  value={search}
                  onChange={(event) => onSearch(event.target.value)}
                  placeholder="Search by invoice number, customer, or document number"
                  className="h-8 pl-9 pr-9 text-sm"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => onSearch("")}
                    className="absolute right-2 top-1/2 rounded-md p-1 -translate-y-1/2 text-foreground-subtle transition-colors hover:bg-surface hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <select
                  value={view.status}
                  onChange={(event) => go({ status: event.target.value })}
                  className={SELECT_CLASSNAME}
                  aria-label="Filter by status"
                >
                  <option value="all">All statuses</option>
                  {SALES_INVOICE_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                {billcomStatus && (
                  <select
                    value={view.billcom}
                    onChange={(event) => go({ billcom: event.target.value as BillcomFilter })}
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
                {/* From and To share one row on a phone. */}
                <div className="flex w-full items-center gap-1.5 sm:w-auto">
                  <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-foreground-muted sm:flex-none">
                    From
                    <Input
                      type="date"
                      value={view.from}
                      onChange={(event) => onDate("from", event.target.value)}
                      className="h-8 min-w-0 flex-1 px-2 text-xs sm:w-auto sm:flex-none"
                    />
                  </label>
                  <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-foreground-muted sm:flex-none">
                    To
                    <Input
                      type="date"
                      value={view.to}
                      onChange={(event) => onDate("to", event.target.value)}
                      className="h-8 min-w-0 flex-1 px-2 text-xs sm:w-auto sm:flex-none"
                    />
                  </label>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-muted">
                <span aria-live="polite">
                  {total === 0
                    ? "Showing 0 invoices"
                    : `Showing ${firstShown.toLocaleString()}–${lastShown.toLocaleString()} of ${total.toLocaleString()} invoice${total === 1 ? "" : "s"}`}
                  {pending && " · Loading…"}
                </span>
                <div className="flex items-center gap-1.5">
                  <button type="button" className={PAGE_BUTTON_CLASSNAME} aria-label="Previous page" disabled={params.page <= 1 || pending} onClick={() => go({ page: view.page - 1 })}>
                    <ChevronLeft className="size-3.5" /> Previous
                  </button>
                  <button type="button" className={PAGE_BUTTON_CLASSNAME} aria-label="Next page" disabled={!hasNext || pending} onClick={() => go({ page: view.page + 1 })}>
                    Next <ChevronRight className="size-3.5" />
                  </button>
                </div>
              </div>
            </div>
            <div className={`min-h-0 flex-1 overflow-auto transition-opacity ${pending ? "opacity-60" : ""}`}>
              {error ? null : invoices.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-foreground-muted">
                  No invoices match the current filters.
                </p>
              ) : (
                <table className="min-w-full divide-y divide-border whitespace-nowrap text-sm">
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
                    {invoices.map((invoice) => (
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
