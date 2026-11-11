// ABOUTME: Tests that a YouTube sign-in link counts only while the handle it names
// ABOUTME: still belongs to the channel that signed in (#173), checked when the badge is viewed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import type { Bindings } from '../types'
import { oauthVerificationKey } from './state'
import { saveSignIn } from './signin-records'

const PUBKEY = 'ab'.repeat(32)
const HANDLE = '@alice'
const CHANNEL = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_CHANNEL = 'UCbbbbbbbbbbbbbbbbbbbbbb'
const CHANGED = 'This handle no longer points to the account that signed in, so the link no longer counts.'

type Answer = { verified: boolean, method?: string, error?: string, code?: string }

function createEnv(vars: Partial<Bindings> = {}) {
  const store = new Map<string, string>()
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: { expirationTtl?: number }) => { store.set(key, value) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
  }
  const rateLimit = { get: vi.fn(async () => null), put: vi.fn(async () => {}) }
  const env = {
    CACHE_KV: kv, RATE_LIMIT_KV: rateLimit, SIGNIN_CONFIRMATION: 'required', YOUTUBE_API_KEY: 'test-key', ...vars,
  } as unknown as Bindings
  return { env, store, kv }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// YouTube's channels.list?forHandle= answering per handle (without the @):
// a channel id, 'not-found' (200 with no items), or a whole Response.
function handleLookup(answers: Record<string, string | Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (!url.href.startsWith('https://www.googleapis.com/youtube/v3/channels')) throw new Error(`unexpected fetch ${url.href}`)
    const name = (url.searchParams.get('forHandle') ?? '').replace(/^@/, '')
    const answer = answers[name]
    if (answer instanceof Response) return answer
    if (answer === undefined || answer === 'not-found') return json({ kind: 'youtube#channelListResponse', pageInfo: { totalResults: 0 } })
    return json({ items: [{ id: answer }] })
  })
}

function storeRecord(store: Map<string, string>, identity: string, accountId?: string) {
  store.set(oauthVerificationKey('youtube', identity, PUBKEY), JSON.stringify({
    platform: 'youtube', identity, pubkey: PUBKEY, verified: true, method: 'oauth',
    checked_at: Math.floor(Date.now() / 1000), confirmed: true, ...(accountId ? { account_id: accountId } : {}),
  }))
}

async function check(env: Bindings, identity = HANDLE): Promise<Answer> {
  const res = await worker.fetch(new Request('https://verifier.divine.video/verify/single', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'youtube', identity, proof: 'oauth', pubkey: PUBKEY }),
  }), env)
  return await res.json() as Answer
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('checking a YouTube sign-in link claimed by handle', () => {
  it('verifies while the handle still belongs to the channel that signed in', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', handleLookup({ alice: CHANNEL }))
    storeRecord(store, HANDLE, CHANNEL)
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
  })

  it('stops verifying when the handle now belongs to a different channel', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', handleLookup({ alice: OTHER_CHANNEL }))
    storeRecord(store, HANDLE, CHANNEL)
    expect(await check(env)).toMatchObject({ verified: false, code: 'signin_account_changed', error: CHANGED })
  })

  it('stops verifying when YouTube finds no channel with the handle', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', handleLookup({ alice: 'not-found' }))
    storeRecord(store, HANDLE, CHANNEL)
    expect(await check(env)).toMatchObject({ verified: false, code: 'signin_account_changed' })
  })

  it('accepts the handle with A to Z in other letter case, looking up the handle as sign-in saved it', async () => {
    const { env, store } = createEnv()
    const lookup = handleLookup({ alice: CHANNEL })
    vi.stubGlobal('fetch', lookup)
    storeRecord(store, HANDLE, CHANNEL)
    expect(await check(env, '@Alice')).toMatchObject({ verified: true, method: 'oauth' })
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(new URL(String(lookup.mock.calls[0][0])).searchParams.get('forHandle')).toBe('@alice')
  })

  it('looks the linked handle up once a day, however many spellings of it are claimed', async () => {
    const { env, store } = createEnv()
    const lookup = handleLookup({ alice: CHANNEL })
    vi.stubGlobal('fetch', lookup)
    storeRecord(store, HANDLE, CHANNEL)
    for (const spelling of ['@alice', '@Alice', '@ALICE', '@aLiCe']) {
      expect(await check(env, spelling)).toMatchObject({ verified: true, method: 'oauth' })
    }
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('looks the handle up once and reuses the answer', async () => {
    const { env, store } = createEnv()
    const lookup = handleLookup({ alice: CHANNEL })
    vi.stubGlobal('fetch', lookup)
    storeRecord(store, HANDLE, CHANNEL)
    await check(env)
    await check(env)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('reuses an earlier answer that the handle belongs to a different channel', async () => {
    const { env, store } = createEnv()
    const lookup = handleLookup({})
    vi.stubGlobal('fetch', lookup)
    store.set('yt_handle_channel:alice', OTHER_CHANNEL)
    storeRecord(store, HANDLE, CHANNEL)
    expect(await check(env)).toMatchObject({ verified: false, code: 'signin_account_changed' })
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('a YouTube sign-in link keeps counting when YouTube cannot be asked', () => {
  it.each([
    ['the request fails', () => { throw new Error('network down') }],
    ['the daily quota is used up', () => json({ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }, 403)],
    ['YouTube answers with a server error', () => new Response('upstream error', { status: 500 })],
    ['the answer is not JSON', () => new Response('<html>', { status: 200 })],
    ['the answer names no usable channel', () => json({ items: [{ id: 'not-a-channel' }] })],
  ] as const)('when %s', async (_label, answer) => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', vi.fn(async () => answer()))
    storeRecord(store, HANDLE, CHANNEL)
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
  })

  it('when no YouTube API key is set, without asking', async () => {
    const { env, store } = createEnv({ YOUTUBE_API_KEY: undefined })
    const lookup = handleLookup({ alice: OTHER_CHANNEL })
    vi.stubGlobal('fetch', lookup)
    storeRecord(store, HANDLE, CHANNEL)
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('when the record was saved without the channel id, without asking', async () => {
    const { env, store } = createEnv()
    const lookup = handleLookup({ alice: OTHER_CHANNEL })
    vi.stubGlobal('fetch', lookup)
    storeRecord(store, HANDLE)
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('checking a YouTube sign-in link claimed by channel id', () => {
  it('verifies the linked channel id without a lookup', async () => {
    const { env, store } = createEnv()
    const lookup = handleLookup({})
    vi.stubGlobal('fetch', lookup)
    storeRecord(store, CHANNEL, CHANNEL)
    expect(await check(env, CHANNEL)).toMatchObject({ verified: true, method: 'oauth' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('does not verify a channel id that differs from the linked one only in letter case', async () => {
    // Channel ids are case-sensitive, but sign-in records are found by the
    // lowercased identity, so this claim reaches the record for CHANNEL.
    const { env, store } = createEnv()
    const lookup = handleLookup({})
    vi.stubGlobal('fetch', lookup)
    storeRecord(store, CHANNEL, CHANNEL)
    const sameKey = 'UCaaaaaaaaaaaaaaaaaaaaaA'
    expect(await check(env, sameKey)).toMatchObject({ verified: false, code: 'signin_account_changed' })
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('checking a YouTube sign-in link claimed by a spelling that differs beyond A to Z case', () => {
  // Sign-in records are found by the fully lowercased identity, so these
  // claims reach the record, but none is the handle as sign-in saved it.
  it('does not verify a look-alike handle, without a lookup', async () => {
    const { env, store } = createEnv()
    // U+212A KELVIN SIGN lowercases to an ASCII k, so this claim reaches the
    // record for @kate, though YouTube may treat it as a different handle.
    const lookup = handleLookup({ kate: CHANNEL })
    vi.stubGlobal('fetch', lookup)
    storeRecord(store, '@kate', CHANNEL)
    expect(await check(env, '@Kate')).toMatchObject({ verified: false, code: 'signin_account_changed' })
    expect(lookup).not.toHaveBeenCalled()
    expect(await check(env, '@kate')).toMatchObject({ verified: true, method: 'oauth' })
  })

  it('does not verify other letter case outside A to Z, without a lookup', async () => {
    const { env, store } = createEnv()
    const lookup = handleLookup({ 'élodie': CHANNEL })
    vi.stubGlobal('fetch', lookup)
    storeRecord(store, '@élodie', CHANNEL)
    for (const spelling of ['@Élodie', '@ÉLODIE']) {
      expect(await check(env, spelling)).toMatchObject({ verified: false, code: 'signin_account_changed' })
    }
    expect(lookup).not.toHaveBeenCalled()
    // Only A to Z differ here, so this is the saved handle.
    expect(await check(env, '@éLODIE')).toMatchObject({ verified: true, method: 'oauth' })
    expect(await check(env, '@élodie')).toMatchObject({ verified: true, method: 'oauth' })
    expect(lookup).toHaveBeenCalledTimes(1)
  })
})

describe('checking a YouTube sign-in link claimed by something that is neither a handle nor a channel id', () => {
  it('does not verify it, without a lookup', async () => {
    // Sign-in saves only handles and channel ids, so a record under any other
    // text is not one it made for this claim.
    const { env, store } = createEnv()
    const lookup = vi.fn(async () => json({ items: [{ id: CHANNEL }] }))
    vi.stubGlobal('fetch', lookup)
    storeRecord(store, 'creator!', CHANNEL)
    expect(await check(env, 'creator!')).toMatchObject({ verified: false, code: 'signin_account_changed' })
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('signing in to YouTube', () => {
  const OLD_CHANNEL = 'UCcccccccccccccccccccccc'
  const confirmation = { event_id: 'e'.repeat(64), created_at: 1 }

  it.each([
    ['a confirmed sign-in', confirmation],
    ['a sign-in saved before confirmation', null],
  ] as const)('%s forgets an earlier lookup of the handle', async (_label, confirmedBy) => {
    const { env, store } = createEnv()
    store.set('yt_handle_channel:alice', OLD_CHANNEL)
    await saveSignIn(env, PUBKEY, { platform: 'youtube', identity: HANDLE, account_id: CHANNEL }, confirmedBy)
    expect(store.has('yt_handle_channel:alice')).toBe(false)
    expect(store.has(oauthVerificationKey('youtube', HANDLE, PUBKEY))).toBe(true)
  })

  it('counts a handle newly taken by the channel signing in, though a day-old lookup named its previous channel', async () => {
    const { env, store } = createEnv()
    store.set('yt_handle_channel:alice', OLD_CHANNEL)
    vi.stubGlobal('fetch', handleLookup({ alice: CHANNEL }))
    await saveSignIn(env, PUBKEY, { platform: 'youtube', identity: HANDLE, account_id: CHANNEL }, confirmation)
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
  })

  it('still saves the sign-in when the earlier lookup can\'t be forgotten', async () => {
    const { env, store, kv } = createEnv()
    store.set('yt_handle_channel:alice', OLD_CHANNEL)
    kv.delete.mockImplementation(async (key: string) => {
      if (key.startsWith('yt_handle_channel:')) throw new Error('KV DELETE failed')
      store.delete(key)
    })
    await saveSignIn(env, PUBKEY, { platform: 'youtube', identity: HANDLE, account_id: CHANNEL }, confirmation)
    expect(store.has(oauthVerificationKey('youtube', HANDLE, PUBKEY))).toBe(true)
  })

  it('forgets nothing for a sign-in named by its channel id', async () => {
    const { env, kv } = createEnv()
    await saveSignIn(env, PUBKEY, { platform: 'youtube', identity: CHANNEL, account_id: CHANNEL }, confirmation)
    expect(kv.delete.mock.calls.filter(([key]) => key.startsWith('yt_handle_channel:'))).toEqual([])
  })
})

describe('GET /auth/youtube/status', () => {
  async function status(env: Bindings, identity: string) {
    const res = await worker.fetch(new Request(`https://verifier.divine.video/auth/youtube/status?pubkey=${PUBKEY}&identity=${encodeURIComponent(identity)}`), env)
    return await res.json() as { verified: boolean }
  }

  it('answers verified while the handle belongs to the linked channel', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', handleLookup({ alice: CHANNEL }))
    storeRecord(store, HANDLE, CHANNEL)
    expect((await status(env, HANDLE)).verified).toBe(true)
  })

  it('answers not verified once the handle belongs to a different channel', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', handleLookup({ alice: OTHER_CHANNEL }))
    storeRecord(store, HANDLE, CHANNEL)
    expect((await status(env, HANDLE)).verified).toBe(false)
  })
})
