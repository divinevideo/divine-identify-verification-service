import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import { hexToNpub } from '../utils/npub'

const PUBKEY = '9'.repeat(64)
const VIDEO_ID = '7123456789012345678'

function createMockKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string, type?: string) => {
      const value = store.get(key) ?? null
      return value !== null && type === 'json' ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
  } as unknown as KVNamespace
}

describe('POST /verify/single reports the proof to publish', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the TikTok post number for a share link, fresh and from the cache', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    const npub = hexToNpub(PUBKEY)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://vm.tiktok.com/')) {
        return new Response(null, { status: 301, headers: { Location: `https://www.tiktok.com/@testuser/video/${VIDEO_ID}` } })
      }
      return new Response(JSON.stringify({ author_unique_id: 'testuser', title: `key ${npub}` }), { status: 200 })
    }))
    const request = () => worker.fetch(new Request('https://verifier.divine.video/verify/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'tiktok', identity: 'testuser', proof: 'https://vm.tiktok.com/ZMabc123/', pubkey: PUBKEY }),
    }), env as never)

    const fresh = await (await request()).json() as Record<string, unknown>
    expect(fresh).toMatchObject({ verified: true, cached: false, canonical_proof: VIDEO_ID })
    const again = await (await request()).json() as Record<string, unknown>
    expect(again).toMatchObject({ verified: true, cached: true, canonical_proof: VIDEO_ID })
  })

  it('leaves canonical_proof out when the proof already is the post number', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    const npub = hexToNpub(PUBKEY)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ author_unique_id: 'testuser', title: `key ${npub}` }), { status: 200 })))
    const res = await worker.fetch(new Request('https://verifier.divine.video/verify/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'tiktok', identity: 'testuser', proof: VIDEO_ID, pubkey: PUBKEY }),
    }), env as never)
    const body = await res.json() as Record<string, unknown>
    expect(body.verified).toBe(true)
    expect(body).not.toHaveProperty('canonical_proof')
  })
})
