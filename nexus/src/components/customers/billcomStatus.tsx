import { Badge } from "@/components/ui/badge";
import type { BillcomCustomerLinkStatus } from "@/types/database";

const LABELS: Record<BillcomCustomerLinkStatus, { text: string; variant: "success" | "secondary" | "destructive" | "warning" }> = {
  synced: { text: "Synced", variant: "success" },
  pending: { text: "Waiting", variant: "secondary" },
  failed: { text: "Failed", variant: "destructive" },
  needs_attention: { text: "Needs attention", variant: "warning" },
};

export function BillcomStatusBadge({ status }: { status: BillcomCustomerLinkStatus }) {
  const label = LABELS[status];
  if (!label) return null;
  return <Badge variant={label.variant}>{label.text}</Badge>;
}

type SaveStatus = { status: "synced" | "pending" | "failed" | "off"; message?: string };

/** Plain-language note to show after a save, or null when Bill.com is up to date. */
export function billcomSaveNote(billcom: SaveStatus | undefined): string | null {
  if (!billcom || billcom.status === "synced") return null;
  if (billcom.status === "off") return billcom.message ?? null;
  const lead =
    billcom.status === "pending"
      ? "Saved. Bill.com will be updated shortly."
      : "Saved, but Bill.com could not be updated.";
  return billcom.message ? `${lead} ${billcom.message}` : lead;
}
