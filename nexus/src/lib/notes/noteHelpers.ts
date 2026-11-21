import 'server-only';

import { createServiceClient } from '@/lib/supabase/server';

export const NOTE_MAX_LENGTH = 4000;
export const NOTE_EMPTY = 'Write something first.';
export const NOTE_TOO_LONG = `Notes can be up to ${NOTE_MAX_LENGTH} characters.`;
export const NOTE_NOT_FOUND = 'Note not found.';

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The trimmed body, or an error message when it is empty or too long. */
export function cleanNoteBody(body: string): { body: string } | { error: string } {
  const trimmed = (body ?? '').trim();
  if (!trimmed) return { error: NOTE_EMPTY };
  if (trimmed.length > NOTE_MAX_LENGTH) return { error: NOTE_TOO_LONG };
  return { body: trimmed };
}

/** Attach each author's display name; '' when the user no longer exists. */
export async function withNoteAuthors<T extends { created_by: string | null }>(rows: T[]): Promise<(T & { author_name: string })[]> {
  const ids = [...new Set(rows.flatMap((r) => (r.created_by ? [r.created_by] : [])))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data, error } = await createServiceClient().from('users').select('id, display_name').in('id', ids);
    if (error) throw new Error(`Could not load note authors: ${error.message}`);
    for (const u of (data ?? []) as { id: string; display_name: string | null }[]) names.set(u.id, u.display_name ?? '');
  }
  return rows.map((r) => ({ ...r, author_name: (r.created_by && names.get(r.created_by)) || '' }));
}
