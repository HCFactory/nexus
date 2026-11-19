// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    expect(await redirectsToLogin('/api/cron/sync')).toBe(false);
  });

  it('still sends other pages to login', async () => {
    expect(await redirectsToLogin('/customers')).toBe(true);
    expect(await redirectsToLogin('/card-setup')).toBe(true);
    expect(await redirectsToLogin('/api/stripe/other')).toBe(true);
  });
});

describe('the card setup address (CARD_SETUP_BASE_URL on its own host)', () => {
  afterEach(() => vi.unstubAllEnvs());
  const on = (host: string, path: string) => updateSession(new NextRequest(`https://${host}${path}`));
  const stub = () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nexus.example.com');
    vi.stubEnv('CARD_SETUP_BASE_URL', 'https://payment.example.com');
  };

  it('serves card setup pages there', async () => {
    stub();
    for (const path of ['/card-setup/abc', '/card-setup/abc/done?session_id=cs_1']) {
      const res = await on('payment.example.com', path);
      expect(res.status).not.toBe(404);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('every other page is a plain 404 that never mentions or points to the main address', async () => {
    stub();
    for (const path of ['/', '/login', '/admin?tab=x', '/card-setup', '/api/stripe/webhook/11111111-2222-4333-8444-555555555555']) {
      const res = await on('payment.example.com', path);
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
      const body = await res.text();
      expect(body).toBe('Not found');
    }
  });

  it('the host match ignores letter case', async () => {
    stub();
    expect((await on('PAYMENT.example.com', '/admin')).status).toBe(404);
  });

  it('leaves the main address alone', async () => {
    stub();
    expect(await redirectsToLogin('/customers')).toBe(true);
    expect((await on('nexus.example.com', '/card-setup/abc')).headers.get('location')).toBeNull();
  });

  it('does nothing when both settings point at the same host, or when unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nexus.example.com');
    vi.stubEnv('CARD_SETUP_BASE_URL', 'https://nexus.example.com');
    expect(await redirectsToLogin('/customers')).toBe(true);
    vi.unstubAllEnvs();
    vi.stubEnv('CARD_SETUP_BASE_URL', '');
    expect((await on('payment.example.com', '/card-setup/abc')).headers.get('location')).toBeNull();
  });
});
