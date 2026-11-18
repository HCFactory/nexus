import type { CardLabel, CardPaymentRow, ChargeEligibility } from '@/types/stripe';

export type ChargePanelView = { eligibility: ChargeEligibility; card: CardLabel | null; payments: CardPaymentRow[] };

export type ChargePanelLoad =
  | { kind: 'panel'; canCharge: boolean; view: ChargePanelView }
  | { kind: 'hidden' }
  | { kind: 'error' };

/**
 * Loads what the Charge card panel needs without ever throwing: the panel is a
 * side feature, so a failure must not replace the whole invoice page.
 */
export async function loadChargePanel(
  bcInvoiceId: string,
  deps: { canCharge: () => Promise<boolean>; view: (bcInvoiceId: string) => Promise<ChargePanelView> },
): Promise<ChargePanelLoad> {
  try {
    const canCharge = await deps.canCharge();
    const view = await deps.view(bcInvoiceId);
    // Staff who cannot charge only see the panel when there is payment history.
    if (!canCharge && view.payments.length === 0) return { kind: 'hidden' };
    return { kind: 'panel', canCharge, view };
  } catch (e) {
    console.error(`[CardChargePanel] could not load card payments for invoice ${bcInvoiceId}:`, e);
    return { kind: 'error' };
  }
}
