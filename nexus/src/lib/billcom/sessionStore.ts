import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { SessionStore, StoredSession } from './client';

/**
 * `session_last_used_at` only needs to be accurate to within Bill.com's
 * 35-minute idle window. Writing it on every API call would mean a database
 * write per API call, so only write when the stored value is older than this.
 */
export const SESSION_TOUCH_THROTTLE_MS = 5 * 60_000;

export function createDbSessionStore(
  supabase: SupabaseClient,
  connectionId: string,
): SessionStore {
  /**
   * session_last_used_at as this store last read or wrote it: undefined when
   * unknown, null when there is no session. touch() runs right after a request
   * whose get() just read it, so it can decide without reading again.
   */
  let known: Date | null | undefined;

  async function readRow(): Promise<StoredSession | null> {
    const { data, error } = await supabase
      .from('billcom_connections')
      .select('session_id, session_last_used_at')
      .eq('id', connectionId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to read the Bill.com session: ${error.message}`);
    }
    if (!data?.session_id || !data.session_last_used_at) {
      known = null;
      return null;
    }
    known = new Date(data.session_last_used_at as string);
    return {
      sessionId: data.session_id as string,
      lastUsedAt: known,
    };
  }

  async function write(payload: Record<string, string | null>): Promise<void> {
    const { error } = await supabase
      .from('billcom_connections')
      .update(payload)
      .eq('id', connectionId);
    if (error) {
      throw new Error(`Failed to update the Bill.com session: ${error.message}`);
    }
  }

  return {
    get: readRow,

    async set(sessionId: string) {
      const now = new Date();
      await write({
        session_id: sessionId,
        session_last_used_at: now.toISOString(),
      });
      known = now;
    },

    async touch() {
      if (known === undefined) await readRow();
      if (!known) return;
      if (Date.now() - known.getTime() < SESSION_TOUCH_THROTTLE_MS) return;
      const now = new Date();
      await write({ session_last_used_at: now.toISOString() });
      known = now;
    },

    async clear() {
      await write({ session_id: null, session_last_used_at: null });
      known = null;
    },
  };
}
