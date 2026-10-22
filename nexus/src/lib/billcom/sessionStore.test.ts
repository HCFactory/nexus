import { describe, expect, it, vi } from 'vitest';

import { createDbSessionStore } from './sessionStore';

interface StubRow {
  session_id: string | null;
  session_last_used_at: string | null;
}

/** Minimal stub of the Supabase query chain used by the store. */
function stubSupabase(row: StubRow | null) {
  const updateEq = vi.fn(async () => ({ error: null }));
  const update = vi.fn(() => ({ eq: updateEq }));
  const selectEq = vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: row, error: null })) }));
  const supabase = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: selectEq,
      })),
      update,
    })),
  };
  return { supabase, update, updateEq, selectEq };
}

describe('Bill.com DB session store', () => {
  it('returns null when the row holds no session', async () => {
    const { supabase } = stubSupabase({ session_id: null, session_last_used_at: null });
    const store = createDbSessionStore(supabase as never, 'conn-1');

    expect(await store.get()).toBeNull();
  });

  it('returns the stored session with lastUsedAt parsed as a Date', async () => {
    const when = '2026-09-04T10:00:00.000Z';
    const { supabase, selectEq } = stubSupabase({
      session_id: 'session-1',
      session_last_used_at: when,
    });
    const store = createDbSessionStore(supabase as never, 'conn-1');

    const stored = await store.get();

    expect(stored?.sessionId).toBe('session-1');
    expect(stored?.lastUsedAt.toISOString()).toBe(when);
    expect(selectEq).toHaveBeenCalledWith('id', 'conn-1');
  });

  it('writes the session id and a fresh timestamp on set', async () => {
    const { supabase, update, updateEq } = stubSupabase(null);
    const store = createDbSessionStore(supabase as never, 'conn-1');

    await store.set('session-2');

    const payload = (update.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
    expect(payload.session_id).toBe('session-2');
    expect(typeof payload.session_last_used_at).toBe('string');
    expect(updateEq).toHaveBeenCalledWith('id', 'conn-1');
  });

  it('does not write on touch inside the throttle window', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const { supabase, update } = stubSupabase({
      session_id: 'session-1',
      session_last_used_at: recent,
    });
    const store = createDbSessionStore(supabase as never, 'conn-1');

    await store.touch();

    expect(update).not.toHaveBeenCalled();
  });

  it('writes on touch once the throttle window has passed', async () => {
    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    const { supabase, update } = stubSupabase({
      session_id: 'session-1',
      session_last_used_at: stale,
    });
    const store = createDbSessionStore(supabase as never, 'conn-1');

    await store.touch();

    expect(update).toHaveBeenCalledTimes(1);
  });

  it('nulls both session columns on clear', async () => {
    const { supabase, update, updateEq } = stubSupabase({
      session_id: 'session-1',
      session_last_used_at: new Date().toISOString(),
    });
    const store = createDbSessionStore(supabase as never, 'conn-1');

    await store.clear();

    expect((update.mock.calls as unknown[][])[0][0]).toEqual({
      session_id: null,
      session_last_used_at: null,
    });
    expect(updateEq).toHaveBeenCalledWith('id', 'conn-1');
  });
});
