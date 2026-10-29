// ABOUTME: Tests that /verify answers a sign-in claim only while the sign-in
// ABOUTME: record's lifetime lasts, and keeps older re-checked records stored.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import worker from '../index'
import type { Bindings } from '../types'
import { oauthVerificationKey, deleteOAuthVerification } from '../oauth/state'

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

// Records saved before confirmed sign-ins were stored without an expiry still
// carry a 30-day one. A Bluesky link that verifies is stored again without it,
// under the handle and the DID.
describe('a Bluesky link saved with the old 30-day expiry', () => {
  const HANDLE = 'alice.bsky.social'
  const DID = 'did:plc:alice111111111111111111'
  const OTHER_DID = 'did:plc:other222222222222222222'

  function blueskyEnv(record: Record<string, unknown> = {}, partner: Record<string, unknown> = {}) {
    const store = new Map<string, string>()
    const put = vi.fn(async (key: string, value: string, _opts?: { expirationTtl?: number }) => { store.set(key, value) })
    const get = vi.fn(async (key: string) => store.get(key) ?? null)
    const kv = {
      get,
      put,
      delete: async (key: string) => { store.delete(key) },
    } as unknown as KVNamespace
    for (const identity of [HANDLE, DID]) {
      store.set(oauthVerificationKey('bluesky', identity, PUBKEY), JSON.stringify({
        platform: 'bluesky', identity, pubkey: PUBKEY, verified: true, method: 'oauth',
        checked_at: NOW - 10 * DAY, account_id: DID, handle: HANDLE, confirmed: true, ...record, ...(identity === DID ? partner : {}),
      }))
    }
    const env = { CACHE_KV: kv, RATE_LIMIT_KV: kv, SIGNIN_CONFIRMATION: 'required' } as Bindings
    return { env, store, put, get }
  }
  const signInWrites = (put: ReturnType<typeof vi.fn>) => put.mock.calls.filter(c => String(c[0]).startsWith('oauth_verified:'))
  const read = (store: Map<string, string>, identity: string) => JSON.parse(store.get(oauthVerificationKey('bluesky', identity, PUBKEY)) ?? 'null')

  async function check(env: Bindings, identity = HANDLE): Promise<Result> {
    const res = await worker.fetch(new Request('https://verifier.divine.video/verify/single', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'bluesky', identity, proof: 'oauth', pubkey: PUBKEY }),
    }), env)
    return res.json() as Promise<Result>
  }

  function handlePointsTo(did: string) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes('com.atproto.identity.resolveHandle')) throw new Error(`unexpected fetch ${String(input)}`)
      return new Response(JSON.stringify({ did }), { headers: { 'Content-Type': 'application/json' } })
    }))
  }

  it.each([
    ['the handle', HANDLE],
    ['the DID', DID],
  ])('is stored again once with its pair, with no expiry, when it verifies by %s', async (_label, claimed) => {
    handlePointsTo(DID)
    const { env, store, put, get } = blueskyEnv()
    const before: Record<string, Record<string, unknown>> = { [HANDLE]: read(store, HANDLE), [DID]: read(store, DID) }
    expect(await check(env, claimed)).toMatchObject({ verified: true, method: 'oauth' })
    const writes = signInWrites(put)
    expect(writes.map(c => c[0]).sort()).toEqual([oauthVerificationKey('bluesky', HANDLE, PUBKEY), oauthVerificationKey('bluesky', DID, PUBKEY)].sort())
    for (const write of writes) expect(write[2]?.expirationTtl).toBeUndefined()
    for (const identity of [HANDLE, DID]) expect(read(store, identity)).toEqual({ ...before[identity], stored_without_expiry: true })

    // Once marked, a verify reads only the claimed record, as the check itself needs.
    get.mockClear()
    expect(await check(env, claimed)).toMatchObject({ verified: true, method: 'oauth' })
    expect(signInWrites(put)).toHaveLength(2)
    expect(get.mock.calls.filter(c => String(c[0]).startsWith('oauth_verified:')).map(c => c[0])).toEqual([oauthVerificationKey('bluesky', claimed, PUBKEY)])
  })

  it.each([
    ['a different account', { account_id: OTHER_DID }],
    ['a different handle', { handle: 'old.bsky.social' }],
    ['an unconfirmed sign-in', { confirmed: undefined }],
    ['a record already stored without an expiry', { stored_without_expiry: true }],
  ])('leaves the DID record alone when it belongs to %s', async (_label, partner) => {
    handlePointsTo(DID)
    const { env, store, put } = blueskyEnv({}, partner)
    const before = read(store, DID)
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    expect(signInWrites(put).map(c => c[0])).toEqual([oauthVerificationKey('bluesky', HANDLE, PUBKEY)])
    expect(read(store, DID)).toEqual(before)
  })

  it('stores the handle record again when there is no DID record', async () => {
    handlePointsTo(DID)
    const { env, store, put } = blueskyEnv()
    store.delete(oauthVerificationKey('bluesky', DID, PUBKEY))
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    expect(signInWrites(put).map(c => c[0])).toEqual([oauthVerificationKey('bluesky', HANDLE, PUBKEY)])
    expect(store.has(oauthVerificationKey('bluesky', DID, PUBKEY))).toBe(false)
  })

  // The handle lookup runs between the check's read and the write, so each
  // record is read again just before it is written.
  function changeDuringLookup(change: () => void) {
    vi.stubGlobal('fetch', vi.fn(async () => {
      change()
      return new Response(JSON.stringify({ did: DID }), { headers: { 'Content-Type': 'application/json' } })
    }))
  }
  const key = (identity: string) => oauthVerificationKey('bluesky', identity, PUBKEY)

  it('does not bring back a link unlinked while it was being checked', async () => {
    const { env, store, put } = blueskyEnv()
    changeDuringLookup(() => { store.delete(key(HANDLE)); store.delete(key(DID)) })
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    expect(signInWrites(put)).toHaveLength(0)
    expect(store.has(key(HANDLE))).toBe(false)
    expect(store.has(key(DID))).toBe(false)
  })

  it('does not write over a newer sign-in saved while it was being checked', async () => {
    const { env, store, put } = blueskyEnv()
    const newer = (identity: string) => JSON.stringify({ ...read(store, identity), checked_at: NOW, stored_without_expiry: true })
    const replaced = { [HANDLE]: newer(HANDLE), [DID]: newer(DID) }
    changeDuringLookup(() => { store.set(key(HANDLE), replaced[HANDLE]); store.set(key(DID), replaced[DID]) })
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    expect(signInWrites(put)).toHaveLength(0)
    expect(store.get(key(HANDLE))).toBe(replaced[HANDLE])
    expect(store.get(key(DID))).toBe(replaced[DID])
  })

  it('does not store again a record that changed while it was being checked', async () => {
    const { env, store, put } = blueskyEnv()
    const changed = JSON.stringify({ ...read(store, HANDLE), checked_at: NOW })
    changeDuringLookup(() => { store.set(key(HANDLE), changed) })
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    expect(signInWrites(put).map(c => c[0])).not.toContain(key(HANDLE))
    expect(store.get(key(HANDLE))).toBe(changed)
  })

  it('is still verified when storing it again fails', async () => {
    handlePointsTo(DID)
    const { env, store, put } = blueskyEnv()
    put.mockImplementation(async (key: string, value: string) => {
      if (key.startsWith('oauth_verified:')) throw new Error('KV PUT failed: 429 Too Many Requests')
      store.set(key, value)
    })
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    expect(console.warn).toHaveBeenCalled()
  })

  it('still stores the DID record again when storing the handle record fails', async () => {
    handlePointsTo(DID)
    const { env, store, put } = blueskyEnv()
    put.mockImplementation(async (key: string, value: string) => {
      if (key === oauthVerificationKey('bluesky', HANDLE, PUBKEY)) throw new Error('KV PUT failed: 429 Too Many Requests')
      store.set(key, value)
    })
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    expect(read(store, HANDLE).stored_without_expiry).toBeUndefined()
    expect(read(store, DID).stored_without_expiry).toBe(true)
  })

  it('is not stored again when the handle points to a different account', async () => {
    handlePointsTo(OTHER_DID)
    const { env, put } = blueskyEnv()
    expect((await check(env)).verified).toBe(false)
    expect(signInWrites(put)).toHaveLength(0)
  })

  it('is not stored again when it is unconfirmed', async () => {
    handlePointsTo(DID)
    const { env, put } = blueskyEnv({ confirmed: undefined, checked_at: NOW - 60 * 60 })
    expect(await check({ ...env, SIGNIN_CONFIRMATION: 'optional' })).toMatchObject({ verified: true, method: 'oauth' })
    expect(signInWrites(put)).toHaveLength(0)
  })

  it('is not stored again when it has no account ID', async () => {
    handlePointsTo(DID)
    const { env, put } = blueskyEnv({ account_id: undefined })
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    expect(signInWrites(put)).toHaveLength(0)
  })

  // Unlinking pairs the handle and DID records by account and handle, so the
  // records stored again still unlink together, as does a pair where storing
  // one of them again failed.
  it.each([
    { by: 'the handle', unlinked: HANDLE, other: DID, stored: 'both stored again', onlyOne: false },
    { by: 'the DID', unlinked: DID, other: HANDLE, stored: 'both stored again', onlyOne: false },
    { by: 'the handle', unlinked: HANDLE, other: DID, stored: 'only the handle record stored again', onlyOne: true },
    { by: 'the DID', unlinked: DID, other: HANDLE, stored: 'only the handle record stored again', onlyOne: true },
  ])('is removed with its pair when unlinked by $by, $stored', async ({ unlinked, other, onlyOne }) => {
    handlePointsTo(DID)
    const { env, store, put } = blueskyEnv()
    if (onlyOne) {
      put.mockImplementation(async (key: string, value: string) => {
        if (key === oauthVerificationKey('bluesky', DID, PUBKEY)) throw new Error('KV PUT failed')
        store.set(key, value)
      })
    }
    await check(env)
    expect(read(store, HANDLE).stored_without_expiry).toBe(true)
    expect(read(store, DID).stored_without_expiry).toBe(onlyOne ? undefined : true)
    await deleteOAuthVerification(env.CACHE_KV, 'bluesky', unlinked, PUBKEY)
    expect(read(store, unlinked)).toBeNull()
    expect(read(store, other)).toBeNull()
  })
})

describe('a TikTok link saved before confirmed records were stored without an expiry', () => {
  it('is not stored again, since its lifetime is fixed', async () => {
    const env = envWithTikTokSignIn(NOW - DAY)
    const put = vi.spyOn(env.CACHE_KV, 'put')
    expect(await single(env)).toMatchObject({ verified: true, method: 'oauth' })
    expect(put.mock.calls.filter(c => String(c[0]).startsWith('oauth_verified:'))).toHaveLength(0)
  })
})
