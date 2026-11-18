// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { updateSession } from './middleware';

const redirectsToLogin = async (path: string) => {
  const res = await updateSession(new NextRequest(`https://nexus.example.com${path}`));
  return res.headers.get('location')?.endsWith('/login') ?? false;
};

describe('updateSession without a signed-in user', () => {
  it('lets card setup pages and the Stripe webhook through', async () => {
    expect(await redirectsToLogin('/card-setup/abc')).toBe(false);
    expect(await redirectsToLogin('/card-setup/abc/done?session_id=cs_1')).toBe(false);
    expect(await redirectsToLogin('/api/stripe/webhook/11111111-2222-4333-8444-555555555555')).toBe(false);
  });

  it('still sends other pages to login', async () => {
    expect(await redirectsToLogin('/customers')).toBe(true);
    expect(await redirectsToLogin('/card-setup')).toBe(true);
    expect(await redirectsToLogin('/api/stripe/other')).toBe(true);
  });
});
