import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import type { Bindings, CachedResult } from '../types'
import { cacheKey } from '../utils/cache'
import { oauthVerificationKey, storeOAuthVerification } from './state'
import { handleBlueskyCallback } from './bluesky'
import { generateDPoPKeyPair } from './crypto'
import { blueskyAccountAnswer } from '../test-support/bluesky-account'

// An account linked by signing in to Bluesky, once its owner confirms it
// (#113), stays verified for 30 days, or until it is unlinked (#58).
// A Bluesky link is tied to the account's DID, so a handle that now points
// somewhere else stops verifying.

const PUBKEY = 'ab'.repeat(32)
const HANDLE = 'alice.bsky.social'
const DID = 'did:plc:alice2222222222222222222'
const OTHER_DID = 'did:plc:other2222222222222222222'
const OTHER_PDS = 'https://pds.other.test'

function createEnv() {
  const store = new Map<string, string>()
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: { expirationTtl?: number }) => { store.set(key, value) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
  }
  const rateLimit = { get: vi.fn(async () => null), put: vi.fn(async () => {}) }
  const env = { CACHE_KV: kv, RATE_LIMIT_KV: rateLimit, OAUTH_REDIRECT_BASE: 'https://verifier.divine.video' } as unknown as Bindings
  return { env, store, kv }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Bluesky's handle lookup answering with `did`, a 400 (no such handle), or a network failure.
function handleLookup(answer: string | 'not-found' | 'unreachable') {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).includes('com.atproto.identity.resolveHandle')) throw new Error(`unexpected fetch ${String(input)}`)
    if (answer === 'unreachable') throw new Error('network down')
    if (answer === 'not-found') return json({ error: 'InvalidRequest', message: 'Unable to resolve handle' }, 400)
    return json({ did: answer })
  })
}

// The handle lookup plus, for DID, the account host's answers (PLC and getRepoStatus). `account`
// is what the host says; 'unreachable' makes both of its requests fail. A sign-in that no longer
// matches is then checked for an identity-link record on the account the claim names now, and
// finds none: OTHER_DID's server lists no records, and no other DID has a PLC entry.
function bluesky(handleAnswer: string | 'not-found' | 'unreachable', account: { active?: boolean, status?: string } | 'unreachable' | 'tombstone' = {}) {
  const lookup = handleLookup(handleAnswer)
  const fetched: string[] = []
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    fetched.push(url)
    if (url.includes('com.atproto.identity.resolveHandle')) return lookup(input)
    if (account === 'unreachable') throw new Error('network down')
    if (account === 'tombstone' && url.startsWith('https://plc.directory/')) return new Response('', { status: 410 })
    const answer = blueskyAccountAnswer(url, DID, account === 'tombstone' ? {} : account)
    if (answer) return answer
    if (url === `https://plc.directory/${OTHER_DID}`) return json({ id: OTHER_DID, service: [{ id: '#atproto_pds', serviceEndpoint: OTHER_PDS }] })
    if (url.startsWith('https://plc.directory/')) return new Response('', { status: 404 })
    if (url.includes('com.atproto.repo.listRecords')) return json({ records: [] })
    throw new Error(`unexpected fetch ${url}`)
  })
  return { mock, fetched }
}

// The per-pubkey and per-platform check units a request reserved (keys naming the pubkey).
const spentUnits = (env: Bindings) => (env.RATE_LIMIT_KV.put as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0])).filter(k => k.includes(PUBKEY))

// Whether the check for other evidence asked OTHER_DID's server for its identity-link records.
const checkedOtherAccount = (fetched: string[]) => fetched.some(u => u.startsWith(`${OTHER_PDS}/xrpc/com.atproto.repo.listRecords`) && u.includes(encodeURIComponent(OTHER_DID)))

const INACTIVE = 'The account that signed in is no longer active on Bluesky, so the link no longer counts.'
const asksAccountHost = (fetched: string[]) => fetched.some(u => u.includes('com.atproto.sync.getRepoStatus'))

function signInRecord(identity: string, accountId?: string) {
  return JSON.stringify({ platform: 'bluesky', identity, pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: Math.floor(Date.now() / 1000), ...(accountId ? { account_id: accountId } : {}) })
}

async function check(env: Bindings, identity = HANDLE) {
  const res = await worker.fetch(new Request('https://verifier.divine.video/verify/single', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'bluesky', identity, proof: 'oauth', pubkey: PUBKEY }),
  }), env)
  return await res.json() as { verified: boolean, method?: string, error?: string, cached?: boolean }
}

afterEach(() => vi.unstubAllGlobals())

describe('how long a sign-in record lasts', () => {
  it('keeps a confirmed Bluesky sign-in for 30 days', async () => {
    const { kv } = createEnv()
    await storeOAuthVerification(kv as unknown as KVNamespace, { platform: 'bluesky', identity: HANDLE, pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: 1, account_id: DID, confirmed: true })
    expect(kv.put.mock.calls[0][2]).toEqual({ expirationTtl: 2592000 })
  })

  it('keeps an unconfirmed Bluesky sign-in for a day', async () => {
    const { kv } = createEnv()
    await storeOAuthVerification(kv as unknown as KVNamespace, { platform: 'bluesky', identity: HANDLE, pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: 1, account_id: DID })
    expect(kv.put.mock.calls[0][2]).toEqual({ expirationTtl: 86400 })
  })

  it('keeps an unconfirmed Bluesky sign-in saved without its account for a day', async () => {
    const { kv } = createEnv()
    await storeOAuthVerification(kv as unknown as KVNamespace, { platform: 'bluesky', identity: HANDLE, pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: 1 })
    expect(kv.put.mock.calls[0][2]).toEqual({ expirationTtl: 86400 })
  })

  it.each(['twitter', 'youtube', 'tiktok'] as const)('keeps an unconfirmed %s sign-in for a day, even with an account ID', async platform => {
    const { kv } = createEnv()
    await storeOAuthVerification(kv as unknown as KVNamespace, { platform, identity: 'alice', pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: 1, account_id: 'acct-1' })
    expect(kv.put.mock.calls[0][2]).toEqual({ expirationTtl: 86400 })
  })
})

describe('checking a Bluesky sign-in link', () => {
  it('answers from the sign-in record before an earlier cached failure', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', handleLookup(DID))
    const failed: CachedResult = { verified: false, error: 'Bluesky post not found', checked_at: 1, type: 'failed' }
    store.set(cacheKey('bluesky', HANDLE, 'oauth', PUBKEY), JSON.stringify(failed))
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
  })

  it('verifies while the handle still points to the linked account', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', bluesky(DID).mock)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
  })

  it('stops verifying when the handle now points to a different account', async () => {
    const { env, store } = createEnv()
    const { mock, fetched } = bluesky(OTHER_DID)
    vi.stubGlobal('fetch', mock)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    const result = await check(env)
    expect(result.verified).toBe(false)
    expect(result.error).toBe('This handle no longer points to the account that signed in, so the link no longer counts.')
    expect(checkedOtherAccount(fetched)).toBe(true)
  })

  it('stops verifying when the handle no longer exists, without a check for other evidence', async () => {
    const { env, store } = createEnv()
    const { mock, fetched } = bluesky('not-found')
    vi.stubGlobal('fetch', mock)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    const result = await check(env)
    expect(result).toMatchObject({ verified: false, code: 'signin_account_changed' })
    expect(result.error).toBe('This handle no longer points to the account that signed in, so the link no longer counts.')
    // A handle that resolves to no account has no proof post or identity-link
    // record a check could find, so none is made and no unit is spent.
    expect(fetched.filter(u => u.includes('resolveHandle'))).toHaveLength(1)
    expect(fetched.some(u => u.includes('com.atproto.repo.listRecords'))).toBe(false)
    expect(spentUnits(env)).toEqual([])
  })

  it('trusts the record when Bluesky cannot be reached', async () => {
    const { env, store } = createEnv()
    // The account host, asked alongside the handle lookup, would say inactive,
    // but an outage on the handle lookup keeps the link counting whatever the
    // host says, and makes no check for other evidence.
    const { mock, fetched } = bluesky('unreachable', { active: false, status: 'deactivated' })
    vi.stubGlobal('fetch', mock)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    expect(fetched.some(u => u.includes('com.atproto.repo.listRecords'))).toBe(false)
  })

  it('asks the account host, not the handle lookup, for a claim made with the DID itself', async () => {
    const { env, store } = createEnv()
    const { mock, fetched } = bluesky(OTHER_DID)
    vi.stubGlobal('fetch', mock)
    store.set(oauthVerificationKey('bluesky', DID, PUBKEY), signInRecord(DID, DID))
    expect(await check(env, DID)).toMatchObject({ verified: true, method: 'oauth' })
    expect(fetched.some(u => u.includes('resolveHandle'))).toBe(false)
    expect(asksAccountHost(fetched)).toBe(true)
  })

  it.each(['deactivated', 'deleted', 'takendown'])('stops verifying a DID claim once the account is %s', async status => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', bluesky(OTHER_DID, { active: false, status }).mock)
    store.set(oauthVerificationKey('bluesky', DID, PUBKEY), signInRecord(DID, DID))
    expect(await check(env, DID)).toMatchObject({ verified: false, code: 'signin_account_changed', error: INACTIVE })
  })

  it('stops verifying a DID claim once the DID is tombstoned', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', bluesky(OTHER_DID, 'tombstone').mock)
    store.set(oauthVerificationKey('bluesky', DID, PUBKEY), signInRecord(DID, DID))
    expect(await check(env, DID)).toMatchObject({ verified: false, code: 'signin_account_changed', error: INACTIVE })
  })

  it('keeps a DID claim counting while the account host cannot be reached', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', bluesky(OTHER_DID, 'unreachable').mock)
    store.set(oauthVerificationKey('bluesky', DID, PUBKEY), signInRecord(DID, DID))
    expect(await check(env, DID)).toMatchObject({ verified: true, method: 'oauth' })
  })

  it('stops verifying a handle claim whose handle still points to the account, once the account is deactivated', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', bluesky(DID, { active: false, status: 'deactivated' }).mock)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    expect(await check(env)).toMatchObject({ verified: false, code: 'signin_account_changed', error: INACTIVE })
  })

  it('asks Bluesky for the handle and the account host for its status at the same time', async () => {
    vi.useFakeTimers()
    try {
      const { env, store } = createEnv()
      // Every request takes a second: the handle lookup, then PLC and the PDS for the status.
      const { mock } = bluesky(DID, { active: false, status: 'deactivated' })
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => new Promise<Response>((resolve, reject) => setTimeout(() => mock(input).then(resolve, reject), 1_000))))
      store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
      let settled = false
      const answer = check(env).finally(() => { settled = true })
      // Two seconds: the status lookup's two requests, with the handle lookup alongside them.
      await vi.advanceTimersByTimeAsync(2_000)
      expect(settled).toBe(true)
      expect(await answer).toMatchObject({ verified: false, code: 'signin_account_changed', error: INACTIVE })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a handle claim counting while the account host cannot be reached', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', bluesky(DID, 'unreachable').mock)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
  })

  it('answers that the handle moved, not the account host\'s answer, when the handle points elsewhere', async () => {
    const { env, store } = createEnv()
    // The host, asked alongside the handle lookup, says the signed-in account is inactive.
    const { mock, fetched } = bluesky(OTHER_DID, { active: false })
    vi.stubGlobal('fetch', mock)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    expect(await check(env)).toMatchObject({ verified: false, code: 'signin_account_changed', error: 'This handle no longer points to the account that signed in, so the link no longer counts.' })
    expect(checkedOtherAccount(fetched)).toBe(true)
  })

  it('accepts the linked DID written in capitals', async () => {
    const { env, store } = createEnv()
    const { mock, fetched } = bluesky(OTHER_DID)
    vi.stubGlobal('fetch', mock)
    store.set(oauthVerificationKey('bluesky', DID, PUBKEY), signInRecord(DID, DID))
    expect(await check(env, DID.toUpperCase())).toMatchObject({ verified: true, method: 'oauth' })
    expect(fetched.some(u => u.includes('resolveHandle'))).toBe(false)
  })

  it('trusts the record when Bluesky answers without an account, and asks again next time', async () => {
    const { env, store } = createEnv()
    const lookup = vi.fn(async (_input: RequestInfo | URL) => json({ did: 'not-an-account' }))
    vi.stubGlobal('fetch', lookup)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    await check(env)
    expect(lookup.mock.calls.filter(([input]) => String(input).includes('resolveHandle'))).toHaveLength(2)
  })

  it('looks the handle up once and reuses the answer', async () => {
    const { env, store } = createEnv()
    const { mock, fetched } = bluesky(DID)
    vi.stubGlobal('fetch', mock)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    await check(env)
    await check(env)
    expect(fetched.filter(u => u.includes('resolveHandle'))).toHaveLength(1)
  })
})

describe('checking a Bluesky sign-in link claimed by DID', () => {
  it('does not verify a DID the sign-in was not for', async () => {
    const { env, store } = createEnv()
    const { mock, fetched } = bluesky(DID)
    vi.stubGlobal('fetch', mock)
    store.set(oauthVerificationKey('bluesky', OTHER_DID, PUBKEY), signInRecord(OTHER_DID, DID))
    expect(await check(env, OTHER_DID)).toMatchObject({ verified: false, code: 'signin_account_changed' })
    expect(checkedOtherAccount(fetched)).toBe(true)
  })

  it('does not let a look-alike DID match the linked one', async () => {
    const { env, store } = createEnv()
    const kDid = 'did:plc:kkkk11111111111111111111'
    vi.stubGlobal('fetch', handleLookup(kDid))
    store.set(oauthVerificationKey('bluesky', kDid, PUBKEY), signInRecord(kDid, kDid))
    // U+212A KELVIN SIGN lowercases to an ASCII k
    expect(await check(env, 'did:plc:\u212Akkk11111111111111111111')).toMatchObject({ verified: false, code: 'signin_account_changed' })
    // Answered at once: nothing fetched, no check unit spent.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    expect(spentUnits(env)).toEqual([])
    expect(await check(env, kDid)).toMatchObject({ verified: true, method: 'oauth' })
  })
})

describe('checking a Bluesky sign-in link with an unusual handle', () => {
  it('does not let a look-alike handle change the answer for the real one', async () => {
    const { env, store } = createEnv()
    const { mock, fetched } = bluesky(DID)
    vi.stubGlobal('fetch', mock)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    // U+212A KELVIN SIGN lowercases to an ASCII k
    const lookAlike = 'alice.bs\u212Ay.social'
    expect(await check(env, lookAlike)).toMatchObject({ verified: false, code: 'signin_account_changed' })
    // Answered at once: nothing fetched or remembered, no check unit spent.
    expect(fetched).toEqual([])
    expect(spentUnits(env)).toEqual([])
    expect([...store.keys()].filter(k => !k.startsWith('oauth'))).toEqual([])
    expect(store.has(`bsky_handle_did:${HANDLE}`)).toBe(false)
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
  })
})

describe('an account host that cannot answer', () => {
  it('is asked once for two checks and a status request naming the same account', async () => {
    const { env, store, kv } = createEnv()
    const outage = vi.fn(async (_input: RequestInfo | URL) => new Response('upstream error', { status: 502 }))
    vi.stubGlobal('fetch', outage)
    store.set(oauthVerificationKey('bluesky', DID, PUBKEY), signInRecord(DID, DID))
    expect(await check(env, DID)).toMatchObject({ verified: true, method: 'oauth' })
    expect(await check(env, DID)).toMatchObject({ verified: true, method: 'oauth' })
    const status = await worker.fetch(new Request(`https://verifier.divine.video/auth/bluesky/status?pubkey=${PUBKEY}&identity=${DID}`), env)
    expect(await status.json()).toMatchObject({ verified: true, method: 'oauth' })
    expect(outage.mock.calls.filter(([input]) => String(input).startsWith('https://plc.directory/'))).toHaveLength(1)
    // Remembered for Cloudflare KV's shortest lifetime, under a value of its own.
    expect(kv.put.mock.calls.find(c => c[0] === `bsky_account_status:${DID}`)?.slice(1)).toEqual(['unknown', { expirationTtl: 60 }])
  })
})

describe('remembering a handle lookup', () => {
  it('remembers a handle that does not resolve only briefly', async () => {
    const { env, store, kv } = createEnv()
    vi.stubGlobal('fetch', handleLookup('not-found'))
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    await check(env)
    expect(kv.put.mock.calls.find(c => c[0] === `bsky_handle_did:${HANDLE}`)?.[2]).toEqual({ expirationTtl: 300 })
  })

  it('does not remember a lookup Bluesky could not answer', async () => {
    const { env, store } = createEnv()
    const lookup = vi.fn(async (_input: RequestInfo | URL) => new Response('upstream error', { status: 502 }))
    vi.stubGlobal('fetch', lookup)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    await check(env)
    await check(env)
    expect(lookup.mock.calls.filter(([input]) => String(input).includes('resolveHandle'))).toHaveLength(2)
  })

  it.each([
    ['still points to the account', DID, true],
    ['no longer exists', 'not-found', false],
  ] as const)('answers when the lookup cannot be saved and the handle %s', async (_label, answer, verified) => {
    const { env, store, kv } = createEnv()
    vi.stubGlobal('fetch', handleLookup(answer))
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    kv.put.mockImplementation(async (key: string, value: string) => {
      if (key.startsWith('bsky_handle_did:')) throw new Error('KV PUT failed: 429 Too Many Requests')
      store.set(key, value)
    })
    expect((await check(env)).verified).toBe(verified)
  })
})

describe('finishing a Bluesky sign-in', () => {
  it('records the account DID and writes nothing to the Bluesky account', async () => {
    const { env, store, kv } = createEnv()
    const { publicJwk, privateJwk } = await generateDPoPKeyPair()
    store.set('oauth_state:s1', JSON.stringify({
      platform: 'bluesky', pubkey: PUBKEY, codeVerifier: 'v', returnUrl: 'https://verifier.divine.video/', createdAt: Date.now(),
      dpopPrivateJwk: privateJwk, dpopPublicJwk: publicJwk, issuer: 'https://bsky.social', tokenEndpoint: 'https://bsky.social/oauth/token',
      did: DID, handle: HANDLE,
    }))
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://bsky.social/oauth/token') return json({ sub: DID, access_token: 'token' })
      if (url === `https://plc.directory/${DID}`) {
        return json({ alsoKnownAs: [`at://${HANDLE}`], service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.example.com' }] })
      }
      if (url === 'https://pds.example.com/.well-known/oauth-protected-resource') return json({ authorization_servers: ['https://bsky.social'] })
      return json({ uri: 'at://x/y/z' })
    }))
    const result = await handleBlueskyCallback(env, 'code', 's1', 'https://bsky.social')
    expect(result).toMatchObject({ success: true, identity: HANDLE })
    expect(requests.some(u => u.includes('/xrpc/com.atproto.repo.'))).toBe(false)
    const saved = JSON.parse(store.get(oauthVerificationKey('bluesky', HANDLE, PUBKEY)) ?? '{}')
    expect(saved.account_id).toBe(DID)
    expect(saved.handle).toBe(HANDLE)
    const savedByDid = JSON.parse(store.get(oauthVerificationKey('bluesky', DID, PUBKEY)) ?? '{}')
    expect(savedByDid.handle).toBe(HANDLE)
    for (const identity of [HANDLE, DID]) {
      // Unconfirmed until the owner confirms it (#113).
      expect(kv.put.mock.calls.find(c => c[0] === oauthVerificationKey('bluesky', identity, PUBKEY))?.[2]).toEqual({ expirationTtl: 86400 })
    }
  })

  it('saves the sign-in after a DPoP nonce retry on the token exchange', async () => {
    const { env, store } = createEnv()
    const { publicJwk, privateJwk } = await generateDPoPKeyPair()
    store.set('oauth_state:s1', JSON.stringify({
      platform: 'bluesky', pubkey: PUBKEY, codeVerifier: 'v', returnUrl: 'https://verifier.divine.video/', createdAt: Date.now(),
      dpopPrivateJwk: privateJwk, dpopPublicJwk: publicJwk, issuer: 'https://bsky.social', tokenEndpoint: 'https://bsky.social/oauth/token',
      did: DID, handle: HANDLE,
    }))
    let tokenCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://bsky.social/oauth/token') {
        tokenCalls++
        // First call: the auth server demands a DPoP nonce. Second call (the
        // retry, with the nonce included): succeeds.
        if (tokenCalls === 1) {
          return new Response(JSON.stringify({ error: 'use_dpop_nonce' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'DPoP-Nonce': 'server-nonce' },
          })
        }
        return json({ sub: DID, access_token: 'token' })
      }
      if (url === `https://plc.directory/${DID}`) {
        return json({ alsoKnownAs: [`at://${HANDLE}`], service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.example.com' }] })
      }
      if (url === 'https://pds.example.com/.well-known/oauth-protected-resource') return json({ authorization_servers: ['https://bsky.social'] })
      return json({ uri: 'at://x/y/z' })
    }))
    const result = await handleBlueskyCallback(env, 'code', 's1', 'https://bsky.social')
    expect(tokenCalls).toBe(2)
    expect(result).toMatchObject({ success: true, identity: HANDLE })
    expect(store.has(oauthVerificationKey('bluesky', HANDLE, PUBKEY))).toBe(true)
    expect(store.has(oauthVerificationKey('bluesky', DID, PUBKEY))).toBe(true)
  })
})

// A sign-in that started as `startedAs` (the account the person entered) and
// comes back from Bluesky as DID, with `handle` on DID's document.
async function signIn(
  env: Bindings,
  store: Map<string, string>,
  { handle = HANDLE, didDocument = true, startedAs }: { handle?: string, didDocument?: boolean, startedAs?: { did: string, handle: string } } = {},
) {
  const started = startedAs ?? { did: DID, handle }
  const { publicJwk, privateJwk } = await generateDPoPKeyPair()
  store.set('oauth_state:s2', JSON.stringify({
    platform: 'bluesky', pubkey: PUBKEY, codeVerifier: 'v', returnUrl: 'https://verifier.divine.video/', createdAt: Date.now(),
    dpopPrivateJwk: privateJwk, dpopPublicJwk: publicJwk, issuer: 'https://bsky.social', tokenEndpoint: 'https://bsky.social/oauth/token',
    did: started.did, handle: started.handle,
  }))
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === 'https://bsky.social/oauth/token') return json({ sub: DID, access_token: 'token' })
    if (url === `https://plc.directory/${DID}`) {
      if (!didDocument) return json({ error: 'unavailable' }, 503)
      return json({ alsoKnownAs: [`at://${handle}`], service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.example.com' }] })
    }
    if (url === 'https://pds.example.com/.well-known/oauth-protected-resource') return json({ authorization_servers: ['https://bsky.social'] })
    throw new Error(`unexpected fetch ${url}`)
  }))
  return handleBlueskyCallback(env, 'code', 's2', 'https://bsky.social')
}

function linkRecord(identity: string, accountId: string, handle: string) {
  return JSON.stringify({ platform: 'bluesky', identity, pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: 1, account_id: accountId, handle })
}

describe('signing in to Bluesky again', () => {
  const OLD = 'old.bsky.social'

  it('forgets an earlier lookup of the handle', async () => {
    const { env, store } = createEnv()
    store.set(`bsky_handle_did:${HANDLE}`, OTHER_DID)
    expect(await signIn(env, store)).toMatchObject({ success: true })
    expect(store.has(`bsky_handle_did:${HANDLE}`)).toBe(false)
  })

  it('removes the record left under the account\'s previous handle', async () => {
    const { env, store } = createEnv()
    store.set(oauthVerificationKey('bluesky', OLD, PUBKEY), linkRecord(OLD, DID, OLD))
    store.set(oauthVerificationKey('bluesky', DID, PUBKEY), linkRecord(DID, DID, OLD))
    expect(await signIn(env, store)).toMatchObject({ success: true })
    expect(store.has(oauthVerificationKey('bluesky', OLD, PUBKEY))).toBe(false)
    expect(JSON.parse(store.get(oauthVerificationKey('bluesky', DID, PUBKEY)) ?? '{}').handle).toBe(HANDLE)
    expect(store.has(oauthVerificationKey('bluesky', HANDLE, PUBKEY))).toBe(true)
  })

  // A sign-in that isn't confirmed changes nothing: the records from the
  // account's earlier handle stay as they were, and nothing new is saved.
  function expectEarlierLinkUntouched(store: Map<string, string>) {
    expect(store.has(oauthVerificationKey('bluesky', OLD, PUBKEY))).toBe(true)
    expect(JSON.parse(store.get(oauthVerificationKey('bluesky', DID, PUBKEY)) ?? '{}').handle).toBe(OLD)
    expect(store.has(oauthVerificationKey('bluesky', HANDLE, PUBKEY))).toBe(false)
  }

  it('keeps the existing link when the account can\'t be looked up', async () => {
    const { env, store } = createEnv()
    store.set(oauthVerificationKey('bluesky', OLD, PUBKEY), linkRecord(OLD, DID, OLD))
    store.set(oauthVerificationKey('bluesky', DID, PUBKEY), linkRecord(DID, DID, OLD))
    expect(await signIn(env, store, { didDocument: false })).toMatchObject({ success: false })
    expectEarlierLinkUntouched(store)
  })

  it('keeps the existing link when Bluesky signs in a different account than the one entered', async () => {
    const { env, store } = createEnv()
    store.set(oauthVerificationKey('bluesky', OLD, PUBKEY), linkRecord(OLD, DID, OLD))
    store.set(oauthVerificationKey('bluesky', DID, PUBKEY), linkRecord(DID, DID, OLD))
    const result = await signIn(env, store, { startedAs: { did: OTHER_DID, handle: HANDLE } })
    expect(result).toMatchObject({ success: false })
    expectEarlierLinkUntouched(store)
  })

  it('still removes the previous handle\'s record when an earlier lookup can\'t be cleared', async () => {
    const { env, store, kv } = createEnv()
    store.set(oauthVerificationKey('bluesky', OLD, PUBKEY), linkRecord(OLD, DID, OLD))
    store.set(oauthVerificationKey('bluesky', DID, PUBKEY), linkRecord(DID, DID, OLD))
    kv.delete.mockImplementation(async (key: string) => {
      if (key.startsWith('bsky_handle_did:')) throw new Error('KV DELETE failed')
      store.delete(key)
    })
    expect(await signIn(env, store)).toMatchObject({ success: true })
    expect(store.has(oauthVerificationKey('bluesky', OLD, PUBKEY))).toBe(false)
  })

  it('keeps a previous handle that is now linked to a different account', async () => {
    const { env, store } = createEnv()
    store.set(oauthVerificationKey('bluesky', OLD, PUBKEY), linkRecord(OLD, OTHER_DID, OLD))
    store.set(oauthVerificationKey('bluesky', DID, PUBKEY), linkRecord(DID, DID, OLD))
    expect(await signIn(env, store)).toMatchObject({ success: true })
    expect(store.has(oauthVerificationKey('bluesky', OLD, PUBKEY))).toBe(true)
  })
})
