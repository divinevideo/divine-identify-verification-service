import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import type { Bindings, CachedResult } from '../types'
import { cacheKey } from '../utils/cache'
import { oauthVerificationKey, storeOAuthVerification } from './state'
import { handleBlueskyCallback } from './bluesky'
import { generateDPoPKeyPair } from './crypto'
import { createBinding } from './binding'

// An account linked by signing in to Bluesky stays verified for 30 days, or
// until it is unlinked (#58).
// A Bluesky link is tied to the account's DID, so a handle that now points
// somewhere else stops verifying.

const PUBKEY = 'ab'.repeat(32)
const HANDLE = 'alice.bsky.social'
const DID = 'did:plc:alice111111111111111111'
const OTHER_DID = 'did:plc:other222222222222222222'

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

function signInRecord(identity: string, accountId?: string) {
  return JSON.stringify({ platform: 'bluesky', identity, pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: 1_700_000_000, ...(accountId ? { account_id: accountId } : {}) })
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
  it('keeps a Bluesky sign-in for 30 days', async () => {
    const { kv } = createEnv()
    await storeOAuthVerification(kv as unknown as KVNamespace, { platform: 'bluesky', identity: HANDLE, pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: 1, account_id: DID })
    expect(kv.put.mock.calls[0][2]).toEqual({ expirationTtl: 30 * 86400 })
  })

  it('still expires a Bluesky sign-in saved without its account', async () => {
    const { kv } = createEnv()
    await storeOAuthVerification(kv as unknown as KVNamespace, { platform: 'bluesky', identity: HANDLE, pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: 1 })
    expect(kv.put.mock.calls[0][2]).toEqual({ expirationTtl: 86400 })
  })

  it.each(['twitter', 'youtube', 'tiktok'] as const)('still expires %s sign-ins after a day, even with an account ID', async platform => {
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
    vi.stubGlobal('fetch', handleLookup(DID))
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
  })

  it('stops verifying when the handle now points to a different account', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', handleLookup(OTHER_DID))
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    const result = await check(env)
    expect(result.verified).toBe(false)
    expect(result.error).toBe('This Bluesky account no longer matches the one that was linked. Link it again.')
  })

  it('stops verifying when the handle no longer exists', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', handleLookup('not-found'))
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    expect((await check(env)).verified).toBe(false)
  })

  it('trusts the record when Bluesky cannot be reached', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', handleLookup('unreachable'))
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
  })

  it('needs no lookup for a claim made with the DID itself', async () => {
    const { env, store } = createEnv()
    const lookup = handleLookup(OTHER_DID)
    vi.stubGlobal('fetch', lookup)
    store.set(oauthVerificationKey('bluesky', DID, PUBKEY), signInRecord(DID, DID))
    expect(await check(env, DID)).toMatchObject({ verified: true, method: 'oauth' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('accepts the linked DID written in capitals', async () => {
    const { env, store } = createEnv()
    const lookup = handleLookup(OTHER_DID)
    vi.stubGlobal('fetch', lookup)
    store.set(oauthVerificationKey('bluesky', DID, PUBKEY), signInRecord(DID, DID))
    expect(await check(env, DID.toUpperCase())).toMatchObject({ verified: true, method: 'oauth' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('trusts the record when Bluesky answers without an account, and asks again next time', async () => {
    const { env, store } = createEnv()
    const lookup = vi.fn(async () => json({ did: 'not-an-account' }))
    vi.stubGlobal('fetch', lookup)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
    await check(env)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('looks the handle up once and reuses the answer', async () => {
    const { env, store } = createEnv()
    const lookup = handleLookup(DID)
    vi.stubGlobal('fetch', lookup)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    await check(env)
    await check(env)
    expect(lookup).toHaveBeenCalledTimes(1)
  })
})

describe('checking a Bluesky sign-in link claimed by DID', () => {
  it('does not verify a DID the sign-in was not for', async () => {
    const { env, store } = createEnv()
    vi.stubGlobal('fetch', handleLookup(DID))
    store.set(oauthVerificationKey('bluesky', OTHER_DID, PUBKEY), signInRecord(OTHER_DID, DID))
    expect((await check(env, OTHER_DID)).verified).toBe(false)
  })

  it('does not let a look-alike DID match the linked one', async () => {
    const { env, store } = createEnv()
    const kDid = 'did:plc:kkkk11111111111111111111'
    vi.stubGlobal('fetch', handleLookup(kDid))
    store.set(oauthVerificationKey('bluesky', kDid, PUBKEY), signInRecord(kDid, kDid))
    // U+212A KELVIN SIGN lowercases to an ASCII k
    expect((await check(env, 'did:plc:\u212Akkk11111111111111111111')).verified).toBe(false)
    expect(await check(env, kDid)).toMatchObject({ verified: true, method: 'oauth' })
  })
})

describe('checking a Bluesky sign-in link with an unusual handle', () => {
  it('does not let a look-alike handle change the answer for the real one', async () => {
    const { env, store } = createEnv()
    const lookup = handleLookup(DID)
    vi.stubGlobal('fetch', lookup)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    // U+212A KELVIN SIGN lowercases to an ASCII k
    const lookAlike = 'alice.bs\u212Ay.social'
    expect((await check(env, lookAlike)).verified).toBe(false)
    expect(store.has(`bsky_handle_did:${HANDLE}`)).toBe(false)
    expect(await check(env)).toMatchObject({ verified: true, method: 'oauth' })
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
    const lookup = vi.fn(async () => new Response('upstream error', { status: 502 }))
    vi.stubGlobal('fetch', lookup)
    store.set(oauthVerificationKey('bluesky', HANDLE, PUBKEY), signInRecord(HANDLE, DID))
    await check(env)
    await check(env)
    expect(lookup).toHaveBeenCalledTimes(2)
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
    const result = await handleBlueskyCallback(env, 'code', 's1', 'https://bsky.social', undefined)
    expect(result).toMatchObject({ success: true, identity: HANDLE })
    expect(requests.some(u => u.includes('/xrpc/com.atproto.repo.'))).toBe(false)
    const saved = JSON.parse(store.get(oauthVerificationKey('bluesky', HANDLE, PUBKEY)) ?? '{}')
    expect(saved.account_id).toBe(DID)
    expect(saved.handle).toBe(HANDLE)
    expect(saved.bound).toBe(false)
    const savedByDid = JSON.parse(store.get(oauthVerificationKey('bluesky', DID, PUBKEY)) ?? '{}')
    expect(savedByDid.handle).toBe(HANDLE)
    expect(savedByDid.bound).toBe(false)
    for (const identity of [HANDLE, DID]) {
      expect(kv.put.mock.calls.find(c => c[0] === oauthVerificationKey('bluesky', identity, PUBKEY))?.[2]).toEqual({ expirationTtl: 30 * 86400 })
    }
  })

  it('records the sign-in as bound when the callback cookie matches the binding hash stored at start', async () => {
    const { env, store } = createEnv()
    const { publicJwk, privateJwk } = await generateDPoPKeyPair()
    const { value, hash } = await createBinding()
    store.set('oauth_state:s1', JSON.stringify({
      platform: 'bluesky', pubkey: PUBKEY, codeVerifier: 'v', returnUrl: 'https://verifier.divine.video/', createdAt: Date.now(),
      dpopPrivateJwk: privateJwk, dpopPublicJwk: publicJwk, issuer: 'https://bsky.social', tokenEndpoint: 'https://bsky.social/oauth/token',
      did: DID, handle: HANDLE, bindingHash: hash,
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://bsky.social/oauth/token') return json({ sub: DID, access_token: 'token' })
      if (url === `https://plc.directory/${DID}`) {
        return json({ alsoKnownAs: [`at://${HANDLE}`], service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.example.com' }] })
      }
      if (url === 'https://pds.example.com/.well-known/oauth-protected-resource') return json({ authorization_servers: ['https://bsky.social'] })
      return json({ uri: 'at://x/y/z' })
    }))
    const result = await handleBlueskyCallback(env, 'code', 's1', 'https://bsky.social', value)
    expect(result.bound).toBe(true)
    expect(JSON.parse(store.get(oauthVerificationKey('bluesky', HANDLE, PUBKEY)) ?? '{}').bound).toBe(true)
    expect(JSON.parse(store.get(oauthVerificationKey('bluesky', DID, PUBKEY)) ?? '{}').bound).toBe(true)
  })

  it('records the sign-in as unbound when the callback cookie does not match the binding hash stored at start', async () => {
    const { env, store } = createEnv()
    const { publicJwk, privateJwk } = await generateDPoPKeyPair()
    const { hash } = await createBinding()
    store.set('oauth_state:s1', JSON.stringify({
      platform: 'bluesky', pubkey: PUBKEY, codeVerifier: 'v', returnUrl: 'https://verifier.divine.video/', createdAt: Date.now(),
      dpopPrivateJwk: privateJwk, dpopPublicJwk: publicJwk, issuer: 'https://bsky.social', tokenEndpoint: 'https://bsky.social/oauth/token',
      did: DID, handle: HANDLE, bindingHash: hash,
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://bsky.social/oauth/token') return json({ sub: DID, access_token: 'token' })
      if (url === `https://plc.directory/${DID}`) {
        return json({ alsoKnownAs: [`at://${HANDLE}`], service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.example.com' }] })
      }
      if (url === 'https://pds.example.com/.well-known/oauth-protected-resource') return json({ authorization_servers: ['https://bsky.social'] })
      return json({ uri: 'at://x/y/z' })
    }))
    const result = await handleBlueskyCallback(env, 'code', 's1', 'https://bsky.social', 'wrong-cookie-value')
    expect(result.bound).toBe(false)
    expect(JSON.parse(store.get(oauthVerificationKey('bluesky', HANDLE, PUBKEY)) ?? '{}').bound).toBe(false)
    expect(JSON.parse(store.get(oauthVerificationKey('bluesky', DID, PUBKEY)) ?? '{}').bound).toBe(false)
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
  return handleBlueskyCallback(env, 'code', 's2', 'https://bsky.social', undefined)
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
