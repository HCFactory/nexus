import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadChargePanel, type ChargePanelView } from './chargePanelLoad';

const view = (payments: ChargePanelView['payments'] = []): ChargePanelView => ({
  eligibility: { ok: false, reason: 'x' },
  card: null,
  payments,
});

afterEach(() => vi.restoreAllMocks());

describe('loadChargePanel', () => {
  it('returns the panel data', async () => {
    const r = await loadChargePanel('inv', { canCharge: async () => true, view: async () => view() });
    expect(r).toMatchObject({ kind: 'panel', canCharge: true });
  });

  it('hides the panel from non-chargers with no payments', async () => {
    expect(await loadChargePanel('inv', { canCharge: async () => false, view: async () => view() })).toEqual({ kind: 'hidden' });
  });

  it('swallows a view error, logs it with the invoice id, and reports error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await loadChargePanel('inv-9', {
      canCharge: async () => true,
      view: async () => {
        throw new Error('boom');
      },
    });
    expect(r).toEqual({ kind: 'error' });
    expect(spy.mock.calls[0][0]).toContain('inv-9');
  });

  it('swallows a permission-read error too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await loadChargePanel('inv', {
      canCharge: async () => {
        throw new Error('no ctx');
      },
      view: async () => view(),
    });
    expect(r).toEqual({ kind: 'error' });
  });
});
