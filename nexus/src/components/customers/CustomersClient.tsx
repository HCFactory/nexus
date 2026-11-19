"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, RefreshCw, Search, Trash2, Users, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { syncCustomersLight } from "@/app/actions/businessCentralReceivables";
import { deleteCustomerAction, type CustomerEditContext } from "@/app/actions/customerEditing";
import type { BillcomCustomerView } from "@/app/actions/billcomCustomers";
import { CustomerFormDialog, customerFormValues } from "./CustomerForm";
import { createdCustomerHref } from "./createdCustomerHref";
import { shouldSyncAgain } from "@/lib/businessCentral/sync/shouldSyncAgain";
import { BillcomPushPanel, type BillcomPushPanelHandle } from "./BillcomPushPanel";
import { BillcomStatusBadge, billcomSaveNote } from "./billcomStatus";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BusinessCentralCustomer } from "@/types/database";
import type { SyncEntityResult } from "@/lib/businessCentral/syncRunner";

interface CustomersClientProps {
  customers: BusinessCentralCustomer[];
  canSync: boolean;
  initialSearch?: string;
  /** Create/edit/delete; omitted or canEdit false = read-only. */
  edit?: CustomerEditContext;
  /** Bill.com link statuses; omitted or off = no Bill.com UI. */
  billcom?: BillcomCustomerView;
}

export const DELETE_CONFIRM = "Delete this customer? This can't be undone.";

/** Customers drawn at a time; "Show more" adds another page. */
const ROWS_PER_PAGE = 200;

/** Safety cap on automatic rounds; each round is one sync (about 1–2 minutes). */
const MAX_SYNC_ROUNDS = 200;

export function CustomersClient({ customers, canSync, initialSearch, edit, billcom }: CustomersClientProps) {
  const router = useRouter();
  const billcomOn = billcom?.on === true;
  const billcomAdmin = billcomOn && billcom?.isAdmin === true;
  const pushPanel = useRef<BillcomPushPanelHandle>(null);
  const canEdit = edit?.canEdit === true;
  // null = no form; "new" = create; otherwise the customer being edited.
  const [formFor, setFormFor] = useState<"new" | BusinessCentralCustomer | null>(null);
  const [notice, setNotice] = useState<{ text: string; href?: string } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [search, setSearch] = useState(initialSearch ?? "");
  // Drawing thousands of rows is slow: show a page of them; search still covers all.
  const [shown, setShown] = useState(ROWS_PER_PAGE);
  const [isDeleting, startDeleteTransition] = useTransition();
  const [syncResults, setSyncResults] = useState<SyncEntityResult[] | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  // Sync runs round after round on its own until everything is complete.
  const [syncRound, setSyncRound] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const stopSync = useRef(false);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return customers;
    return customers.filter((customer) => {
      return (
        customer.display_name.toLowerCase().includes(query) ||
        (customer.bc_customer_number ?? "").toLowerCase().includes(query) ||
        (customer.email ?? "").toLowerCase().includes(query)
      );
    });
  }, [customers, search]);

  const runSync = async () => {
    setSyncError(null);
    setSyncing(true);
    stopSync.current = false;
    let previous: SyncEntityResult[] | null = null;
    try {
      for (let round = 1; round <= MAX_SYNC_ROUNDS; round++) {
        setSyncRound(round);
        // Light sync: new and changed customers, card fields, ship-tos. The full
        // sync lives in Admin → Sync.
        const results = await syncCustomersLight();
        setSyncResults(results);
        if (stopSync.current || !shouldSyncAgain(results, previous)) {
          // New or changed customers were queued for Bill.com; send them now.
          if (billcomAdmin && !results.some((r) => r.error)) pushPanel.current?.startPending();
          break;
        }
        previous = results;
      }
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Business Central sync failed");
      setSyncResults(null);
    } finally {
      setSyncing(false);
    }
  };

  const removeCustomer = (customer: BusinessCentralCustomer) => {
    if (!window.confirm(DELETE_CONFIRM)) return;
    setEditError(null);
    setNotice(null);
    startDeleteTransition(async () => {
      const res = await deleteCustomerAction(customer.id);
      if (!res.ok) {
        setEditError(res.error);
        return;
      }
      const note = billcomSaveNote(res.billcom);
      setNotice({ text: note ? `Deleted ${customer.display_name}. ${note}` : `Deleted ${customer.display_name}.` });
      router.refresh();
    });
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-0 flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Customers
          </h1>
          <p className="mt-1 text-xs text-foreground-subtle">
            {customers.length} customer{customers.length === 1 ? "" : "s"} synced from Business Central
          </p>
        </div>
        {canEdit && (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setFormFor("new");
              setNotice(null);
              setEditError(null);
            }}
          >
            <Plus className="size-4" />
            New customer
          </Button>
        )}
        {canSync && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={syncing}
            onClick={() => void runSync()}
          >
            <RefreshCw className={cn("size-4", syncing && "animate-spin")} />
            {syncing ? "Syncing…" : "Sync now"}
          </Button>
        )}
        {syncing && (
          <span className="flex items-center gap-2 text-xs text-foreground-subtle">
            Round {syncRound} — keep this page open
            <Button type="button" variant="ghost" size="sm" onClick={() => (stopSync.current = true)}>
              Stop
            </Button>
          </span>
        )}
      </header>

      {billcomAdmin && <BillcomPushPanel ref={pushPanel} pendingCount={billcom?.pendingCount ?? 0} />}

      {editError && (
        <div role="alert" className="border-b border-border bg-destructive-subtle px-5 py-2 text-sm text-destructive">
          {editError}
        </div>
      )}

      {notice && (
        <div className="border-b border-border bg-warning-subtle px-5 py-2 text-sm text-foreground">
          {notice.text}{" "}
          {notice.href && (
            <Link href={notice.href} className="font-medium underline">
              Open customer
            </Link>
          )}
        </div>
      )}

      {canEdit && edit && formFor && (
          <CustomerFormDialog
            key={formFor === "new" ? "new" : formFor.id}
            customer={formFor === "new" ? null : { id: formFor.id, values: customerFormValues(formFor) }}
            templates={edit.templates}
            selectOptions={edit.selectOptions}
            onCancel={() => setFormFor(null)}
            onDone={({ id, warning, billcom: saved }) => {
              const created = formFor === "new";
              const note = billcomSaveNote(saved);
              setFormFor(null);
              if (created) {
                router.push(createdCustomerHref(id, [warning, note]));
                return;
              }
              const text = [warning, note].filter(Boolean).join(" ");
              if (text) setNotice({ text, href: `/customers/${id}` });
              else setNotice({ text: "Saved." });
              router.refresh();
            }}
          />
      )}

      {syncError && (
        <div className="border-b border-border bg-destructive-subtle px-5 py-2 text-sm text-destructive">
          {syncError}
        </div>
      )}

      {syncResults && !syncError && (
        <div className="space-y-2 border-b border-border bg-surface px-5 py-3">
          {syncResults.map((result, i) => (
            <div
              key={`${result.entityType}-${i}`}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              <span className="font-medium text-foreground">{result.entityType}</span>
              <span className="text-foreground-muted">
                {result.recordsSynced} record{result.recordsSynced === 1 ? "" : "s"} synced
              </span>
              {result.error ? (
                <Badge variant="destructive">{result.error}</Badge>
              ) : result.complete ? (
                <Badge variant="success">Complete</Badge>
              ) : syncing ? (
                <Badge variant="warning">In progress</Badge>
              ) : (
                <Badge variant="warning">
                  Incomplete — click Sync again to continue
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}

      {customers.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-10">
          <div className="max-w-sm space-y-4 text-center">
            <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-primary-subtle text-primary">
              <Users className="size-7" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-foreground">
                No customers synced yet
              </h2>
              <p className="text-sm text-foreground-muted">
                No customers synced yet. Click Sync now to pull them from Business Central.
              </p>
            </div>
            {canSync && (
              <Button type="button" disabled={syncing} onClick={() => void runSync()}>
                <RefreshCw className="size-4" />
                Sync now
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden p-3 lg:p-4">
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-raised card-shadow">
            <div className="border-b border-border p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
                <Input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setShown(ROWS_PER_PAGE);
                  }}
                  placeholder="Search by name, number, or email"
                  className="pl-9 pr-9"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setShown(ROWS_PER_PAGE);
                    }}
                    className="absolute right-2 top-1/2 rounded-md p-1 -translate-y-1/2 text-foreground-subtle transition-colors hover:bg-surface hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
              <div className="mt-3 text-xs text-foreground-muted">
                {search.trim()
                  ? `Showing ${filtered.length} of ${customers.length} customer${customers.length === 1 ? "" : "s"}`
                  : `Showing ${customers.length} customer${customers.length === 1 ? "" : "s"}`}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-foreground-muted">
                  No customers match “{search.trim()}”.
                </p>
              ) : (
                <table className="min-w-full divide-y divide-border text-sm">
                  <thead className="sticky top-0 bg-surface-raised text-left text-xs uppercase tracking-wide text-foreground-subtle">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Number</th>
                      <th className="px-4 py-2.5 font-medium">Name</th>
                      <th className="px-4 py-2.5 font-medium">City</th>
                      <th className="px-4 py-2.5 font-medium">Currency</th>
                      <th className="px-4 py-2.5 text-right font-medium">Balance</th>
                      {billcomOn && <th className="px-4 py-2.5 font-medium">Bill.com</th>}
                      {canEdit && <th className="px-4 py-2.5 text-right font-medium">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filtered.slice(0, shown).map((customer) => (
                      <tr
                        key={customer.id}
                        className="cursor-pointer transition-colors hover:bg-surface"
                      >
                        <td className="p-0">
                          <Link
                            href={`/customers/${customer.id}`}
                            className="block px-4 py-2.5 font-mono text-xs text-foreground-muted"
                          >
                            {customer.bc_customer_number ?? "—"}
                          </Link>
                        </td>
                        <td className="p-0">
                          <Link
                            href={`/customers/${customer.id}`}
                            className="block px-4 py-2.5 font-medium text-foreground"
                          >
                            {customer.display_name}
                          </Link>
                        </td>
                        <td className="p-0">
                          <Link
                            href={`/customers/${customer.id}`}
                            className="block px-4 py-2.5 text-foreground-muted"
                          >
                            {customer.city ?? "—"}
                          </Link>
                        </td>
                        <td className="p-0">
                          <Link
                            href={`/customers/${customer.id}`}
                            className="block px-4 py-2.5 text-foreground-muted"
                          >
                            {customer.currency_code ?? "—"}
                          </Link>
                        </td>
                        <td className="p-0">
                          <Link
                            href={`/customers/${customer.id}`}
                            className="block px-4 py-2.5 text-right text-foreground"
                          >
                            {formatMoney(customer.balance, customer.currency_code)}
                          </Link>
                        </td>
                        {billcomOn && (
                          <td className="px-4 py-2.5">
                            {customer.bc_customer_number && billcom?.links[customer.bc_customer_number] && (
                              <BillcomStatusBadge status={billcom.links[customer.bc_customer_number].status} />
                            )}
                          </td>
                        )}
                        {canEdit && (
                          <td className="px-4 py-1.5 text-right whitespace-nowrap">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Edit ${customer.display_name}`}
                              onClick={() => {
                                setFormFor(customer);
                                setNotice(null);
                                setEditError(null);
                              }}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Delete ${customer.display_name}`}
                              disabled={isDeleting}
                              onClick={() => removeCustomer(customer)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {filtered.length > shown && (
                <div className="flex justify-center p-3">
                  <Button type="button" variant="outline" size="sm" onClick={() => setShown((n) => n + ROWS_PER_PAGE)}>
                    Show more ({filtered.length - shown} more)
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
