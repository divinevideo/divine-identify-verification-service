import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Bindings } from '../types'
import { oauthVerificationKey, deleteOAuthVerification } from './state'
import { saveSignIn, getCountedSignIn, signInStanding } from './signin-records'
import { confirmationAccessKey } from './confirmation-access'

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
      expect(ttlOf(kv, 'bluesky', identity)).toEqual({ expirationTtl: 2592000 })
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

  it.each(['twitter', 'youtube', 'tiktok'] as const)('stores a confirmed %s sign-in for 30 days, and an unconfirmed one for a day', async platform => {
    for (const [confirmation, ttl] of [[CONFIRMATION, { expirationTtl: 2592000 }], [null, { expirationTtl: 86400 }]] as const) {
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

  it('does not let an unconfirmed sign-in replace a confirmed one when neither has an account ID', async () => {
    const { env, store } = createEnv()
    await saveSignIn(env, PUBKEY, { platform: 'twitter', identity: 'jack' }, CONFIRMATION)
    await saveSignIn(env, PUBKEY, { platform: 'twitter', identity: 'jack' }, null)
    expect(read(store, 'twitter', 'jack').confirmed).toBe(true)
  })

  it.each([
    // A channel without a handle is linked by its channel ID.
    ['youtube', '@creator', 'UC1', 'the same'],
    // X and TikTok link by username only: a username that happens to be this account's own ID.
    ['twitter', 'synthetic-x-user', '1', 'the same'],
    ['tiktok', 'creator', 'open-1', 'the same'],
    // A username that happens to be another account's ID.
    ['twitter', 'synthetic-x-user', '1', 'another'],
  ] as const)('unlinks a %s sign-in by %s, leaving the link under %s, of %s account', async (platform, identity, accountId, owner) => {
    const ownerId = owner === 'the same' ? accountId : '99'
    const { env, store } = createEnv()
    await saveSignIn(env, PUBKEY, { platform, identity, account_id: accountId }, CONFIRMATION)
    await saveSignIn(env, PUBKEY, { platform, identity: accountId, account_id: ownerId }, CONFIRMATION)
    await deleteOAuthVerification(env.CACHE_KV, platform, identity, PUBKEY)
    expect(store.has(oauthVerificationKey(platform, identity, PUBKEY))).toBe(false)
    expect(read(store, platform, accountId)).toMatchObject({ account_id: ownerId, confirmed: true })
  })

  it.each([
    ['twitter', 'synthetic-x-user', '1'],
    ['youtube', '@creator', 'UC1'],
    ['tiktok', 'creator', 'open-1'],
  ] as const)('unlinks a %s sign-in by %s, leaving no record of it', async (platform, identity, accountId) => {
    const { env, store } = createEnv()
    await saveSignIn(env, PUBKEY, { platform, identity, account_id: accountId }, CONFIRMATION)
    expect(read(store, platform, identity)).toMatchObject({ account_id: accountId, confirmed: true })
    await deleteOAuthVerification(env.CACHE_KV, platform, identity, PUBKEY)
    expect([...store.keys()]).toEqual([])
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

  // Storage may still hold a confirmed record past its lifetime. It no longer
  // counts, so it doesn't block a fresh sign-in.
  it('lets an unconfirmed sign-in replace a confirmed one that no longer counts', async () => {
    const NOW = 1_800_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW * 1000)
    try {
      const { env, store } = createEnv({ SIGNIN_CONFIRMATION: 'optional' })
      store.set(oauthVerificationKey('tiktok', 'creator', PUBKEY), JSON.stringify({
        platform: 'tiktok', identity: 'creator', pubkey: PUBKEY, verified: true, method: 'oauth',
        checked_at: NOW - 31 * 24 * 60 * 60, account_id: 'acct-1', confirmed: true,
      }))
      await saveSignIn(env, PUBKEY, { platform: 'tiktok', identity: 'creator', account_id: 'acct-1' }, null)
      expect(read(store, 'tiktok', 'creator').confirmed).toBeUndefined()
      expect(read(store, 'tiktok', 'creator').checked_at).toBe(NOW)
      expect(await getCountedSignIn(env, 'tiktok', 'creator', PUBKEY)).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('signing in again restarts the 30 days for the handle and the DID record', async () => {
    const T = 1_800_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T * 1000)
    try {
      const { env, store, kv } = createEnv()
      await saveSignIn(env, PUBKEY, bluesky, CONFIRMATION)
      vi.setSystemTime((T + 20 * 24 * 60 * 60) * 1000)
      await saveSignIn(env, PUBKEY, bluesky, CONFIRMATION)
      for (const identity of [HANDLE, DID]) expect(read(store, 'bluesky', identity).checked_at).toBe(T + 20 * 24 * 60 * 60)
      const writes = kv.put.mock.calls.filter(c => String(c[0]).startsWith('oauth_verified:'))
      expect(writes).toHaveLength(4)
      for (const write of writes) expect(write[2]).toEqual({ expirationTtl: 2592000 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets an unconfirmed Bluesky sign-in replace a confirmed pair past 30 days, and not one within', async () => {
    const NOW = 1_800_000_000
    const DAY = 24 * 60 * 60
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW * 1000)
    try {
      for (const [ageDays, replaced] of [[31, true], [29, false]] as const) {
        const { env, store, kv } = createEnv({ SIGNIN_CONFIRMATION: 'optional' })
        for (const identity of [HANDLE, DID]) {
          store.set(oauthVerificationKey('bluesky', identity, PUBKEY), JSON.stringify({
            platform: 'bluesky', identity, pubkey: PUBKEY, verified: true, method: 'oauth',
            checked_at: NOW - ageDays * DAY, account_id: DID, handle: HANDLE, confirmed: true,
          }))
        }
        await saveSignIn(env, PUBKEY, bluesky, null)
        const writes = kv.put.mock.calls.filter(c => String(c[0]).startsWith('oauth_verified:'))
        if (replaced) {
          expect(writes.map(c => c[0]).sort()).toEqual([oauthVerificationKey('bluesky', HANDLE, PUBKEY), oauthVerificationKey('bluesky', DID, PUBKEY)].sort())
          for (const identity of [HANDLE, DID]) {
            expect(read(store, 'bluesky', identity).confirmed).toBeUndefined()
            expect(read(store, 'bluesky', identity).checked_at).toBe(NOW)
            expect(ttlOf(kv, 'bluesky', identity)).toEqual({ expirationTtl: 86400 })
          }
        } else {
          expect(writes).toHaveLength(0)
          for (const identity of [HANDLE, DID]) expect(read(store, 'bluesky', identity).confirmed).toBe(true)
        }
      }
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

  it('does not count a confirmed record while its platform is switched off, and counts it again once cleared', async () => {
    const required = { SIGNIN_CONFIRMATION: 'required' }
    const record = { confirmed: true }
    expect(await getCountedSignIn(await seeded({ ...required, SIGNIN_LINKS_OFF: 'twitter' }, record), 'twitter', 'jack', PUBKEY)).toBeNull()
    expect(await getCountedSignIn(await seeded({ ...required, SIGNIN_LINKS_OFF: 'tiktok' }, record), 'twitter', 'jack', PUBKEY)).not.toBeNull()
    expect(await getCountedSignIn(await seeded(required, record), 'twitter', 'jack', PUBKEY)).not.toBeNull()
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

  it('a link switched off and back on keeps its original 30 days', async () => {
    const at29 = { confirmed: true, checked_at: NOW - 29 * DAY }
    expect(await countsAt(required, at29)).toBe(true)
    expect(await countsAt({ ...required, SIGNIN_LINKS_OFF: 'tiktok' }, at29)).toBe(false)
    expect(await countsAt(required, { confirmed: true, checked_at: NOW - 31 * DAY })).toBe(false)
  })

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

  it('a confirmed Bluesky record with a DID does not count 400 days on', async () => {
    const { env, store } = createEnv(required)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), JSON.stringify({
      platform: 'bluesky', identity: HANDLE, pubkey: PUBKEY, verified: true, method: 'oauth',
      checked_at: NOW - 400 * DAY, account_id: DID, handle: HANDLE, confirmed: true,
    }))
    expect(await getCountedSignIn(env, 'bluesky', HANDLE, PUBKEY)).toBeNull()
  })
})

const GATE = { CONFIRMATION_ACCESS_URL: 'https://access.example.test/v1/entitlements', CONFIRMATION_ACCESS_TOKEN: 't' }

describe('marking sign-ins saved while the Confirmation gate is on', () => {
  it('marks both Bluesky records, handle and DID, when saved while on', async () => {
    const { env, store } = createEnv({ CONFIRMATION_GATE: 'on', ...GATE })
    await saveSignIn(env, PUBKEY, bluesky, CONFIRMATION)
    expect(read(store, 'bluesky', HANDLE).access_required).toBe(true)
    expect(read(store, 'bluesky', DID).access_required).toBe(true)
  })

  it.each([undefined, 'off', 'shadow'])('does not mark a record saved with the gate %j', async gate => {
    const { env, store } = createEnv({ ...(gate ? { CONFIRMATION_GATE: gate } : {}) } as Partial<Bindings>)
    await saveSignIn(env, PUBKEY, bluesky, CONFIRMATION)
    expect(read(store, 'bluesky', HANDLE).access_required).toBeUndefined()
    expect(read(store, 'bluesky', DID).access_required).toBeUndefined()
  })

  it('marks a record that was saved unmarked when it is saved again while on', async () => {
    const { env, store } = createEnv({ CONFIRMATION_GATE: 'on', ...GATE })
    store.set(oauthVerificationKey('twitter', 'jack', PUBKEY), JSON.stringify({
      platform: 'twitter', identity: 'jack', pubkey: PUBKEY, verified: true, method: 'oauth',
      checked_at: Math.floor(Date.now() / 1000), confirmed: true,
    }))
    await saveSignIn(env, PUBKEY, { platform: 'twitter', identity: 'jack' }, CONFIRMATION)
    expect(read(store, 'twitter', 'jack').access_required).toBe(true)
  })
})

describe('which marked records count', () => {
  const NOW = 1_800_000_000
  const DAY = 24 * 60 * 60
  let fetchMock: ReturnType<typeof vi.fn>
  const answer = (body: unknown, status = 200) => fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status }))

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW * 1000)
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function seeded(vars: Partial<Bindings>, extra: Record<string, unknown> = {}, ageDays = 0) {
    const made = createEnv({ ...GATE, ...vars })
    made.store.set(oauthVerificationKey('twitter', 'jack', PUBKEY), JSON.stringify({
      platform: 'twitter', identity: 'jack', pubkey: PUBKEY, verified: true, method: 'oauth',
      checked_at: NOW - ageDays * DAY, confirmed: true, ...extra,
    }))
    return made
  }
  const marked = { access_required: true }

  it('gate on: an unmarked record counts with no access fetch', async () => {
    const { env } = seeded({ CONFIRMATION_GATE: 'on' })
    expect(await getCountedSignIn(env, 'twitter', 'jack', PUBKEY)).not.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('gate on: a marked record counts when the owner has access', async () => {
    answer({ isActive: true })
    const { env } = seeded({ CONFIRMATION_GATE: 'on' }, marked)
    const standing = await signInStanding(env, 'twitter', 'jack', PUBKEY)
    expect(standing.counted).toMatchObject({ identity: 'jack' })
  })

  it('gate on: a marked record without access does not count, and says why', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    answer({ isActive: false })
    const { env } = seeded({ CONFIRMATION_GATE: 'on' }, marked)
    expect(await signInStanding(env, 'twitter', 'jack', PUBKEY)).toEqual({ counted: null, reason: 'needs_confirmation' })
    expect(await getCountedSignIn(env, 'twitter', 'jack', PUBKEY)).toBeNull()
  })

  it('gate on: a marked record counts when access is unavailable (fail open)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    answer({}, 500)
    const { env } = seeded({ CONFIRMATION_GATE: 'on' }, marked)
    expect((await signInStanding(env, 'twitter', 'jack', PUBKEY)).counted).not.toBeNull()
  })

  it('gate on: a marked record that stopped counting counts again once access returns, and the record was never deleted', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    answer({ isActive: false })
    const { env, store } = seeded({ CONFIRMATION_GATE: 'on' }, marked)
    expect(await signInStanding(env, 'twitter', 'jack', PUBKEY)).toEqual({ counted: null, reason: 'needs_confirmation' })
    expect(store.has(oauthVerificationKey('twitter', 'jack', PUBKEY))).toBe(true)
    // Stands in for the 60 s expiry of the cached "no", which confirmation-access.test.ts pins.
    store.delete(confirmationAccessKey(PUBKEY))
    answer({ isActive: true })
    expect((await signInStanding(env, 'twitter', 'jack', PUBKEY)).counted).not.toBeNull()
  })

  it.each(['off', 'shadow'])('gate %s: a marked record counts without an access fetch', async gate => {
    const { env } = seeded({ CONFIRMATION_GATE: gate } as Partial<Bindings>, marked)
    expect((await signInStanding(env, 'twitter', 'jack', PUBKEY)).counted).not.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('gate on: a marked record past its 30 days answers none, without an access fetch', async () => {
    const { env } = seeded({ CONFIRMATION_GATE: 'on' }, marked, 31)
    expect(await signInStanding(env, 'twitter', 'jack', PUBKEY)).toEqual({ counted: null, reason: 'none' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers none when there is no record', async () => {
    const { env } = createEnv({ CONFIRMATION_GATE: 'on', ...GATE })
    expect(await signInStanding(env, 'twitter', 'nobody', PUBKEY)).toEqual({ counted: null, reason: 'none' })
  })

  it('gate on: a marked Bluesky DID record without access does not count either', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { env } = createEnv({ CONFIRMATION_GATE: 'on', ...GATE })
    await saveSignIn(env, PUBKEY, bluesky, CONFIRMATION)
    answer({ isActive: false })
    expect(await signInStanding(env, 'bluesky', DID, PUBKEY)).toEqual({ counted: null, reason: 'needs_confirmation' })
  })

  it('logs a refused or unavailable check at verify with platform and mode, never the pubkey or identity', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    answer({ isActive: false })
    const { env, store } = seeded({ CONFIRMATION_GATE: 'on' }, marked)
    await signInStanding(env, 'twitter', 'jack', PUBKEY)
    store.delete(confirmationAccessKey(PUBKEY))
    answer({}, 500)
    await signInStanding(env, 'twitter', 'jack', PUBKEY)
    const lines = info.mock.calls.map(c => c.join(' '))
    expect(lines).toEqual([
      'twitter confirmation check at verify (on): no',
      'twitter confirmation check at verify (on): unavailable',
    ])
    for (const line of lines) {
      expect(line).not.toContain(PUBKEY)
      expect(line).not.toContain('jack')
    }
  })
})
