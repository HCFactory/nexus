import { describe, expect, it } from 'vitest';

import { billcomPaymentDisplay, hawaiiToday } from './paymentDisplay';

const today = '2026-11-20';

describe('billcomPaymentDisplay', () => {
  it('Paid is green and wins even after the due date', () => {
    expect(billcomPaymentDisplay({ status: 'PAID_IN_FULL', dueAmount: 0, dueDate: '2026-11-01' }, today)).toEqual({ key: 'paid', label: 'Paid', tone: 'success' });
  });

  it('owing after the due date is Past due (red), open or partly paid', () => {
    expect(billcomPaymentDisplay({ status: 'OPEN', dueAmount: 10, dueDate: '2026-11-19' }, today)).toEqual({ key: 'pastdue', label: 'Past due', tone: 'destructive' });
    expect(billcomPaymentDisplay({ status: 'PARTIALLY_PAID', dueAmount: 5, dueDate: '2026-11-19T00:00:00Z' }, today).key).toBe('pastdue');
  });

  it('due today or later, no date, or void: Bill.com\'s own label, plain', () => {
    expect(billcomPaymentDisplay({ status: 'OPEN', dueAmount: 10, dueDate: today }, today)).toEqual({ key: 'open', label: 'Open', tone: 'plain' });
    expect(billcomPaymentDisplay({ status: 'PARTIALLY_PAID', dueAmount: 10, dueDate: null }, today)).toEqual({ key: 'open', label: 'Partially paid', tone: 'plain' });
    expect(billcomPaymentDisplay({ status: 'VOID', dueAmount: 10, dueDate: '2026-11-01' }, today)).toEqual({ key: 'void', label: 'Void', tone: 'plain' });
  });
});

describe('hawaiiToday', () => {
  it('is the date in Honolulu', () => {
    expect(hawaiiToday(new Date('2026-11-21T05:00:00Z'))).toBe('2026-11-20');
  });
});
