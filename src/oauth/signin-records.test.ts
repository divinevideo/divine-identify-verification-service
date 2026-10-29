import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Bindings } from '../types'
import { oauthVerificationKey, deleteOAuthVerification } from './state'
import { saveSignIn, getCountedSignIn } from './signin-records'

const PUBKEY = 'ab'.repeat(32)
const HANDLE = 'alice.bsky.social'
const DID = 'did:plc:alice111111111111111111'
const OTHER_DID = 'did:plc:other222222222222222222'

function createEnv(vars: Partial<Bindings> = {}) {
  const store = new Map<string, string>()
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: { expirationTtl?: number }) => { store.set(key, value) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
  }
  const env = { CACHE_KV: kv, RATE_LIMIT_KV: kv, ...vars } as unknown as Bindings
  return { env, store, kv }
}

const read = (store: Map<string, string>, platform: string, identity: string) =>
  JSON.parse(store.get(oauthVerificationKey(platform, identity, PUBKEY)) ?? 'null')
const ttlOf = (kv: ReturnType<typeof createEnv>['kv'], platform: string, identity: string) =>
  kv.put.mock.calls.find(c => c[0] === oauthVerificationKey(platform, identity, PUBKEY))?.[2]

const bluesky = { platform: 'bluesky' as const, identity: HANDLE, account_id: DID, handle: HANDLE }
const CONFIRMATION = { event_id: 'e'.repeat(64), created_at: 1_760_000_000 }

describe('saving a sign-in', () => {
  it('saves a confirmed Bluesky sign-in under the handle and the DID with no expiry, with the confirming event', async () => {
    const { env, store, kv } = createEnv()
    await saveSignIn(env, PUBKEY, bluesky, CONFIRMATION)
    for (const identity of [HANDLE, DID]) {
      expect(read(store, 'bluesky', identity)).toMatchObject({
        identity, account_id: DID, handle: HANDLE, confirmed: true,
        confirm_event_id: 'e'.repeat(64), confirm_created_at: 1_760_000_000, stored_without_expiry: true,
      })
      expect(ttlOf(kv, 'bluesky', identity)).toBeUndefined()
    }
  })

  it('keeps an unconfirmed Bluesky sign-in for a day, without a confirmed flag', async () => {
    const { env, store, kv } = createEnv()
    await saveSignIn(env, PUBKEY, bluesky, null)
    for (const identity of [HANDLE, DID]) {
      expect(read(store, 'bluesky', identity).confirmed).toBeUndefined()
      expect(ttlOf(kv, 'bluesky', identity)).toEqual({ expirationTtl: 86400 })
    }
  })

  // How long a confirmed one counts is decided when it is read (signin-lifetime.ts).
  it.each(['twitter', 'youtube', 'tiktok'] as const)('stores a confirmed %s sign-in with no expiry, and an unconfirmed one for a day', async platform => {
    for (const [confirmation, ttl] of [[CONFIRMATION, undefined], [null, { expirationTtl: 86400 }]] as const) {
      const { env, kv } = createEnv()
      await saveSignIn(env, PUBKEY, { platform, identity: 'creator', account_id: 'acct-1' }, confirmation)
      expect(ttlOf(kv, platform, 'creator')).toEqual(ttl)
    }
  })

  it('does not let an unconfirmed sign-in replace a confirmed one for the same account', async () => {
    const { env, store, kv } = createEnv()
    await saveSignIn(env, PUBKEY, bluesky, CONFIRMATION)
    kv.put.mockClear()
    await saveSignIn(env, PUBKEY, bluesky, null)
    expect(read(store, 'bluesky', HANDLE).confirmed).toBe(true)
    expect(read(store, 'bluesky', DID).confirmed).toBe(true)
    expect(kv.put.mock.calls.some(c => String(c[0]).startsWith('oauth_verified:'))).toBe(false)
  })

  it('does not let an unconfirmed sign-in replace a confirmed one on a platform without account IDs', async () => {
    const { env, store } = createEnv()
    await saveSignIn(env, PUBKEY, { platform: 'twitter', identity: 'jack' }, CONFIRMATION)
    await saveSignIn(env, PUBKEY, { platform: 'twitter', identity: 'jack' }, null)
    expect(read(store, 'twitter', 'jack').confirmed).toBe(true)
  })

  it('lets an unconfirmed sign-in replace a confirmed one for a different account', async () => {
    const { env, store } = createEnv()
    await saveSignIn(env, PUBKEY, { ...bluesky, account_id: OTHER_DID }, CONFIRMATION)
    await saveSignIn(env, PUBKEY, bluesky, null)
    expect(read(store, 'bluesky', HANDLE)).toMatchObject({ account_id: DID })
    expect(read(store, 'bluesky', HANDLE).confirmed).toBeUndefined()
  })

  it('lets a confirmed sign-in replace an unconfirmed one', async () => {
    const { env, store } = createEnv()
    await saveSignIn(env, PUBKEY, bluesky, null)
    await saveSignIn(env, PUBKEY, bluesky, CONFIRMATION)
    expect(read(store, 'bluesky', HANDLE).confirmed).toBe(true)
  })

  it('replaces the confirmed DID record when an unconfirmed sign-in comes back with a new handle, so unlinking the new handle removes both', async () => {
    const { env, store } = createEnv({ SIGNIN_CONFIRMATION: 'optional' })
    await saveSignIn(env, PUBKEY, { ...bluesky, identity: 'old.bsky.social', handle: 'old.bsky.social' }, CONFIRMATION)
    await saveSignIn(env, PUBKEY, bluesky, null)
    expect(read(store, 'bluesky', DID)).toMatchObject({ handle: HANDLE })
    expect(read(store, 'bluesky', DID).confirmed).toBeUndefined()
    await deleteOAuthVerification(env.CACHE_KV, 'bluesky', HANDLE, PUBKEY)
    expect(store.has(oauthVerificationKey('bluesky', DID, PUBKEY))).toBe(false)
    expect(store.has(oauthVerificationKey('bluesky', HANDLE, PUBKEY))).toBe(false)
  })

  // Confirmed records are stored with no expiry, so one past its lifetime can
  // still be stored. It no longer counts, so it doesn't block a fresh sign-in.
  it('lets an unconfirmed sign-in replace a confirmed one that no longer counts', async () => {
    const NOW = 1_800_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW * 1000)
    try {
      const { env, store } = createEnv({ SIGNIN_CONFIRMATION: 'optional' })
      store.set(oauthVerificationKey('tiktok', 'creator', PUBKEY), JSON.stringify({
        platform: 'tiktok', identity: 'creator', pubkey: PUBKEY, verified: true, method: 'oauth',
        checked_at: NOW - 31 * 24 * 60 * 60, account_id: 'acct-1', confirmed: true, stored_without_expiry: true,
      }))
      await saveSignIn(env, PUBKEY, { platform: 'tiktok', identity: 'creator', account_id: 'acct-1' }, null)
      expect(read(store, 'tiktok', 'creator').confirmed).toBeUndefined()
      expect(read(store, 'tiktok', 'creator').checked_at).toBe(NOW)
      expect(await getCountedSignIn(env, 'tiktok', 'creator', PUBKEY)).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes the record left under the account\'s previous handle', async () => {
    const { env, store } = createEnv()
    await saveSignIn(env, PUBKEY, { ...bluesky, identity: 'old.bsky.social', handle: 'old.bsky.social' }, CONFIRMATION)
    await saveSignIn(env, PUBKEY, bluesky, CONFIRMATION)
    expect(store.has(oauthVerificationKey('bluesky', 'old.bsky.social', PUBKEY))).toBe(false)
    expect(read(store, 'bluesky', DID).handle).toBe(HANDLE)
  })
})

describe('which sign-in records count', () => {
  async function seeded(vars: Partial<Bindings>, record: Record<string, unknown>) {
    const { env, store } = createEnv(vars)
    store.set(oauthVerificationKey('twitter', 'jack', PUBKEY), JSON.stringify({
      platform: 'twitter', identity: 'jack', pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: Math.floor(Date.now() / 1000), ...record,
    }))
    return env
  }

  it('counts every record before the switch', async () => {
    expect(await getCountedSignIn(await seeded({}, {}), 'twitter', 'jack', PUBKEY)).not.toBeNull()
    expect(await getCountedSignIn(await seeded({}, { confirmed: true }), 'twitter', 'jack', PUBKEY)).not.toBeNull()
  })

  it('counts only confirmed records once confirmation is required, including ones saved before this change', async () => {
    const required = { SIGNIN_CONFIRMATION: 'required' }
    expect(await getCountedSignIn(await seeded(required, {}), 'twitter', 'jack', PUBKEY)).toBeNull()
    expect(await getCountedSignIn(await seeded(required, { bound: true }), 'twitter', 'jack', PUBKEY)).toBeNull()
    expect(await getCountedSignIn(await seeded(required, { confirmed: 'true' }), 'twitter', 'jack', PUBKEY)).toBeNull()
    expect(await getCountedSignIn(await seeded(required, { confirmed: true }), 'twitter', 'jack', PUBKEY)).not.toBeNull()
  })

  it('finds nothing when there is no record', async () => {
    const { env } = createEnv()
    expect(await getCountedSignIn(env, 'twitter', 'jack', PUBKEY)).toBeNull()
  })
})

describe('how long a sign-in record counts', () => {
  const NOW = 1_800_000_000
  const DAY = 24 * 60 * 60
  const required = { SIGNIN_CONFIRMATION: 'required' }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW * 1000)
  })
  afterEach(() => { vi.useRealTimers() })

  function seededTikTok(vars: Partial<Bindings>, record: Record<string, unknown>) {
    const { env, store } = createEnv(vars)
    store.set(oauthVerificationKey('tiktok', 'creator', PUBKEY), JSON.stringify({
      platform: 'tiktok', identity: 'creator', pubkey: PUBKEY, verified: true, method: 'oauth', account_id: 'acct-1', ...record,
    }))
    return env
  }
  const countsAt = async (vars: Partial<Bindings>, record: Record<string, unknown>) =>
    (await getCountedSignIn(seededTikTok(vars, record), 'tiktok', 'creator', PUBKEY)) !== null

  it.each([
    ['29 days', NOW - 29 * DAY, true],
    ['exactly 30 days', NOW - 30 * DAY, true],
    ['30 days and a second', NOW - 30 * DAY - 1, false],
    ['31 days', NOW - 31 * DAY, false],
  ])('a confirmed TikTok record saved %s ago (checked_at %i) counts: %s', async (_label, checkedAt, expected) => {
    expect(await countsAt(required, { confirmed: true, checked_at: checkedAt })).toBe(expected)
  })

  it.each([
    ['missing', {}],
    ['a string', { checked_at: String(NOW) }],
    ['null', { checked_at: null }],
  ])('a confirmed TikTok record whose checked_at is %s does not count, without throwing', async (_label, record) => {
    await expect(countsAt(required, { confirmed: true, ...record })).resolves.toBe(false)
  })

  it('an unconfirmed record counts for a day before the switch', async () => {
    expect(await countsAt({}, { checked_at: NOW - DAY })).toBe(true)
    expect(await countsAt({}, { checked_at: NOW - DAY - 1 })).toBe(false)
  })

  it('a confirmed Bluesky record with a DID counts however old it is', async () => {
    const { env, store } = createEnv(required)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), JSON.stringify({
      platform: 'bluesky', identity: HANDLE, pubkey: PUBKEY, verified: true, method: 'oauth',
      checked_at: NOW - 400 * DAY, account_id: DID, handle: HANDLE, confirmed: true,
    }))
    expect(await getCountedSignIn(env, 'bluesky', HANDLE, PUBKEY)).not.toBeNull()
  })
})
