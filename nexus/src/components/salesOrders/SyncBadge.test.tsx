import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncBadge } from './SyncBadge';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
const confirmSpy = vi.spyOn(window, 'confirm');

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const noop = () => {};

describe('SyncBadge', () => {
  it('pending reads "Sending to BC…"', () => {
    render(<SyncBadge state="pending" error={null} onRetry={noop} onOverwrite={noop} />);
    expect(screen.getByText('Sending to BC…')).toBeInTheDocument();
  });

  it('synced reads "In BC"', () => {
    render(<SyncBadge state="synced" error={null} onRetry={noop} onOverwrite={noop} />);
    expect(screen.getByText('In BC')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('failed shows the error and a Try again button', () => {
    const onRetry = vi.fn();
    render(<SyncBadge state="failed" error="BC is down" onRetry={onRetry} onOverwrite={noop} />);
    expect(screen.getByText('Failed: BC is down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('conflict asks for confirmation in the app dialog before overwriting', () => {
    const onOverwrite = vi.fn();
    render(<SyncBadge state="conflict" error={null} onRetry={noop} onOverwrite={onOverwrite} />);
    expect(screen.getByText('Changed in BC')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Overwrite BC with Nexus's version" }));
    expect(onOverwrite).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
    expect(onOverwrite).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('cancelling the confirmation does not overwrite', () => {
    const onOverwrite = vi.fn();
    render(<SyncBadge state="conflict" error={null} onRetry={noop} onOverwrite={onOverwrite} />);
    fireEvent.click(screen.getByRole('button', { name: "Overwrite BC with Nexus's version" }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOverwrite).not.toHaveBeenCalled();
  });

  describe('a pending order that looks stuck', () => {
    const T0 = Date.parse('2026-11-13T10:00:00.000Z');
    const ago = (ms: number) => new Date(T0 - ms).toISOString();
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
    });
    afterEach(() => vi.useRealTimers());

    it('offers Try again when no live claim and the last update is older than 30s', async () => {
      const onRetry = vi.fn();
      render(<SyncBadge state="pending" error={null} claimedUntil={null} updatedAt={ago(60_000)} onRetry={onRetry} onOverwrite={noop} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('Sending to BC…')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('treats an expired claim like no claim', async () => {
      render(<SyncBadge state="pending" error={null} claimedUntil={ago(1_000)} updatedAt={ago(60_000)} onRetry={noop} onOverwrite={noop} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('waits until the update is 30s old', async () => {
      render(<SyncBadge state="pending" error={null} claimedUntil={null} updatedAt={ago(5_000)} onRetry={noop} onOverwrite={noop} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('no Try again while a claim is live', async () => {
      const until = new Date(T0 + 60_000).toISOString();
      render(<SyncBadge state="pending" error={null} claimedUntil={until} updatedAt={ago(60_000)} onRetry={noop} onOverwrite={noop} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });

    it('a far-future claim never shows Try again', async () => {
      render(<SyncBadge state="pending" error={null} claimedUntil="2999-01-01T00:00:00.000Z" updatedAt={ago(60_000)} onRetry={noop} onOverwrite={noop} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });
  });

  it('hides the action buttons when the user cannot edit', () => {
    render(<SyncBadge state="failed" error="x" canAct={false} onRetry={noop} onOverwrite={noop} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
