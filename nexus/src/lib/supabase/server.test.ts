import { describe, expect, it, vi } from 'vitest'

const { createSupabaseClient } = vi.hoisted(() => ({ createSupabaseClient: vi.fn((..._args: unknown[]) => ({})) }))
vi.mock('@supabase/supabase-js', () => ({ createClient: createSupabaseClient }))
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: vi.fn() }))

import { freshFetch } from '@/lib/freshFetch'
import { createServiceClient } from './server'

describe('createServiceClient', () => {
  it('uses fresh requests, so background work started from a page render never re-reads a stale row', () => {
    createServiceClient()
    const options = createSupabaseClient.mock.calls[0][2] as { global?: { fetch?: unknown } }
    expect(options.global?.fetch).toBe(freshFetch)
  })
})
