import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import { hexToNpub } from '../utils/npub'

const PUBKEY = '9'.repeat(64)
const ID = '109876543210'

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

function splitServer(npub: string) {
  const jrd = () => new Response(JSON.stringify({
    subject: 'acct:alice@example.com',
    links: [{ rel: 'self', type: 'application/activity+json', href: 'https://social.example.com/users/alice' }],
  }), { status: 200 })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('https://example.com/.well-known/webfinger') || url.startsWith('https://social.example.com/.well-known/webfinger')) return jrd()
    if (url.startsWith('https://social.example.com/api/v1/statuses/')) {
      return new Response(JSON.stringify({ account: { acct: 'alice' }, content: `<p>${npub}</p>` }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }))
}

describe('the account confirmed on a server\'s web domain', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is reported by /verify/single, fresh and from the cache', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    splitServer(hexToNpub(PUBKEY))
    const request = () => worker.fetch(new Request('https://verifier.divine.video/verify/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'mastodon', identity: 'example.com/@alice', proof: ID, pubkey: PUBKEY }),
    }), env as never)

    const fresh = await (await request()).json() as Record<string, unknown>
    expect(fresh).toMatchObject({ identity: 'example.com/@alice', verified: true, cached: false, canonical_identity: 'social.example.com/@alice' })
    const again = await (await request()).json() as Record<string, unknown>
    expect(again).toMatchObject({ identity: 'example.com/@alice', verified: true, cached: true, canonical_identity: 'social.example.com/@alice' })
  })

  it('is reported by the batch check', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    splitServer(hexToNpub(PUBKEY))
    const res = await worker.fetch(new Request('https://verifier.divine.video/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claims: [{ platform: 'mastodon', identity: 'example.com/@alice', proof: ID, pubkey: PUBKEY }] }),
    }), env as never)
    const body = await res.json() as { results: Array<Record<string, unknown>> }
    expect(body.results[0]).toMatchObject({ identity: 'example.com/@alice', verified: true, canonical_identity: 'social.example.com/@alice' })
  })

  it('is left out for an account on an ordinary server', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    const npub = hexToNpub(PUBKEY)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ account: { acct: 'alice' }, content: `<p>${npub}</p>` }), { status: 200 })))
    const res = await worker.fetch(new Request('https://verifier.divine.video/verify/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'mastodon', identity: 'mastodon.social/@alice', proof: ID, pubkey: PUBKEY }),
    }), env as never)
    const body = await res.json() as Record<string, unknown>
    expect(body.verified).toBe(true)
    expect(body).not.toHaveProperty('canonical_identity')
  })
})
