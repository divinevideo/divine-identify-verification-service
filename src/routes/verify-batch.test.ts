import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Bindings, CachedResult } from '../types'
import verify from './verify'
import { cacheKey } from '../utils/cache'

const app = new Hono<{ Bindings: Bindings }>()
app.route('/verify', verify)

const PUBKEY = 'ab'.repeat(32)

// Workers KV rejects keys over 512 bytes (developers.cloudflare.com/kv/platform/limits),
// and local Workers KV (wrangler dev) also rejects keys containing an unpaired UTF-16
// surrogate ("Could not URL-decode key name"; not verified against production KV).
// The stand-in does the same, so such keys can't pass here and fail for real.
function assertStorableKey(key: string) {
  if (new TextEncoder().encode(key).length > 512) throw new Error('KV key exceeds 512 bytes')
  if (/\p{Cs}/u.test(key)) throw new Error('Could not URL-decode key name')
}

function createMockKV() {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => { assertStorableKey(key); return store.get(key) ?? null },
    put: async (key: string, value: string) => { assertStorableKey(key); store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
  } as unknown as KVNamespace
  return { kv, store }
}

function createEnv() {
  const cache = createMockKV()
  const rateLimit = createMockKV()
  const env: Bindings = { CACHE_KV: cache.kv, RATE_LIMIT_KV: rateLimit.kv }
  return { env, cacheStore: cache.store, rateLimitStore: rateLimit.store }
}

// A previously verified claim, served from cache so the test needs no network.
async function seedVerified(env: Bindings, platform: string, identity: string, proof: string) {
  const cached: CachedResult = { verified: true, checked_at: 1_700_000_000, type: 'verified' }
  await env.CACHE_KV.put(cacheKey(platform, identity, proof, PUBKEY), JSON.stringify(cached))
}

function forbidFetch() {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no platform fetch expected in this test') }))
}

async function postBatch(env: Bindings, body: unknown) {
  return app.request('/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
}

type BatchResponse = {
  results: Array<{ platform: string; identity: string; verified: boolean; error?: string; checked_at: number; cached: boolean }>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /verify: one bad claim no longer fails the whole batch', () => {
  it('returns the valid claim\'s result alongside a per-claim failure for an unsupported platform', async () => {
    const { env } = createEnv()
    await seedVerified(env, 'github', 'octocat', 'abc123')
    forbidFetch()

    const res = await postBatch(env, {
      claims: [
        { platform: 'github', identity: 'octocat', proof: 'abc123', pubkey: PUBKEY },
        { platform: 'myspace', identity: 'tom', proof: '1', pubkey: PUBKEY },
      ],
    })

    expect(res.status).toBe(200)
    const { results } = await res.json() as BatchResponse
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ platform: 'github', identity: 'octocat', verified: true, cached: true })
    expect(results[1]).toMatchObject({ platform: 'myspace', identity: 'tom', verified: false, cached: false })
    expect(results[1].error).toMatch(/platform/i)
    expect(Number.isInteger(results[1].checked_at)).toBe(true)
  })

  it('keeps results in input order when the invalid claim comes first', async () => {
    const { env } = createEnv()
    await seedVerified(env, 'github', 'octocat', 'abc123')
    forbidFetch()

    const res = await postBatch(env, {
      claims: [
        { platform: 'github', identity: 'octocat', proof: 'abc123', pubkey: 'not-hex' },
        { platform: 'github', identity: 'octocat', proof: 'abc123', pubkey: PUBKEY },
      ],
    })

    expect(res.status).toBe(200)
    const { results } = await res.json() as BatchResponse
    expect(results.map(r => r.verified)).toEqual([false, true])
    expect(results[0].error).toMatch(/pubkey/i)
  })

  it('reports claims that are not objects as per-claim failures without losing the valid claim beside them', async () => {
    const { env } = createEnv()
    await seedVerified(env, 'github', 'octocat', 'abc123')
    forbidFetch()

    const res = await postBatch(env, {
      claims: [null, 'github:octocat', 7, { platform: 'github', identity: 'octocat', proof: 'abc123', pubkey: PUBKEY }],
    })

    expect(res.status).toBe(200)
    const { results } = await res.json() as BatchResponse
    expect(results).toHaveLength(4)
    expect(results[3]).toMatchObject({ platform: 'github', identity: 'octocat', verified: true })
    for (const r of results.slice(0, 3)) {
      // Clients parse platform and identity as strings, so they must always be present.
      expect(r).toMatchObject({ platform: '', identity: '', verified: false, cached: false })
      expect(r.error).toMatch(/claim/i)
    }
  })

  it('rejects a Bluesky claim with a non-text proof without losing the valid claim beside it', async () => {
    const { env } = createEnv()
    await seedVerified(env, 'github', 'octocat', 'abc123')
    forbidFetch()

    for (const proof of [5, ['x'], {}]) {
      const res = await postBatch(env, {
        claims: [
          { platform: 'bluesky', identity: 'alice.bsky.social', proof, pubkey: PUBKEY },
          { platform: 'github', identity: 'octocat', proof: 'abc123', pubkey: PUBKEY },
        ],
      })
      expect(res.status).toBe(200)
      const { results } = await res.json() as BatchResponse
      expect(results.map(r => r.verified)).toEqual([false, true])
      expect(results[0].error).toMatch(/proof/i)
    }
  })

  it('rejects claims too long to store without losing the valid claim beside them', async () => {
    const { env } = createEnv()
    await seedVerified(env, 'github', 'octocat', 'abc123')
    forbidFetch()

    const longClaims = [
      // Short handle, long proof: only the cache key overflows.
      { platform: 'github', identity: 'octocat', proof: 'b'.repeat(450), pubkey: PUBKEY },
      // Fits the cache key but not the sign-in record key.
      { platform: 'twitter', identity: 'a'.repeat(430), proof: '1', pubkey: PUBKEY },
      // Bluesky skips the proof-length rule for a whitespace-only proof; its raw value still lands in the key.
      { platform: 'bluesky', identity: 'alice.bsky.social', proof: ' '.repeat(600), pubkey: PUBKEY },
      // 200 emoji: 400 UTF-16 units but 800 bytes.
      { platform: 'twitter', identity: '\u{1F600}'.repeat(200), proof: '1', pubkey: PUBKEY },
    ]
    for (const longClaim of longClaims) {
      const res = await postBatch(env, {
        claims: [longClaim, { platform: 'github', identity: 'octocat', proof: 'abc123', pubkey: PUBKEY }],
      })
      expect(res.status).toBe(200)
      const { results } = await res.json() as BatchResponse
      expect(results.map(r => r.verified)).toEqual([false, true])
      expect(results[0].error).toMatch(/too long/i)
    }
  })

  it('accepts a claim whose storage key is exactly 512 bytes', async () => {
    const { env } = createEnv()
    // "v|github|" + 10 + "|" + 427 + "|" + 64-char pubkey = 512 bytes.
    const identity = 'a'.repeat(10)
    const proof = 'b'.repeat(427)
    await seedVerified(env, 'github', identity, proof)
    forbidFetch()

    const res = await postBatch(env, { claims: [{ platform: 'github', identity, proof, pubkey: PUBKEY }] })

    expect(res.status).toBe(200)
    const { results } = await res.json() as BatchResponse
    expect(results[0]).toMatchObject({ verified: true })
  })

  it('rejects a claim whose storage key would be 513 bytes', async () => {
    const { env } = createEnv()
    forbidFetch()
    // One byte over the exactly-512 case above.
    const res = await postBatch(env, { claims: [{ platform: 'github', identity: 'a'.repeat(10), proof: 'b'.repeat(428), pubkey: PUBKEY }] })
    expect(res.status).toBe(200)
    const { results } = await res.json() as BatchResponse
    expect(results[0]).toMatchObject({ verified: false })
    expect(results[0].error).toMatch(/too long/i)
  })

  it('rejects claims with malformed text (an unpaired surrogate) without losing the valid claim beside them', async () => {
    const { env } = createEnv()
    await seedVerified(env, 'github', 'octocat', 'abc123')
    forbidFetch()

    const badClaims = [
      { platform: 'twitter', identity: 'jack\ud800', proof: '1', pubkey: PUBKEY },
      { platform: 'github', identity: 'octocat', proof: 'abc\udc00', pubkey: PUBKEY },
      { platform: 'bluesky', identity: 'alice\udfff.bsky.social', proof: '', pubkey: PUBKEY },
    ]
    for (const bad of badClaims) {
      const res = await postBatch(env, {
        claims: [bad, { platform: 'github', identity: 'octocat', proof: 'abc123', pubkey: PUBKEY }],
      })
      expect(res.status).toBe(200)
      const { results } = await res.json() as BatchResponse
      expect(results.map(r => r.verified)).toEqual([false, true])
      expect(results[0].error).toMatch(/malformed/i)
    }
  })

  it('does not spend per-pubkey or per-platform rate limits on invalid claims', async () => {
    const { env, rateLimitStore } = createEnv()
    forbidFetch()

    const res = await postBatch(env, { claims: [{ platform: 'myspace', identity: 'tom', proof: '1', pubkey: PUBKEY }] })

    expect(res.status).toBe(200)
    const { results } = await res.json() as BatchResponse
    expect(results).toEqual([expect.objectContaining({ platform: 'myspace', verified: false })])
    const keys = [...rateLimitStore.keys()]
    expect(keys.some(k => k.startsWith('rl:pk:') || k.startsWith('rl:plat:'))).toBe(false)
  })
})

describe('POST /verify: malformed request bodies are still rejected outright', () => {
  for (const [label, body] of [
    ['a null body', null],
    ['missing claims', {}],
    ['claims not an array', { claims: 'nope' }],
    ['empty claims', { claims: [] }],
    ['more than 10 claims', { claims: Array.from({ length: 11 }, () => ({ platform: 'github', identity: 'a', proof: 'b', pubkey: PUBKEY })) }],
  ] as const) {
    it(`returns 400 for ${label}`, async () => {
      const { env } = createEnv()
      forbidFetch()
      const res = await postBatch(env, body)
      expect(res.status).toBe(400)
    })
  }
})
