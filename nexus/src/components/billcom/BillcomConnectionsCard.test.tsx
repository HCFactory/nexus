import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  listBillcomConnections: vi.fn(async () => []),
  saveBillcomConnection: vi.fn(async () => 'new-1'),
  deleteBillcomConnection: vi.fn(),
  setBillcomConnectionEnabled: vi.fn(),
  testBillcomConnection: vi.fn(),
}));
vi.mock('@/app/actions/billcom', () => actions);

import { BillcomConnectionsCard } from './BillcomConnectionsCard';

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
};
const type = (id: string, value: string) =>
  fireEvent.change(document.getElementById(id)!, { target: { value } });

beforeEach(() => vi.clearAllMocks());

describe('BillcomConnectionsCard form', () => {
  it('sends the password exactly as typed, keeping leading and trailing spaces', async () => {
    render(<BillcomConnectionsCard />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '+ New Connection' }));
    type('billcomDisplayName', ' Sandbox ');
    type('billcomUsername', ' nexus ');
    type('billcomOrgId', '008ORG');
    type('billcomDevKey', ' key ');
    type('billcomPassword', '  pa ss  ');
    fireEvent.click(screen.getByRole('button', { name: 'Create Connection' }));
    await flush();

    expect(actions.saveBillcomConnection).toHaveBeenCalledWith(
      expect.objectContaining({ password: '  pa ss  ', username: 'nexus', displayName: 'Sandbox', devKey: 'key' }),
    );
  });
});
