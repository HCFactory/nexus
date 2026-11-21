import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn(async () => ({ error: null }));
vi.mock('resend', () => ({ Resend: vi.fn(function () { return { emails: { send } }; }) }));

import { sendCardSavedNotification } from './email';

describe('sendCardSavedNotification', () => {
  beforeEach(() => {
    send.mockClear();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('CUSTOMER_EMAIL_FROM', 'Nexus <billing@example.com>');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('sends the agreed subject and body to the given addresses', async () => {
    await sendCardSavedNotification({
      to: ['fundraisers@hawaiicandyfactory.com', 'ar@example.com'],
      customerName: 'Aloha School',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      savedAt: new Date('2026-11-17T22:00:00Z'),
    });
    expect(send).toHaveBeenCalledWith({
      from: 'Nexus <billing@example.com>',
      to: ['fundraisers@hawaiicandyfactory.com', 'ar@example.com'],
      subject: 'Aloha School saved Payment Method [NEXUS]',
      text: 'Aloha School\nVisa •••• 4242, exp 12/30\nsaved Nov 17, 2026',
    });
  });

  it('pads single-digit months', async () => {
    await sendCardSavedNotification({
      to: ['ops@example.com'],
      customerName: 'Kai', brand: 'amex', last4: '0005', expMonth: 3, expYear: 2031, savedAt: new Date('2026-11-17T22:00:00Z'),
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: ['ops@example.com'],
      text: 'Kai\nAmerican Express •••• 0005, exp 03/31\nsaved Nov 17, 2026',
    }));
  });

  it('nobody to send to: sends nothing', async () => {
    await sendCardSavedNotification({
      to: [], customerName: 'Kai', brand: 'visa', last4: '1', expMonth: 1, expYear: 2030, savedAt: new Date(),
    });
    expect(send).not.toHaveBeenCalled();
  });
});
