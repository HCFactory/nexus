import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ctx: vi.fn(), target: null as Record<string, unknown> | null, updates: [] as Record<string, unknown>[] }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/currentUserAccess', () => ({ getCurrentUserAccessContext: mocks.ctx }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: async () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      q.select = () => q;
      q.eq = () => q;
      q.update = (p: Record<string, unknown>) => { patch = p; mocks.updates.push(p); return q; };
      q.single = async () => ({ data: patch ? { ...mocks.target, ...patch } : mocks.target, error: null });
      return q;
    },
  }),
}));

import { updateUserAccess } from './users';

const perms = { functionalRoles: { purchaser: false, vendor: false, designer: 'disabled' as const }, overrides: {} };

describe('updateUserAccess organization', () => {
  beforeEach(() => {
    mocks.updates.length = 0;
    mocks.ctx.mockResolvedValue({ user: { id: 'admin-1', organization_id: 'org-1' }, access: { canManageUsers: true } });
  });

  it('assigns a new (unassigned) user to the admin’s organization', async () => {
    mocks.target = { id: 'new-1', organization_id: null, permissions_version: 0 };
    await updateUserAccess('new-1', { role: 'user', organizationId: 'org-1', permissions: perms });
    expect(mocks.updates[0]).toMatchObject({ organization_id: 'org-1' });
  });

  it('refuses another organization', async () => {
    mocks.target = { id: 'new-1', organization_id: null, permissions_version: 0 };
    await expect(updateUserAccess('new-1', { role: 'user', organizationId: 'org-2', permissions: perms })).rejects.toThrow(
      'Admins can only assign users to their own organization',
    );
  });

  it('an admin cannot remove themselves from the organization', async () => {
    mocks.target = { id: 'admin-1', organization_id: 'org-1', permissions_version: 3 };
    await expect(updateUserAccess('admin-1', { role: 'admin', organizationId: null, permissions: perms })).rejects.toThrow(
      "You can't remove yourself from the organization.",
    );
    expect(mocks.updates).toHaveLength(0);
  });
});
