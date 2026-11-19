import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn<(msg: Record<string, string>) => Promise<{ error: null }>>(async () => ({ error: null }));
vi.mock('resend', () => ({ Resend: vi.fn(function () { return { emails: { send } }; }) }));

import { sendCardSetupEmail } from './email';

const base = {
  to: 'ap@aloha.org',
  organizationName: 'Hawaii Candy Factory',
  customerName: 'Aloha School',
  url: 'https://payments.example.com/card-setup/abc123',
  expiresAt: '2026-12-02T09:00:00Z',
};

describe('sendCardSetupEmail', () => {
  beforeEach(() => {
    send.mockClear();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('CUSTOMER_EMAIL_FROM', 'Hawaii Candy Factory <payments@example.com>');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('greets with "Hi", never "Hello", in both versions', async () => {
    await sendCardSetupEmail(base);
    const msg = send.mock.calls[0][0];
    expect(msg.text.startsWith('Hi Aloha School,')).toBe(true);
    expect(msg.html).toContain('Hi Aloha School,');
    expect(`${msg.text}${msg.html}`).not.toMatch(/Hello/);
  });

  it('makes the link a clickable hyperlink, and keeps the plain address in the text version', async () => {
    await sendCardSetupEmail(base);
    const msg = send.mock.calls[0][0];
    expect(msg.html).toContain('<a href="https://payments.example.com/card-setup/abc123"');
    expect(msg.text).toContain('https://payments.example.com/card-setup/abc123');
  });

  it('says when the link expires, and who it is from', async () => {
    await sendCardSetupEmail(base);
    const msg = send.mock.calls[0][0];
    for (const part of [msg.text, msg.html]) {
      expect(part).toContain('December 1, 2026'); // Honolulu date
      expect(part).toContain('Hawaii Candy Factory');
    }
    expect(msg).toMatchObject({ from: 'Hawaii Candy Factory <payments@example.com>', to: 'ap@aloha.org' });
    expect(msg.subject).toContain('Hawaii Candy Factory');
  });

  it('escapes names and the link in the formatted version', async () => {
    await sendCardSetupEmail({ ...base, customerName: 'Tom & <Jerry>', organizationName: 'A "B" Co', url: 'https://x.com/card-setup/a"b' });
    const html = send.mock.calls[0][0].html;
    expect(html).toContain('Tom &amp; &lt;Jerry&gt;');
    expect(html).toContain('A &quot;B&quot; Co');
    expect(html).not.toContain('<Jerry>');
    expect(html).toContain('href="https://x.com/card-setup/a&quot;b"');
  });
});
