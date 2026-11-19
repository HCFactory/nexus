import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { User } from '@/types/database';
import { UserList } from './UserList';

afterEach(cleanup);

const user = (over: Partial<User>): User => ({
  id: 'u1', email: 'fundraisers@x.com', display_name: 'Fundraisers', role: 'user', organization_id: null, active_bc_connection_id: null,
  permissions: null, permissions_version: 1, permissions_updated_at: null, created_at: '2026-11-18T00:00:00Z', updated_at: '', ...over,
});
const org = { id: 'org-1', name: 'Hawaii Candy Factory' };

function setup(u: User) {
  const onUpdateUserAccess = vi.fn(async () => u);
  render(<UserList users={[u]} organization={org} onChangePassword={vi.fn()} onUpdateUserAccess={onUpdateUserAccess} />);
  fireEvent.click(screen.getByRole('button', { name: /edit access/i }));
  return onUpdateUserAccess;
}

describe('UserList organization membership', () => {
  it('marks unassigned users in the list', () => {
    render(<UserList users={[user({})]} organization={org} onChangePassword={vi.fn()} onUpdateUserAccess={vi.fn()} />);
    expect(screen.getByText('No organization')).toBeInTheDocument();
  });

  it('an unassigned user gets the organization on save (switch on by default)', async () => {
    const save = setup(user({}));
    expect(screen.getByRole('switch', { name: /member of hawaii candy factory/i })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('u1', expect.objectContaining({ organizationId: 'org-1' })));
  });

  it('turning the switch off removes a member’s access', async () => {
    const save = setup(user({ organization_id: 'org-1' }));
    fireEvent.click(screen.getByRole('switch', { name: /member of hawaii candy factory/i }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('u1', expect.objectContaining({ organizationId: null })));
  });
});
