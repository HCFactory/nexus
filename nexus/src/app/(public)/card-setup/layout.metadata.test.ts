import { describe, expect, it } from 'vitest';

import { metadata } from './layout';

describe('card setup page metadata', () => {
  it('has its own neutral title and description, never the app name, and asks not to be indexed', () => {
    const text = JSON.stringify(metadata);
    expect(text).not.toMatch(/nexus|packaging artwork/i);
    expect(metadata.title).toBe('Save your card');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
