// ABOUTME: Tests that /verify answers a sign-in claim only while the sign-in
// ABOUTME: record's lifetime lasts (src/oauth/signin-lifetime.ts).
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
