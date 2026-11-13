/**
 * Read every row of a Supabase query, page by page, past the 1,000-row cap.
 * The query must have a stable, unique order (end with a unique column such
 * as `id`) or rows can repeat or go missing between pages.
 */
export async function fetchAll<T>(
  build: () => { range: (a: number, b: number) => PromiseLike<{ data: unknown; error: unknown }> },
  pageSize = 1000,
  what = 'customers',
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw new Error(`Could not read ${what}: ${(error as { message?: string }).message ?? error}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}
