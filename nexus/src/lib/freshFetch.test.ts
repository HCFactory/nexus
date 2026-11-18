import { describe, expect, it, vi } from 'vitest'

import { freshFetchWith } from './freshFetch'

describe('freshFetch', () => {
  it('gives every request its own abort signal, so Next.js never answers a repeated read from the first response', async () => {
    const base = vi.fn(async () => new Response('ok'))
    const f = freshFetchWith(base as unknown as typeof fetch)
    await f('https://x.test/a')
    await f('https://x.test/a', { method: 'GET', headers: { a: '1' } })
    const [, first] = base.mock.calls[0] as unknown as [string, RequestInit]
    const [, second] = base.mock.calls[1] as unknown as [string, RequestInit]
    expect(first.signal).toBeInstanceOf(AbortSignal)
    expect(second.signal).toBeInstanceOf(AbortSignal)
    expect(first.signal).not.toBe(second.signal)
    expect(first.cache).toBe('no-store')
    expect(second.headers).toEqual({ a: '1' })
  })

  it("keeps the caller's own signal", async () => {
    const base = vi.fn(async () => new Response('ok'))
    const own = new AbortController().signal
    await freshFetchWith(base as unknown as typeof fetch)('https://x.test/a', { signal: own })
    expect((base.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(own)
  })
})
