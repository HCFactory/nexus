import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), redirect: vi.fn() }));
vi.mock('@/app/actions/users', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { guardPage } from './pageGuard';

const vendor = { role: 'user', permissions: { functionalRoles: { purchaser: false, vendor: true, designer: 'disabled' }, overrides: {} } };

describe('guardPage', () => {
  beforeEach(() => mocks.redirect.mockClear());

  it('sends a non-admin away from a page they cannot open, to their landing page', async () => {
    mocks.getCurrentUser.mockResolvedValue(vendor);
    await guardPage('/dashboard');
    expect(mocks.redirect).toHaveBeenCalledWith('/artwork');
  });

  it('lets them through to a page they can open', async () => {
    mocks.getCurrentUser.mockResolvedValue(vendor);
    await expect(guardPage('/artwork')).resolves.toBeUndefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('lets admins through everywhere', async () => {
    mocks.getCurrentUser.mockResolvedValue({ role: 'admin', permissions: null });
    await guardPage('/customer-lists');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('does nothing without a user (the login check handles that)', async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    await guardPage('/dashboard');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
