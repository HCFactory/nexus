import { describe, expect, it } from 'vitest';

import { changeBlockedReason } from './invoiceChangeCheck';
import type { BillcomInvoiceStatus } from './invoiceStatus';

const st = (over: Partial<BillcomInvoiceStatus> = {}): BillcomInvoiceStatus => ({
  id: '00eX', invoiceNumber: 'W-1', status: 'OPEN', statusLabel: 'Open', totalAmount: 10, dueAmount: 10, dueDate: null, ...over,
});
const on = { billcomOn: true, hasBillcomInvoice: true };
const PAID = "Paid or partly paid in Bill.com — can't change";

describe('changeBlockedReason', () => {
  it('Bill.com off: no check', () => {
    expect(changeBlockedReason(new Error('x'), { billcomOn: false, hasBillcomInvoice: true })).toBeNull();
  });
  it('open and unpaid: allowed', () => {
    expect(changeBlockedReason(st(), on)).toBeNull();
  });
  it('partly or fully paid: blocked', () => {
    expect(changeBlockedReason(st({ dueAmount: 4 }), on)).toBe(PAID);
    expect(changeBlockedReason(st({ status: 'PAID_IN_FULL', dueAmount: 0 }), on)).toBe(PAID);
    expect(changeBlockedReason(st({ status: 'PARTIALLY_PAID', dueAmount: 4 }), on)).toBe(PAID);
  });
  it('void: blocked', () => {
    expect(changeBlockedReason(st({ status: 'VOID' }), on)).toBe('Void in Bill.com');
  });
  it("unknown amounts can't prove unpaid", () => {
    expect(changeBlockedReason(st({ dueAmount: null }), on)).toBe(PAID);
  });
  it("Bill.com unreachable: try again", () => {
    expect(changeBlockedReason(new Error('timeout'), on)).toBe("Couldn't reach Bill.com — try again");
  });
  it('Nexus created a Bill.com invoice that is gone: blocked', () => {
    expect(changeBlockedReason(null, on)).toBe("Not found in Bill.com — can't check payment");
    expect(changeBlockedReason('ambiguous', on)).toBe("Not found in Bill.com — can't check payment");
  });
  it('no Bill.com invoice yet: allowed (the change creates it)', () => {
    expect(changeBlockedReason(null, { billcomOn: true, hasBillcomInvoice: false })).toBeNull();
  });
});
