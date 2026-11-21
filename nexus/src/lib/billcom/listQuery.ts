/**
 * Query string for a Bill.com v3 list request. The first page carries the
 * filters, sort and max; later pages carry only the `page` token (and max):
 * Bill.com refuses sort and filters together with page ("sort and filters
 * parameters are not allowed when page is provided").
 */
export function billcomListQuery(params: Record<string, string | undefined>, page?: string): string {
  if (page) {
    const qs = new URLSearchParams({ page });
    if (params.max) qs.set('max', params.max);
    return qs.toString();
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  return qs.toString();
}
