// fetch that always goes to the server. While Next.js renders a page it answers a
// repeated GET (same URL and headers) from the first response, and work started
// from that render (after(), a resumed invoice change) inherits it: a step that
// re-reads its record, or BC's draft lines, gets the old answer. A request with
// its own abort signal is never deduplicated, so every request gets one.

/** `base` with a fresh signal (unless the caller passed one) and no caching. */
export function freshFetchWith(base: typeof fetch): typeof fetch {
  return (input, init) => base(input, { ...init, cache: 'no-store', signal: init?.signal ?? new AbortController().signal })
}

/** The global fetch, never answered from Next.js's per-render memo. */
export const freshFetch: typeof fetch = (input, init) => freshFetchWith(fetch)(input, init)
