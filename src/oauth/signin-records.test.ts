import { describe, it, expect, vi } from 'vitest'
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
  it('saves a confirmed Bluesky sign-in under the handle and the DID for 30 days, with the confirming event', async () => {
    const { env, store, kv } = createEnv()
    await saveSignIn(env, PUBKEY, bluesky, CONFIRMATION)
    for (const identity of [HANDLE, DID]) {
      expect(read(store, 'bluesky', identity)).toMatchObject({
        identity, account_id: DID, handle: HANDLE, confirmed: true,
        confirm_event_id: 'e'.repeat(64), confirm_created_at: 1_760_000_000,
      })
      expect(ttlOf(kv, 'bluesky', identity)).toEqual({ expirationTtl: 30 * 86400 })
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

  it.each(['twitter', 'youtube', 'tiktok'] as const)('keeps a %s sign-in for a day, confirmed or not', async platform => {
    for (const confirmation of [CONFIRMATION, null]) {
      const { env, kv } = createEnv()
      await saveSignIn(env, PUBKEY, { platform, identity: 'creator', account_id: 'acct-1' }, confirmation)
      expect(ttlOf(kv, platform, 'creator')).toEqual({ expirationTtl: 86400 })
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

  it('does not let an unconfirmed sign-in replace a confirmed one when neither has an account ID', async () => {
    const { env, store } = createEnv()
    await saveSignIn(env, PUBKEY, { platform: 'twitter', identity: 'jack' }, CONFIRMATION)
    await saveSignIn(env, PUBKEY, { platform: 'twitter', identity: 'jack' }, null)
    expect(read(store, 'twitter', 'jack').confirmed).toBe(true)
  })

  it('unlinks an X sign-in by its username, leaving a record of another X account alone', async () => {
    const { env, store } = createEnv()
    await saveSignIn(env, PUBKEY, { platform: 'twitter', identity: 'jack', account_id: '12' }, CONFIRMATION)
    // A username that happens to be another account's ID.
    await saveSignIn(env, PUBKEY, { platform: 'twitter', identity: '12', account_id: '99' }, CONFIRMATION)
    await deleteOAuthVerification(env.CACHE_KV, 'twitter', 'jack', PUBKEY)
    expect(store.has(oauthVerificationKey('twitter', 'jack', PUBKEY))).toBe(false)
    expect(read(store, 'twitter', '12')).toMatchObject({ account_id: '99' })
  })

  it('unlinks a YouTube sign-in by its handle, leaving the same channel\'s link by channel ID', async () => {
    const { env, store } = createEnv()
    await saveSignIn(env, PUBKEY, { platform: 'youtube', identity: 'UC1', account_id: 'UC1' }, CONFIRMATION)
    await saveSignIn(env, PUBKEY, { platform: 'youtube', identity: '@creator', account_id: 'UC1' }, CONFIRMATION)
    await deleteOAuthVerification(env.CACHE_KV, 'youtube', '@creator', PUBKEY)
    expect(store.has(oauthVerificationKey('youtube', '@creator', PUBKEY))).toBe(false)
    expect(read(store, 'youtube', 'UC1')).toMatchObject({ account_id: 'UC1', confirmed: true })
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
      platform: 'twitter', identity: 'jack', pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: 1, ...record,
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
