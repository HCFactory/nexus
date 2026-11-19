import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  syncBusinessCentralReceivables: vi.fn(),
  syncCustomersLight: vi.fn(),
  syncAllCustomerLists: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@/app/actions/businessCentralReceivables', () => ({
  syncBusinessCentralReceivables: actions.syncBusinessCentralReceivables,
  syncCustomersLight: actions.syncCustomersLight,
}));
vi.mock('@/app/actions/customerReferenceLists', () => ({ syncAllCustomerLists: actions.syncAllCustomerLists }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: actions.refresh }) }));

import { SyncSection } from './SyncSection';
import type { SyncOverview } from '@/app/actions/syncAdmin';

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const overview = (over: Partial<SyncOverview> = {}): SyncOverview => ({
  environment: 'Production',
  autoSync: true,
  runs: {
    full: { startedAt: '2026-11-18T20:00:00Z', finishedAt: '2026-11-18T20:02:00Z', trigger: 'scheduled', complete: true, error: null },
    lists: null,
    light: { startedAt: '2026-11-18T21:45:00Z', finishedAt: '2026-11-18T21:45:05Z', trigger: 'manual', complete: false, error: 'customer: Ship-to addresses: 404' },
  },
  ...over,
});
const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) });
const r = (complete: boolean, recordsSynced = 1, cursor: string | null = null) => ({ entityType: 'sales_invoice_line', recordsSynced, complete, cursor, error: null });

describe('SyncSection', () => {
  it('shows a row per sync with its schedule and last run', () => {
    render(<SyncSection overview={overview()} />);
    expect(within(row('Customers & Receivables')).getByText(/every 2 hours/i)).toBeInTheDocument();
    expect(within(row('Customers & Receivables')).getByText('· automatic')).toBeInTheDocument();
    expect(within(row('Customer lists')).getByText(/never/i)).toBeInTheDocument();
    expect(within(row('Customer lists')).getByText(/manual only/i)).toBeInTheDocument();
    expect(within(row('Customers \\(quick\\)')).getByText(/every 15 minutes/i)).toBeInTheDocument();
    expect(within(row('Customers \\(quick\\)')).getByText('customer: Ship-to addresses: 404')).toBeInTheDocument();
  });

  it('without Sync automatically, says the schedule is off for this environment', () => {
    render(<SyncSection overview={overview({ autoSync: false })} />);
    expect(within(row('Customers & Receivables')).getByText(/not automatic in Production/i)).toBeInTheDocument();
  });

  it('Customers & Receivables keeps running rounds until complete', async () => {
    actions.syncBusinessCentralReceivables
      .mockResolvedValueOnce([r(false, 500, 'a')])
      .mockResolvedValueOnce([r(true, 20, 'b')]);
    render(<SyncSection overview={overview()} />);
    fireEvent.click(within(row('Customers & Receivables')).getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(actions.syncBusinessCentralReceivables).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(actions.refresh).toHaveBeenCalled());
  });

  it('Customer lists syncs every list once and shows a failing list', async () => {
    actions.syncAllCustomerLists.mockResolvedValue({
      ok: true,
      results: [
        { entityType: 'Payment terms', recordsSynced: 3, complete: true, cursor: null, error: null },
        { entityType: 'Tax details', recordsSynced: 0, complete: false, cursor: null, error: 'HTTP 404' },
      ],
    });
    render(<SyncSection overview={overview()} />);
    fireEvent.click(within(row('Customer lists')).getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Tax details: HTTP 404')).toBeInTheDocument();
    expect(actions.syncAllCustomerLists).toHaveBeenCalledTimes(1);
  });

  it('a refused sync shows its message', async () => {
    actions.syncAllCustomerLists.mockResolvedValue({ ok: false, error: 'Only admins can change customer reference lists' });
    render(<SyncSection overview={overview()} />);
    fireEvent.click(within(row('Customer lists')).getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Only admins can change customer reference lists')).toBeInTheDocument();
  });

  it('no environment selected: a short note, no rows', () => {
    render(<SyncSection overview={null} />);
    expect(screen.getByText(/select a business central environment/i)).toBeInTheDocument();
    expect(screen.queryByRole('row')).toBeNull();
  });
});
