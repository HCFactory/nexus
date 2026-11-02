import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillcomPushPanel, type BillcomPushPanelHandle } from './BillcomPushPanel';

const actions = vi.hoisted(() => ({
  previewInitialPush: vi.fn(),
  confirmInitialPush: vi.fn(),
  runPendingPush: vi.fn(),
}));
vi.mock('@/app/actions/billcomCustomers', () => actions);
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const result = (over: Record<string, unknown> = {}) => ({
  created: 0, updated: 0, linked: 0, unchanged: 0, failed: 0, needsAttention: 0, remaining: 0, ...over,
});
const preview = {
  link: 5, create: 3, update: 2, deactivate: 1,
  needsAttention: [{ number: 'C9', reason: 'Two Bill.com customers share this account number' }],
  sample: [{ number: 'C1', changes: { name: ['Old Co', 'New Co'] } }],
};

const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const flushAll = async () => { for (let i = 0; i < 10; i++) await flush(); };

beforeEach(() => vi.resetAllMocks());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('BillcomPushPanel', () => {
  it('shows the preview and writes nothing until Confirm', async () => {
    actions.previewInitialPush.mockResolvedValue({ ok: true, preview });
    render(<BillcomPushPanel pendingCount={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Push to Bill.com' }));
    await flushAll();
    expect(screen.getByText(/5 will be linked/)).toBeInTheDocument();
    expect(screen.getByText(/3 will be created/)).toBeInTheDocument();
    expect(screen.getByText(/2 will be updated/)).toBeInTheDocument();
    expect(screen.getByText(/1 will be made inactive/)).toBeInTheDocument();
    expect(screen.getByText(/1 need attention/)).toBeInTheDocument();
    expect(screen.getByText(/Two Bill.com customers share this account number/)).toBeInTheDocument();
    expect(screen.getByText('name: Old Co → New Co')).toBeInTheDocument();
    expect(actions.confirmInitialPush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/will be linked/)).toBeNull();
    expect(actions.confirmInitialPush).not.toHaveBeenCalled();
  });

  it('keeps Confirm above a scrollable details box so it stays reachable', async () => {
    actions.previewInitialPush.mockResolvedValue({ ok: true, preview });
    render(<BillcomPushPanel pendingCount={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Push to Bill.com' }));
    await flushAll();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    const sample = screen.getByText('name: Old Co → New Co');
    expect(confirm.compareDocumentPosition(sample) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const box = screen.getByTestId('preview-details');
    expect(box).toContainElement(sample);
    expect(box.className).toMatch(/overflow-y-auto/);
    expect(box.className).toMatch(/max-h-/);
  });

  it('Confirm sends, then keeps sending while customers remain, showing progress', async () => {
    actions.previewInitialPush.mockResolvedValue({ ok: true, preview });
    actions.confirmInitialPush.mockResolvedValue({ ok: true, result: result({ created: 340, remaining: 1632 }) });
    let finish: (v: unknown) => void = () => undefined;
    actions.runPendingPush
      .mockReturnValueOnce(new Promise((r) => { finish = r; }))
      .mockResolvedValueOnce({ ok: true, result: result({ updated: 632, remaining: 0 }) });
    render(<BillcomPushPanel pendingCount={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Push to Bill.com' }));
    await flushAll();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await flushAll();
    expect(screen.getByText('Sent 340 of 1,972…')).toBeInTheDocument();
    expect(screen.getByTestId('push-running')).toHaveClass('text-warning');
    finish({ ok: true, result: result({ updated: 1000, remaining: 632 }) });
    await flushAll();
    expect(actions.runPendingPush).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/All 1,972 customers sent to Bill.com/)).toBeInTheDocument();
  });

  it('waits 60 seconds after a rate limit, then continues', async () => {
    vi.useFakeTimers();
    actions.runPendingPush
      .mockResolvedValueOnce({ ok: true, result: result({ created: 10, remaining: 5, stoppedReason: 'rate_limit' }) })
      .mockResolvedValueOnce({ ok: true, result: result({ created: 5, remaining: 0 }) });
    render(<BillcomPushPanel pendingCount={15} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send 15 waiting customers' }));
    await flushAll();
    expect(screen.getByText(/Bill.com asked us to slow down/)).toBeInTheDocument();
    expect(actions.runPendingPush).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(59_000); });
    expect(actions.runPendingPush).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    await flushAll();
    expect(actions.runPendingPush).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/All 15 customers sent to Bill.com/)).toBeInTheDocument();
  });

  it('stops on list_failed and offers Try again', async () => {
    actions.runPendingPush
      .mockResolvedValueOnce({ ok: true, result: result({ remaining: 4, stoppedReason: 'list_failed', error: 'Session expired' }) })
      .mockResolvedValueOnce({ ok: true, result: result({ created: 4, remaining: 0 }) });
    render(<BillcomPushPanel pendingCount={4} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send 4 waiting customers' }));
    await flushAll();
    expect(screen.getByRole('alert')).toHaveTextContent('Session expired');
    expect(actions.runPendingPush).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flushAll();
    expect(actions.runPendingPush).toHaveBeenCalledTimes(2);
  });

  it('shows the action error when a run is refused', async () => {
    actions.runPendingPush.mockResolvedValue({ ok: false, error: 'Bill.com is turned off.' });
    render(<BillcomPushPanel pendingCount={2} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send 2 waiting customers' }));
    await flushAll();
    expect(screen.getByRole('alert')).toHaveTextContent('Bill.com is turned off.');
  });

  it('hides Send waiting when nothing is pending', () => {
    render(<BillcomPushPanel pendingCount={0} />);
    expect(screen.queryByRole('button', { name: /waiting customers/ })).toBeNull();
  });

  it('startPending() via ref starts a run (used after a customer Sync)', async () => {
    actions.runPendingPush.mockResolvedValue({ ok: true, result: result({ created: 1, remaining: 0 }) });
    const ref = createRef<BillcomPushPanelHandle>();
    render(<BillcomPushPanel ref={ref} pendingCount={0} />);
    await act(async () => { ref.current?.startPending(); });
    await flushAll();
    expect(actions.runPendingPush).toHaveBeenCalledTimes(1);
  });

  it('stops when two batches in a row make no progress', async () => {
    actions.runPendingPush.mockResolvedValue({ ok: true, result: result({ remaining: 5, stoppedReason: 'budget' }) });
    render(<BillcomPushPanel pendingCount={5} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send 5 waiting customers' }));
    await flushAll();
    expect(actions.runPendingPush).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Sending stalled — Bill.com didn't accept any customers. Try again in a few minutes.",
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('Try again repeats the step that failed (confirm)', async () => {
    actions.previewInitialPush.mockResolvedValue({ ok: true, preview });
    actions.confirmInitialPush
      .mockResolvedValueOnce({ ok: false, error: 'Network down' })
      .mockResolvedValueOnce({ ok: true, result: result({ created: 1 }) });
    render(<BillcomPushPanel pendingCount={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Push to Bill.com' }));
    await flushAll();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await flushAll();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flushAll();
    expect(actions.confirmInitialPush).toHaveBeenCalledTimes(2);
    expect(actions.runPendingPush).not.toHaveBeenCalled();
  });

  it('startPending() does not overwrite an open preview or a loading preview', async () => {
    let finishPreview: (v: unknown) => void = () => undefined;
    actions.previewInitialPush.mockReturnValue(new Promise((r) => { finishPreview = r; }));
    const ref = createRef<BillcomPushPanelHandle>();
    render(<BillcomPushPanel ref={ref} pendingCount={3} />);
    fireEvent.click(screen.getByRole('button', { name: 'Push to Bill.com' }));
    await act(async () => { ref.current?.startPending(); });
    finishPreview({ ok: true, preview });
    await flushAll();
    await act(async () => { ref.current?.startPending(); });
    await flushAll();
    expect(actions.runPendingPush).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('makes no further calls after unmount mid-run', async () => {
    let finish: (v: unknown) => void = () => undefined;
    actions.runPendingPush.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    const { unmount } = render(<BillcomPushPanel pendingCount={9} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send 9 waiting customers' }));
    unmount();
    finish({ ok: true, result: result({ created: 1, remaining: 8 }) });
    await flushAll();
    expect(actions.runPendingPush).toHaveBeenCalledTimes(1);
  });

  it('clears the rate-limit timer on unmount', async () => {
    vi.useFakeTimers();
    actions.runPendingPush.mockResolvedValue({ ok: true, result: result({ created: 1, remaining: 5, stoppedReason: 'rate_limit' }) });
    const { unmount } = render(<BillcomPushPanel pendingCount={6} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send 6 waiting customers' }));
    await flushAll();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(actions.runPendingPush).toHaveBeenCalledTimes(1);
  });

  it('a double-click on Send waiting starts one run', async () => {
    actions.runPendingPush.mockReturnValue(new Promise(() => undefined));
    render(<BillcomPushPanel pendingCount={2} />);
    const button = screen.getByRole('button', { name: 'Send 2 waiting customers' });
    fireEvent.click(button);
    fireEvent.click(button);
    await flushAll();
    expect(actions.runPendingPush).toHaveBeenCalledTimes(1);
  });
});
