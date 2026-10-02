import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import type { Bindings, CachedResult } from '../types'
import { cacheKey } from '../utils/cache'
import { oauthVerificationKey } from '../oauth/state'

const PUBKEY = 'ab'.repeat(32)
const CLAIM = { platform: 'github', identity: 'synthetic-user', proof: 'abc123', pubkey: PUBKEY }

function createEnv() {
  const store = new Map<string, string>()
  const kv = {
    get: vi.fn(async (key: string) => {
      if (new TextEncoder().encode(key).length > 512) throw new Error('KV key exceeds 512 bytes')
      if (/\p{Cs}/u.test(key)) throw new Error('Malformed KV key')
      return store.get(key) ?? null
    }),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
  }
  const rateLimit = { get: vi.fn(async () => null), put: vi.fn(async () => {}) }
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected platform fetch') }))
  return { env: { CACHE_KV: kv, RATE_LIMIT_KV: rateLimit } as unknown as Bindings, store, kv, rateLimit }
}

function post(path: string, body: unknown, env: Bindings) {
  return worker.fetch(new Request(`https://example.com${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), env)
}

afterEach(() => vi.unstubAllGlobals())

for (const path of ['/verify/single', '/api/verify']) {
  describe(`POST ${path}`, () => {
    it.each([
      ['null body', null],
      ['non-object body', 7],
      ['unsupported platform', { ...CLAIM, platform: 'unsupported' }],
      ['non-text Bluesky proof', { ...CLAIM, platform: 'bluesky', proof: {} }],
      ['oversized cache key', { ...CLAIM, proof: 'b'.repeat(450) }],
      ['oversized OAuth key', { ...CLAIM, platform: 'twitter', identity: 'a'.repeat(430), proof: '1' }],
      ['unpaired surrogate', { ...CLAIM, proof: 'abc\ud800' }],
    ])('rejects %s before claim side effects', async (_label, body) => {
      const { env, kv, rateLimit } = createEnv()
      const response = await post(path, body, env)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: expect.any(String) })
      expect(kv.get).not.toHaveBeenCalled()
      expect(kv.put).not.toHaveBeenCalled()
      // Only the request-level IP limit is spent.
      expect(rateLimit.put).toHaveBeenCalledTimes(1)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('preserves a valid cached result', async () => {
      const { env, store } = createEnv()
      const result: CachedResult = { verified: true, checked_at: 1_700_000_000, type: 'verified' }
      store.set(cacheKey(CLAIM.platform, CLAIM.identity, CLAIM.proof, PUBKEY), JSON.stringify(result))
      const response = await post(path, CLAIM, env)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ platform: 'github', identity: CLAIM.identity, verified: true, cached: true })
      expect(fetch).not.toHaveBeenCalled()
    })

    it.each(['', ' ', undefined, null, false, 0])('accepts a Bluesky proof of %s through OAuth', async proof => {
      const { env, store } = createEnv()
      store.set(oauthVerificationKey('bluesky', 'synthetic.bsky.social', PUBKEY), JSON.stringify({ checked_at: 1_700_000_000 }))
      const response = await post(path, { ...CLAIM, platform: 'bluesky', identity: 'synthetic.bsky.social', proof }, env)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ verified: true, method: 'oauth' })
      expect(fetch).not.toHaveBeenCalled()
    })

    it('rejects invalid JSON', async () => {
      const { env, kv } = createEnv()
      const response = await worker.fetch(new Request(`https://example.com${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
      }), env)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid JSON body' })
      expect(kv.get).not.toHaveBeenCalled()
    })
  })
}

describe('GET /verify/:platform/*', () => {
  it.each([
    ['cache-key overflow', 'github', 'synthetic-user', 'b'.repeat(450)],
    ['OAuth-key overflow', 'twitter', 'a'.repeat(430), '1'],
    ['malformed escape', 'github', 'synthetic%E0user', 'abc123'],
  ])('rejects %s before claim side effects', async (_label, platform, identity, proof) => {
    const { env, kv, rateLimit } = createEnv()
    const response = await worker.fetch(new Request(`https://example.com/verify/${platform}/${identity}/${proof}?pubkey=${PUBKEY}&format=json`), env)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: expect.any(String) })
    expect(kv.get).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
    expect(rateLimit.put).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('still decodes identities and serves valid cached claims', async () => {
    const { env, store } = createEnv()
    store.set(cacheKey('mastodon', 'social.example/@synthetic', '123', PUBKEY), JSON.stringify({ verified: true, checked_at: 1_700_000_000, type: 'verified' }))
    const response = await worker.fetch(new Request(`https://example.com/verify/mastodon/social.example%2F%40synthetic/123?pubkey=${PUBKEY}&format=json`), env)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ identity: 'social.example/@synthetic', verified: true, cached: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps HTML content negotiation for valid claims', async () => {
    const { env, store } = createEnv()
    store.set(cacheKey(CLAIM.platform, CLAIM.identity, CLAIM.proof, PUBKEY), JSON.stringify({ verified: true, checked_at: 1_700_000_000, type: 'verified' }))
    const response = await worker.fetch(new Request(`https://example.com/verify/github/${CLAIM.identity}/${CLAIM.proof}?pubkey=${PUBKEY}`, {
      headers: { Accept: 'text/html' },
    }), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(await response.text()).toContain(`${CLAIM.identity} is verified`)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses shared validation for unsupported platforms and missing pubkeys', async () => {
    const { env, kv } = createEnv()
    for (const path of [`/verify/unsupported/synthetic/123?pubkey=${PUBKEY}`, '/verify/github/synthetic/123']) {
      const response = await worker.fetch(new Request(`https://example.com${path}`), env)
      expect(response.status).toBe(400)
    }
    expect(kv.get).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('accepts proofless Bluesky claims through OAuth', async () => {
    const { env, store } = createEnv()
    store.set(oauthVerificationKey('bluesky', 'synthetic.bsky.social', PUBKEY), JSON.stringify({ checked_at: 1_700_000_000 }))
    const response = await worker.fetch(new Request(`https://example.com/verify/bluesky/synthetic.bsky.social/?pubkey=${PUBKEY}&format=json`), env)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ verified: true, method: 'oauth' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
