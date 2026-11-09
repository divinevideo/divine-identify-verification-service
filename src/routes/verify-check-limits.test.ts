// ABOUTME: Every platform check a request makes counts against the per-pubkey and
// ABOUTME: per-platform limits, and answers that need no check never read them.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Bindings, CachedResult } from '../types'
import verify from './verify'
import { cacheKey } from '../utils/cache'
import { oauthVerificationKey } from '../oauth/state'

const app = new Hono<{ Bindings: Bindings }>()
app.route('/verify', verify)

const PUBKEY = 'ab'.repeat(32)
const OTHER_PUBKEY = 'cd'.repeat(32)
// 30 s into a minute, so a test never straddles two counting windows.
const NOW_MS = 1_800_000_030_000
const DAY = 24 * 60 * 60

function createMockKV() {
  const store = new Map<string, string>()
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
  }
  return { kv, store }
}

function createEnv() {
  const cache = createMockKV()
  const rateLimit = createMockKV()
  const env: Bindings = {
    CACHE_KV: cache.kv as unknown as KVNamespace,
    RATE_LIMIT_KV: rateLimit.kv as unknown as KVNamespace,
    SIGNIN_CONFIRMATION: 'required',
  }
  return { env, cacheStore: cache.store, rateLimitStore: rateLimit.store, rateLimitKV: rateLimit.kv }
}

function counterKey(prefix: string, id: string): string {
  return `${prefix}:${id}:${Math.floor(Date.now() / 60_000)}`
}

const githubClaim = (proof: string, pubkey = PUBKEY) => ({ platform: 'github', identity: 'octocat', proof, pubkey })
// Distinct and never a substring of one another, so a fetch URL names one claim.
const proofs = (n: number) => Array.from({ length: n }, (_, i) => `proof${i}x`)

let fetchedUrls: string[]
const checked = (proof: string) => fetchedUrls.some(url => url.includes(proof))

async function postBatch(env: Bindings, body: unknown, address?: string) {
  return app.request('/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(address ? { 'cf-connecting-ip': address } : {}) },
    body: JSON.stringify(body),
  }, env)
}

type Result = { platform: string; identity: string; verified: boolean; error?: string; code?: string; cached: boolean }

async function results(res: Response): Promise<Result[]> {
  return (await res.json() as { results: Result[] }).results
}

// Log lines may name a counter's kind, never a pubkey or a counter key.
function expectLogsCarryNoIdentifiers() {
  const logged = [console.warn, console.error]
    .flatMap(spy => vi.mocked(spy).mock.calls)
    .map(args => args.map(arg => (arg instanceof Error ? `${arg.message} ${arg.stack}` : JSON.stringify(arg))).join(' '))
  for (const line of logged) {
    expect(line).not.toContain(PUBKEY)
    expect(line).not.toContain(OTHER_PUBKEY)
    expect(line).not.toMatch(/rl:(pk|plat|ipchk):/)
    expect(line).not.toContain('203.0.113.9')
  }
}

const PUBKEY_REFUSAL = { verified: false, error: 'Rate limit exceeded for this pubkey', code: 'temporarily_unavailable', cached: false }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_MS)
  fetchedUrls = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    fetchedUrls.push(String(input))
    return new Response('', { status: 404 })
  }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('POST /verify counts every platform check against the limits', () => {
  it('POST /verify checks only as many claims as the pubkey limit has left', async () => {
    const { env, rateLimitStore } = createEnv()
    rateLimitStore.set(counterKey('rl:pk', PUBKEY), '15')
    const ids = proofs(10)

    const res = await postBatch(env, { claims: ids.map(id => githubClaim(id)) })

    expect(res.status).toBe(200)
    const out = await results(res)
    expect(ids.slice(0, 5).map(checked)).toEqual([true, true, true, true, true])
    expect(ids.slice(5).map(checked)).toEqual([false, false, false, false, false])
    for (const result of out.slice(5)) expect(result).toMatchObject(PUBKEY_REFUSAL)
    expect(rateLimitStore.get(counterKey('rl:pk', PUBKEY))).toBe('20')
  })

  it('POST /verify checks only as many claims as the platform limit has left', async () => {
    const { env, rateLimitStore } = createEnv()
    rateLimitStore.set(counterKey('rl:plat', 'github'), '28')
    const ids = proofs(3)

    const res = await postBatch(env, { claims: ids.map(id => githubClaim(id)) })

    expect(res.status).toBe(200)
    const out = await results(res)
    expect(out[2]).toMatchObject({ verified: false, error: 'Rate limit exceeded for github', code: 'temporarily_unavailable', cached: false })
    expect(checked(ids[2])).toBe(false)
    expect(checked(ids[0]) && checked(ids[1])).toBe(true)
  })

  it('answers cached and sign-in claims without reading the limits', async () => {
    const { env, rateLimitKV } = createEnv()
    const cachedEntry: CachedResult = { verified: true, checked_at: 1_700_000_000, type: 'verified' }
    await env.CACHE_KV.put(cacheKey('github', 'octocat', 'proofcachedx', PUBKEY), JSON.stringify(cachedEntry))
    await env.CACHE_KV.put(oauthVerificationKey('twitter', 'alice', PUBKEY), JSON.stringify({
      platform: 'twitter', identity: 'alice', pubkey: PUBKEY, verified: true, method: 'oauth',
      checked_at: Math.floor(NOW_MS / 1000) - DAY, account_id: 'acct-1', confirmed: true,
    }))

    const res = await postBatch(env, {
      claims: [githubClaim('proofcachedx'), { platform: 'twitter', identity: 'alice', proof: 'oauth', pubkey: PUBKEY }],
    })

    expect(res.status).toBe(200)
    const out = await results(res)
    expect(out[0]).toMatchObject({ verified: true, cached: true })
    expect(out[1]).toMatchObject({ verified: true, cached: true })
    const limitReads = rateLimitKV.get.mock.calls.map(([key]) => key).filter(key => key.startsWith('rl:pk') || key.startsWith('rl:plat') || key.startsWith('rl:ipchk'))
    expect(limitReads).toEqual([])
    expect(fetchedUrls).toEqual([])
  })

  it('does not hold a sibling check behind a slow sign-in account lookup', async () => {
    const { env } = createEnv()
    const HANDLE = 'alice.bsky.social'
    const DID = 'did:plc:alice111111111111111111'
    for (const identity of [HANDLE, DID]) {
      await env.CACHE_KV.put(oauthVerificationKey('bluesky', identity, PUBKEY), JSON.stringify({
        platform: 'bluesky', identity, pubkey: PUBKEY, verified: true, method: 'oauth',
        checked_at: Math.floor(NOW_MS / 1000) - DAY, account_id: DID, handle: HANDLE, confirmed: true,
      }))
    }
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let githubFetched = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      fetchedUrls.push(url)
      if (url.includes('resolveHandle')) {
        await held
        return new Response(JSON.stringify({ did: DID }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('proofsiblingx')) githubFetched = true
      return new Response('', { status: 404 })
    }))

    const pending = postBatch(env, {
      claims: [
        { platform: 'bluesky', identity: HANDLE, proof: 'oauth', pubkey: PUBKEY },
        githubClaim('proofsiblingx'),
      ],
    })

    await vi.waitFor(() => expect(githubFetched).toBe(true))
    expect(fetchedUrls.some(url => url.includes('resolveHandle'))).toBe(true)
    release()
    const res = await pending
    expect(res.status).toBe(200)
    const out = await results(res)
    expect(out[0]).toMatchObject({ verified: true, cached: true })
    expect(out[1]).toMatchObject({ verified: false, cached: false })
  })

  it('answers try-again for the claims whose limit could not be read and checks the rest', async () => {
    const { env, rateLimitKV, rateLimitStore } = createEnv()
    rateLimitKV.get.mockImplementation(async (key: string) => {
      if (key.startsWith('rl:pk:') && key.includes(OTHER_PUBKEY)) throw new Error(`KV GET failed: ${key}`)
      return rateLimitStore.get(key) ?? null
    })

    const res = await postBatch(env, { claims: [githubClaim('proofmine'), githubClaim('prooftheirs', OTHER_PUBKEY)] })

    expect(res.status).toBe(200)
    const out = await results(res)
    expect(checked('proofmine')).toBe(true)
    expect(checked('prooftheirs')).toBe(false)
    expect(out[1]).toMatchObject({
      verified: false,
      error: 'Rate limit exceeded: the limits could not be checked right now',
      code: 'temporarily_unavailable',
      cached: false,
    })
    expectLogsCarryNoIdentifiers()
  })

  it('still checks a claim when its limit cannot be saved', async () => {
    const { env, rateLimitKV, rateLimitStore } = createEnv()
    rateLimitKV.put.mockImplementation(async (key: string, value: string) => {
      if (key.startsWith('rl:pk') || key.startsWith('rl:plat')) throw new Error(`KV PUT failed: ${key}`)
      rateLimitStore.set(key, value)
    })

    const res = await postBatch(env, { claims: [githubClaim('proofsavex')] })

    expect(res.status).toBe(200)
    const [result] = await results(res)
    expect(checked('proofsavex')).toBe(true)
    expect(result.error).not.toMatch(/^Rate limit exceeded/)
    expectLogsCarryNoIdentifiers()
  })

  it('counts one pubkey sent in different cases once', async () => {
    const { env, rateLimitStore } = createEnv()
    rateLimitStore.set(counterKey('rl:pk', PUBKEY), '19')

    const res = await postBatch(env, { claims: [githubClaim('prooflowerx'), githubClaim('proofupperx', PUBKEY.toUpperCase())] })

    expect(res.status).toBe(200)
    const out = await results(res)
    expect([checked('prooflowerx'), checked('proofupperx')].filter(Boolean)).toHaveLength(1)
    expect(out.filter(r => r.error === 'Rate limit exceeded for this pubkey')).toHaveLength(1)
  })

  it('answers a refused Bluesky sign-in link as try-again, not as a lapsed sign-in', async () => {
    const { env, rateLimitStore } = createEnv()
    rateLimitStore.set(counterKey('rl:pk', PUBKEY), '20')

    const res = await postBatch(env, { claims: [{ platform: 'bluesky', identity: 'alice.bsky.social', proof: 'oauth', pubkey: PUBKEY }] })

    expect(res.status).toBe(200)
    const [result] = await results(res)
    expect(result.code).toBe('temporarily_unavailable')
    expect(result.error).toMatch(/^Rate limit exceeded/)
    expect(fetchedUrls).toEqual([])
  })

  it('does not remember a refused claim', async () => {
    const { env, rateLimitStore, cacheStore } = createEnv()
    rateLimitStore.set(counterKey('rl:pk', PUBKEY), '20')
    const claim = githubClaim('proofrefusedx')

    const first = await results(await postBatch(env, { claims: [claim] }))
    expect(first[0]).toMatchObject(PUBKEY_REFUSAL)
    expect(cacheStore.has(cacheKey('github', 'octocat', 'proofrefusedx', PUBKEY))).toBe(false)
    expect(checked('proofrefusedx')).toBe(false)

    rateLimitStore.set(counterKey('rl:pk', PUBKEY), '0')
    const second = await results(await postBatch(env, { claims: [claim] }))
    expect(checked('proofrefusedx')).toBe(true)
    expect(second[0].error).not.toMatch(/^Rate limit exceeded/)
  })

  it('answers only once its counter writes have finished', async () => {
    const { env, rateLimitKV, rateLimitStore } = createEnv()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let heldWrites = 0
    rateLimitKV.put.mockImplementation(async (key: string, value: string) => {
      if (key.startsWith('rl:pk') || key.startsWith('rl:plat')) {
        heldWrites++
        await held
      }
      rateLimitStore.set(key, value)
    })
    let settled = false

    const pending = postBatch(env, { claims: [githubClaim('proofwrittenx')] }).finally(() => { settled = true })

    await vi.waitFor(() => expect(checked('proofwrittenx')).toBe(true))
    expect(heldWrites).toBeGreaterThan(0)
    for (let tick = 0; tick < 10; tick++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)

    release()
    const res = await pending
    expect(res.status).toBe(200)
    expect(rateLimitStore.get(counterKey('rl:pk', PUBKEY))).toBe('1')
  })

  it('echoes the identity as sent on a refused claim that tidying changes', async () => {
    const { env, rateLimitStore } = createEnv()
    rateLimitStore.set(counterKey('rl:pk', PUBKEY), '20')

    const res = await postBatch(env, { claims: [{ platform: 'github', identity: '@octocat', proof: 'proofechox', pubkey: PUBKEY }] })

    expect(res.status).toBe(200)
    const [result] = await results(res)
    expect(result).toMatchObject({ ...PUBKEY_REFUSAL, platform: 'github', identity: '@octocat' })
    expect(checked('proofechox')).toBe(false)
  })

  it('counts the same claim sent twice as two checks', async () => {
    const { env, rateLimitStore } = createEnv()
    rateLimitStore.set(counterKey('rl:pk', PUBKEY), '19')
    const claim = githubClaim('prooftwicex')

    const res = await postBatch(env, { claims: [claim, claim] })

    expect(res.status).toBe(200)
    const out = await results(res)
    expect(out.filter(r => r.error === 'Rate limit exceeded for this pubkey')).toHaveLength(1)
    expect(out.filter(r => !r.error?.startsWith('Rate limit exceeded'))).toHaveLength(1)
    expect(fetchedUrls.filter(url => url.includes('prooftwicex'))).toHaveLength(1)
  })

  it('gives one address 15 checks a minute across requests', async () => {
    const { env } = createEnv()
    const first = proofs(10)
    const second = Array.from({ length: 10 }, (_, i) => `proofb${i}x`)
    const third = 'proofcthirdx'

    await postBatch(env, { claims: first.map(id => githubClaim(id)) }, '203.0.113.9')
    const out = await results(await postBatch(env, { claims: second.map(id => githubClaim(id, OTHER_PUBKEY)) }, '203.0.113.9'))

    expect(second.slice(0, 5).map(checked)).toEqual([true, true, true, true, true])
    expect(second.slice(5).map(checked)).toEqual([false, false, false, false, false])
    for (const result of out.slice(5)) {
      expect(result).toMatchObject({ error: 'Rate limit exceeded for this IP address', code: 'temporarily_unavailable', cached: false })
    }

    await postBatch(env, { claims: [githubClaim(third)] }, '198.51.100.7')
    expect(checked(third)).toBe(true)
    expectLogsCarryNoIdentifiers()
  })

  describe('the single-claim routes spend the same address budget', () => {
    // Fifteen checks from one address, spread over two pubkeys.
    async function spendAddressBudget(env: Bindings) {
      await postBatch(env, { claims: proofs(10).map(id => githubClaim(id)) }, '203.0.113.9')
      await postBatch(env, { claims: Array.from({ length: 5 }, (_, i) => githubClaim(`proofs${i}x`, OTHER_PUBKEY)) }, '203.0.113.9')
    }
    const single = (env: Bindings, claim: unknown, address: string) => app.request('/verify/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': address },
      body: JSON.stringify(claim),
    }, env)
    const byPath = (env: Bindings, proof: string, address: string) =>
      app.request(`/verify/github/octocat/${proof}?pubkey=${PUBKEY}&format=json`, { headers: { 'cf-connecting-ip': address } }, env)

    it('POST /verify/single refuses a check from an address that has spent its budget', async () => {
      const { env } = createEnv()
      await spendAddressBudget(env)

      const refused = await single(env, githubClaim('proofsinglex'), '203.0.113.9')
      expect(await refused.json()).toMatchObject({ error: 'Rate limit exceeded for this IP address', code: 'temporarily_unavailable', cached: false })
      expect(checked('proofsinglex')).toBe(false)

      await single(env, githubClaim('proofsingley'), '198.51.100.7')
      expect(checked('proofsingley')).toBe(true)
    })

    it('GET /verify/:platform/... refuses a check from an address that has spent its budget', async () => {
      const { env } = createEnv()
      await spendAddressBudget(env)

      const refused = await byPath(env, 'proofpathx', '203.0.113.9')
      expect(await refused.json()).toMatchObject({ error: 'Rate limit exceeded for this IP address', code: 'temporarily_unavailable', cached: false })
      expect(checked('proofpathx')).toBe(false)

      await byPath(env, 'proofpathy', '198.51.100.7')
      expect(checked('proofpathy')).toBe(true)
    })
  })
})
