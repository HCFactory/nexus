import { describe, expect, it } from 'vitest';

import { createdCustomerHref, NOTE_PARAM } from './createdCustomerHref';

describe('createdCustomerHref', () => {
  it('opens the new customer profile', () => {
    expect(createdCustomerHref('c9', [])).toBe('/customers/c9');
  });

  it('carries any notes to the profile, joined, skipping blanks', () => {
    const href = createdCustomerHref('c9', ['Created F02091, but the number series could not be updated.', null, undefined, "Bill.com is turned off — this customer will be sent when it's turned on."]);
    const url = new URL(href, 'https://x');
    expect(url.pathname).toBe('/customers/c9');
    expect(url.searchParams.get(NOTE_PARAM)).toBe(
      "Created F02091, but the number series could not be updated. Bill.com is turned off — this customer will be sent when it's turned on.",
    );
  });
});
