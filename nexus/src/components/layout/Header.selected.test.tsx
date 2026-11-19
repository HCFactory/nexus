import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The menu only renders when opened (Radix portal); check the class rule and where it's used.
const src = readFileSync(join(__dirname, 'Header.tsx'), 'utf8');

describe('org menu selected items', () => {
  it('selected org and environment are bold, black/white and not faded', () => {
    expect(src).toMatch(/const SELECTED_ITEM = 'font-bold text-black dark:text-white data-\[disabled\]:opacity-100'/);
    expect(src).toContain("isCurrent && SELECTED_ITEM");
    expect(src).toContain("isActiveEnv && SELECTED_ITEM");
  });
});
