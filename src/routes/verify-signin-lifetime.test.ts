// ABOUTME: Tests that /verify answers a sign-in claim only while the sign-in
// ABOUTME: record's lifetime lasts, and writes no sign-in record when it does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import worker from '../index'
import type { Bindings } from '../types'
import { oauthVerificationKey } from '../oauth/state'

const PUBKEY = 'ab'.repeat(32)
const NOW = 1_800_000_000
const DAY = 24 * 60 * 60
const CLAIM = { platform: 'tiktok', identity: 'creator', proof: 'oauth', pubkey: PUBKEY }

// A lapsed record falls through to the proof post, which would fetch from the
// platform; no network in tests.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1000)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests') }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function envWithTikTokSignIn(checkedAt: number): Bindings {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
  } as unknown as KVNamespace
  store.set(oauthVerificationKey('tiktok', 'creator', PUBKEY), JSON.stringify({
    platform: 'tiktok', identity: 'creator', pubkey: PUBKEY, verified: true, method: 'oauth',
    checked_at: checkedAt, account_id: 'acct-1', confirmed: true,
  }))
  return { CACHE_KV: kv, RATE_LIMIT_KV: kv, SIGNIN_CONFIRMATION: 'required' } as Bindings
}

type Result = { verified: boolean; method?: string }

const signInWrites = (put: ReturnType<typeof vi.fn>) => put.mock.calls.filter(c => String(c[0]).startsWith('oauth_verified:'))

async function single(env: Bindings): Promise<Result> {
  const res = await worker.fetch(new Request('https://verifier.divine.video/verify/single', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(CLAIM),
  }), env)
  return res.json() as Promise<Result>
}

async function batch(env: Bindings): Promise<Result> {
  const res = await worker.fetch(new Request('https://verifier.divine.video/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claims: [CLAIM] }),
  }), env)
  return (await res.json() as { results: Result[] }).results[0]
}

describe.each([['/verify/single', single], ['/verify', batch]] as const)('a TikTok sign-in through %s', (_path, check) => {
  it('is verified 29 days after it was confirmed', async () => {
    expect(await check(envWithTikTokSignIn(NOW - 29 * DAY))).toMatchObject({ verified: true, method: 'oauth' })
  })

  it('is not verified 31 days after it was confirmed', async () => {
    const result = await check(envWithTikTokSignIn(NOW - 31 * DAY))
    expect(result.verified).toBe(false)
    expect(result.method).not.toBe('oauth')
  })
})

// A Bluesky link lasts the same 30 days. Past them, the claim falls through to
// Bluesky's identity-link records, and there are none here.
describe.each([
  ['the handle', 'alice.bsky.social'],
  ['the DID', 'did:plc:alice111111111111111111'],
])('a confirmed Bluesky sign-in claimed by %s through /verify/single', (_label, claimed) => {
  const HANDLE = 'alice.bsky.social'
  const DID = 'did:plc:alice111111111111111111'
  const PDS = 'https://example-pds.test'

  function blueskyEnv(checkedAt: number) {
    const store = new Map<string, string>()
    const put = vi.fn(async (key: string, value: string, _opts?: { expirationTtl?: number }) => { store.set(key, value) })
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      put,
      delete: async (key: string) => { store.delete(key) },
    } as unknown as KVNamespace
    for (const identity of [HANDLE, DID]) {
      store.set(oauthVerificationKey('bluesky', identity, PUBKEY), JSON.stringify({
        platform: 'bluesky', identity, pubkey: PUBKEY, verified: true, method: 'oauth',
        checked_at: checkedAt, account_id: DID, handle: HANDLE, confirmed: true,
      }))
    }
    const env = { CACHE_KV: kv, RATE_LIMIT_KV: kv, SIGNIN_CONFIRMATION: 'required' } as Bindings
    return { env, put }
  }

  async function check(env: Bindings): Promise<Result & { code?: string }> {
    const res = await worker.fetch(new Request('https://verifier.divine.video/verify/single', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'bluesky', identity: claimed, proof: 'oauth', pubkey: PUBKEY }),
    }), env)
    return res.json() as Promise<Result & { code?: string }>
  }

  // The handle points to the DID, whose account has no identity-link records
  // and no post to find.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
      if (url.startsWith('https://bsky.social/xrpc/com.atproto.identity.resolveHandle')) return json({ did: DID })
      if (url === `https://plc.directory/${DID}`) return json({ service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] })
      if (url.startsWith(`${PDS}/xrpc/com.atproto.repo.listRecords`)) return json({ records: [] })
      return new Response('', { status: 404 })
    }))
  })

  it('is verified 29 days after it was confirmed', async () => {
    expect(await check(blueskyEnv(NOW - 29 * DAY).env)).toMatchObject({ verified: true, method: 'oauth' })
  })

  it('is not verified 31 days after it was confirmed', async () => {
    const result = await check(blueskyEnv(NOW - 31 * DAY).env)
    expect(result.verified).toBe(false)
    expect(result.method).not.toBe('oauth')
    expect(result.code).toBe('signin_expired')
  })

  it('writes no sign-in record when verifying a confirmed Bluesky link', async () => {
    const { env, put } = blueskyEnv(NOW - 10 * DAY)
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    expect(signInWrites(put)).toHaveLength(0)
  })
})
