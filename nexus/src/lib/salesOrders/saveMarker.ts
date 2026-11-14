// Marker for a save that stopped part-way (shared by the save action, the
// sweep and the sync; its own module so none of them import each other for it).

/**
 * sync_error prefix of a save that stopped part-way. Such an order has
 * half-written lines, so nothing sends it to BC until a successful re-save
 * (which sets pending and clears sync_error).
 */
export const SAVE_UNFINISHED = 'Save did not finish';

/** True for a failed order whose last save did not finish. */
export function isUnfinishedSave(order: { sync_state: string; sync_error: string | null }): boolean {
  return order.sync_state === 'failed' && (order.sync_error ?? '').startsWith(`${SAVE_UNFINISHED}:`);
}
