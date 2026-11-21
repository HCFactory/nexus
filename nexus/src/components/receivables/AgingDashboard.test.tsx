import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgingRow } from '@/lib/businessCentral/agingSummary';
import type { BusinessCentralSyncCheckpoint } from '@/types/database';
import { AgingDashboard } from './AgingDashboard';

afterEach(cleanup);

const row: AgingRow = {
  id: 'e1', customer_no: 'W00316', document_no: 'INV-1', document_type: 'Invoice', posting_date: '2026-10-01',
  due_date: '2026-10-31', currency_code: null, remaining_amount: 100, days_overdue: 20, as_of_date: '2026-11-20',
};
const synced = [{ entity_type: 'customer_ledger_entry', completed_full_pass: true, last_completed_at: '2026-11-20T00:00:00Z', last_error: null }] as unknown as BusinessCentralSyncCheckpoint[];

describe('AgingDashboard', () => {
  it('a customer opens their profile directly', () => {
    render(<AgingDashboard rows={[row]} asOfDate="2026-11-20" syncStatus={synced} />);
    expect(screen.getByRole('link', { name: 'W00316' })).toHaveAttribute('href', '/customers/by-number/W00316');
  });
});
