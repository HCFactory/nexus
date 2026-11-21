import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ColumnResizeHandle, useColumnWidths, MIN_COLUMN_WIDTH, forgetColumnWidthsForTests } from './ResizableColumns';

const DEFAULTS = { a: 100, b: 200 };

function Table({ storageKey = 'test-cols' }: { storageKey?: string }) {
  const { widths, setWidth, reset } = useColumnWidths(storageKey, DEFAULTS);
  return (
    <table style={{ tableLayout: 'fixed' }}>
      <colgroup>
        <col data-testid="col-a" style={{ width: widths.a }} />
        <col data-testid="col-b" style={{ width: widths.b }} />
      </colgroup>
      <thead>
        <tr>
          <th>A<ColumnResizeHandle label="A" width={widths.a} onResize={(w) => setWidth('a', w)} onReset={() => reset('a')} /></th>
          <th>B<ColumnResizeHandle label="B" width={widths.b} onResize={(w) => setWidth('b', w)} onReset={() => reset('b')} /></th>
        </tr>
      </thead>
    </table>
  );
}

const handle = (name: string) => screen.getByRole('separator', { name: `Resize ${name} column` });
const width = (id: string) => (screen.getByTestId(id) as HTMLElement).style.width;

beforeEach(() => { window.localStorage.clear(); forgetColumnWidthsForTests(); });
afterEach(cleanup);

describe('resizable columns', () => {
  it('dragging a column edge in the header changes that column only', () => {
    render(<Table />);
    fireEvent.pointerDown(handle('A'), { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle('A'), { clientX: 160, pointerId: 1 });
    fireEvent.pointerUp(handle('A'), { clientX: 160, pointerId: 1 });
    expect(width('col-a')).toBe('160px');
    expect(width('col-b')).toBe('200px');
    // Moving after letting go does nothing.
    fireEvent.pointerMove(handle('A'), { clientX: 300, pointerId: 1 });
    expect(width('col-a')).toBe('160px');
  });

  it('a column never gets narrower than the minimum', () => {
    render(<Table />);
    fireEvent.pointerDown(handle('B'), { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle('B'), { clientX: 0, pointerId: 1 });
    expect(width('col-b')).toBe(`${MIN_COLUMN_WIDTH}px`);
  });

  it('arrow keys resize too, and double-click puts the column back', () => {
    render(<Table />);
    fireEvent.keyDown(handle('A'), { key: 'ArrowRight' });
    expect(width('col-a')).toBe('116px');
    fireEvent.keyDown(handle('A'), { key: 'ArrowLeft' });
    fireEvent.keyDown(handle('A'), { key: 'ArrowLeft' });
    expect(width('col-a')).toBe('84px');
    fireEvent.doubleClick(handle('A'));
    expect(width('col-a')).toBe('100px');
  });

  it('widths are remembered in this browser', () => {
    const { unmount } = render(<Table />);
    fireEvent.keyDown(handle('B'), { key: 'ArrowRight' });
    unmount();
    forgetColumnWidthsForTests(); // as on a fresh page load
    render(<Table />);
    expect(width('col-b')).toBe('216px');
    expect(width('col-a')).toBe('100px');
  });

  it('bad or missing saved widths fall back to the defaults', () => {
    window.localStorage.setItem('test-cols', '{"a":"wide","b":-5,"zzz":300}');
    render(<Table />);
    expect(width('col-a')).toBe('100px');
    expect(width('col-b')).toBe('200px');
  });
});
