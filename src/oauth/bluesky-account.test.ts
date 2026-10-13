import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleBlueskyCallback, startBlueskyOAuth } from './bluesky'
import { generateDPoPKeyPair } from './crypto'

// A Bluesky sign-in is recorded only for the account it started with, as the
// AT Protocol OAuth spec requires: the token's `sub` must be that account, its
// PDS must use the same authorization server, and its DID document must claim
// the handle the person typed.

const PUBKEY = 'ab'.repeat(32)
// These tests don't exercise sign-in binding; any hash-shaped string will do.
const BINDING_HASH = 'b'.repeat(64)
const ISSUER = 'https://bsky.social'
const HANDLE = 'alice.bsky.social'
const DID = 'did:plc:alice111111111111111111'
const PDS = 'https://pds.example.com'

type Account = { did: string, handles: string[], pds: string, authServer: string }

function kv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// The network as the callback sees it: the token endpoint returns `sub`, and
// each account's DID document and PDS answer as described.
function network(sub: string, accounts: Account[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === `${ISSUER}/oauth/token`) return json({ sub, access_token: 'token' })
    for (const a of accounts) {
      if (url === `https://plc.directory/${a.did}`) {
        return json({
          alsoKnownAs: a.handles.map(h => `at://${h}`),
          service: [{ id: '#atproto_pds', serviceEndpoint: a.pds }],
        })
      }
      if (url === `${a.pds}/.well-known/oauth-protected-resource`) {
        return json({ authorization_servers: [a.authServer] })
      }
    }
    return json({ error: 'not found' }, 404)
  })
}

async function signInReturning(sub: string, accounts: Account[], fetchMock: typeof fetch = network(sub, accounts)) {
  const { publicJwk, privateJwk } = await generateDPoPKeyPair()
  const cache = kv()
  cache.store.set('oauth_state:state1', JSON.stringify({
    platform: 'bluesky',
    pubkey: PUBKEY,
    codeVerifier: 'verifier',
    returnUrl: 'https://verifier.divine.video/',
    createdAt: Date.now(),
    dpopPrivateJwk: privateJwk,
    dpopPublicJwk: publicJwk,
    issuer: ISSUER,
    tokenEndpoint: `${ISSUER}/oauth/token`,
    did: DID,
    handle: HANDLE,
  }))
  vi.stubGlobal('fetch', fetchMock)
  const env = { CACHE_KV: cache, OAUTH_REDIRECT_BASE: 'https://verifier.divine.video' } as never
  const result = await handleBlueskyCallback(env, 'code', 'state1', ISSUER, undefined)
  const recorded = [...cache.store.keys()].filter(k => k.startsWith('oauth_verified:bluesky:'))
  return { result, recorded }
}

const alice: Account = { did: DID, handles: [HANDLE], pds: PDS, authServer: ISSUER }

describe('Bluesky sign-in token exchange', () => {
  const redirected = () => new Response(null, { status: 307, headers: { Location: 'https://elsewhere.example/oauth/token' } })

  it('does not follow a redirect from the token endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(redirected())

    const { result, recorded } = await signInReturning(DID, [alice], fetchMock)

    expect(result).toMatchObject({ success: false, error: 'Bluesky token exchange failed' })
    expect(recorded).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'manual' })
  })

  it('does not follow a redirect from the token retry with a nonce', async () => {
    const nonceRequired = new Response('{}', { status: 400, headers: { 'DPoP-Nonce': 'nonce1' } })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(nonceRequired).mockResolvedValueOnce(redirected())

    const { result, recorded } = await signInReturning(DID, [alice], fetchMock)

    expect(result).toMatchObject({ success: false, error: 'Bluesky token exchange failed' })
    expect(recorded).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', redirect: 'manual' })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Bluesky sign-in confirms the account it started with', () => {
  it('records the sign-in for the handle when every check holds', async () => {
    const { result, recorded } = await signInReturning(DID, [alice])
    expect(result).toMatchObject({ success: true, identity: HANDLE })
    expect(recorded.sort()).toEqual([
      `oauth_verified:bluesky:${HANDLE}:${PUBKEY}`,
      `oauth_verified:bluesky:${DID}:${PUBKEY}`,
    ])
  })

  it('refuses a token for a different account', async () => {
    // Its DID document claims the same handle; only the started account counts.
    const other: Account = { did: 'did:plc:other222222222222222222', handles: [HANDLE], pds: PDS, authServer: ISSUER }
    const { result, recorded } = await signInReturning(other.did, [alice, other])
    expect(result.success).toBe(false)
    expect(recorded).toEqual([])
  })

  it('refuses an account whose PDS uses a different authorization server', async () => {
    const elsewhere: Account = { ...alice, authServer: 'https://auth.elsewhere.example' }
    const { result, recorded } = await signInReturning(DID, [elsewhere])
    expect(result.success).toBe(false)
    expect(recorded).toEqual([])
  })

  it('refuses when the started handle is not the first one the DID document claims', async () => {
    const renamed: Account = { ...alice, handles: ['alice-new.bsky.social', HANDLE] }
    const { result, recorded } = await signInReturning(DID, [renamed])
    expect(result.success).toBe(false)
    expect(recorded).toEqual([])
  })

  it('refuses an account whose DID document does not claim the handle', async () => {
    const unclaimed: Account = { ...alice, handles: ['someone-else.bsky.social'] }
    const { result, recorded } = await signInReturning(DID, [unclaimed])
    expect(result.success).toBe(false)
    expect(recorded).toEqual([])
  })

  // A lookup that doesn't answer leaves the account unconfirmed, the same as
  // one that finds nothing.
  it.each([
    ['DID document', 'answers 503', `https://plc.directory/${DID}`, () => json({ error: 'unavailable' }, 503)],
    ['DID document', 'answers 403', `https://plc.directory/${DID}`, () => json({ error: 'forbidden' }, 403)],
    ['DID document', 'answers 200 with a page that isn\'t JSON', `https://plc.directory/${DID}`, () => new Response('<html>blocked</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ['DID document', 'can\'t be reached', `https://plc.directory/${DID}`, () => { throw new TypeError('fetch failed') }],
    ['PDS metadata', 'answers 503', `${PDS}/.well-known/oauth-protected-resource`, () => json({ error: 'unavailable' }, 503)],
    ['PDS metadata', 'can\'t be reached', `${PDS}/.well-known/oauth-protected-resource`, () => { throw new TypeError('fetch failed') }],
  ])('refuses when the %s lookup %s, and logs it as an outage', async (_step, _label, lookupUrl, outage) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers = network(DID, [alice])
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === lookupUrl ? outage() : answers(input))
    const { result, recorded } = await signInReturning(DID, [alice], fetchMock as typeof fetch)
    expect(result).toMatchObject({ success: false, error: 'Bluesky account not confirmed' })
    expect(recorded).toEqual([])
    expect(warn).toHaveBeenCalledWith('Bluesky sign-in not confirmed: lookup_unavailable')
  })

  it('doesn\'t log a PDS that answers without the metadata as an outage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers = network(DID, [alice])
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === `${PDS}/.well-known/oauth-protected-resource` ? json({ error: 'not found' }, 404) : answers(input))
    const { result, recorded } = await signInReturning(DID, [alice], fetchMock as typeof fetch)
    expect(result).toMatchObject({ success: false, error: 'Bluesky account not confirmed' })
    expect(recorded).toEqual([])
    expect(warn).toHaveBeenCalledWith('Bluesky sign-in not confirmed: authorization_server')
  })

  it('logs a failure while reading the account that isn\'t an outage as a lookup failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers = network(DID, [alice])
    // A handle list that isn't a list makes reading the DID document throw.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === `https://plc.directory/${DID}`
      ? json({ alsoKnownAs: 5, service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] })
      : answers(input))
    const { result } = await signInReturning(DID, [alice], fetchMock as typeof fetch)
    expect(result).toMatchObject({ success: false, error: 'Bluesky account not confirmed' })
    expect(warn).toHaveBeenCalledWith('Bluesky sign-in not confirmed: lookup')
  })
})

function discovery(metadataIssuer = ISSUER) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('com.atproto.identity.resolveHandle')) return json({ did: DID })
    if (url === `https://plc.directory/${DID}`) {
      return json({ alsoKnownAs: [`at://${HANDLE}`], service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] })
    }
    if (url === `${PDS}/.well-known/oauth-protected-resource`) return json({ authorization_servers: [ISSUER] })
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: metadataIssuer,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
      })
    }
    if (url === `${ISSUER}/oauth/par`) return json({ request_uri: 'urn:request' }, 201)
    return json({ error: 'not found' }, 404)
  })
}

describe('Bluesky sign-in discovery', () => {
  it('remembers the account and handle the sign-in starts with', async () => {
    vi.stubGlobal('fetch', discovery())
    const cache = kv()
    const env = { CACHE_KV: cache, OAUTH_REDIRECT_BASE: 'https://verifier.divine.video' } as never
    const response = await startBlueskyOAuth(env, PUBKEY, 'Alice.Bsky.Social', 'https://verifier.divine.video/', BINDING_HASH)
    expect(response.status).toBe(302)
    const [saved] = [...cache.store.entries()].filter(([k]) => k.startsWith('oauth_state:'))
    expect(JSON.parse(saved[1])).toMatchObject({ did: DID, handle: HANDLE, issuer: ISSUER })
  })

  it('refuses an authorization server whose metadata names a different issuer', async () => {
    vi.stubGlobal('fetch', discovery('https://auth.elsewhere.example'))
    const env = { CACHE_KV: kv(), OAUTH_REDIRECT_BASE: 'https://verifier.divine.video' } as never
    const response = await startBlueskyOAuth(env, PUBKEY, HANDLE, 'https://verifier.divine.video/', BINDING_HASH)
    expect(response.status).toBe(400)
  })

  // Sign-in treats an account lookup that doesn't answer as one that finds
  // nothing, and answers as it does for a handle it can't find.
  it.each([
    ['handle', 'answers 503', 'com.atproto.identity.resolveHandle', () => json({ error: 'unavailable' }, 503), 'Bluesky handle lookup answered 503'],
    ['handle', 'can\'t be reached', 'com.atproto.identity.resolveHandle', () => { throw new TypeError('fetch failed') }, 'Bluesky handle lookup couldn\'t be reached (TypeError)'],
    ['handle', 'answers 403', 'com.atproto.identity.resolveHandle', () => json({ error: 'forbidden' }, 403), 'Bluesky handle lookup answered 403'],
    ['handle', 'answers 200 with a page that isn\'t JSON', 'com.atproto.identity.resolveHandle', () => new Response('<html>blocked</html>', { status: 200 }), 'Bluesky handle lookup answered something that isn\'t JSON'],
    ['DID document', 'answers 503', `https://plc.directory/${DID}`, () => json({ error: 'unavailable' }, 503), 'PLC directory answered 503'],
    ['DID document', 'answers 401', `https://plc.directory/${DID}`, () => json({ error: 'unauthorized' }, 401), 'PLC directory answered 401'],
    ['DID document', 'answers 200 with a page that isn\'t JSON', `https://plc.directory/${DID}`, () => new Response('<html>blocked</html>', { status: 200 }), 'PLC directory answered something that isn\'t JSON'],
    ['DID document', 'can\'t be reached', `https://plc.directory/${DID}`, () => { throw new TypeError('fetch failed') }, 'PLC directory couldn\'t be reached (TypeError)'],
    ['PDS metadata', 'answers 503', `${PDS}/.well-known/oauth-protected-resource`, () => json({ error: 'unavailable' }, 503), 'Bluesky PDS metadata answered 503'],
    ['PDS metadata', 'can\'t be reached', `${PDS}/.well-known/oauth-protected-resource`, () => { throw new TypeError('fetch failed') }, 'Bluesky PDS metadata couldn\'t be reached (TypeError)'],
    ['authorization server metadata', 'answers 503', `${ISSUER}/.well-known/oauth-authorization-server`, () => json({ error: 'unavailable' }, 503), 'Bluesky authorization server metadata answered 503'],
    ['authorization server metadata', 'can\'t be reached', `${ISSUER}/.well-known/oauth-authorization-server`, () => { throw new TypeError('fetch failed') }, 'Bluesky authorization server metadata couldn\'t be reached (TypeError)'],
  ])('the %s lookup that %s stops the sign-in before it starts, and is logged', async (_step, _label, lookupUrl, outage, logged) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers = discovery()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes(lookupUrl) ? outage() : answers(input)))
    const cache = kv()
    const env = { CACHE_KV: cache, OAUTH_REDIRECT_BASE: 'https://verifier.divine.video' } as never
    const response = await startBlueskyOAuth(env, PUBKEY, HANDLE, 'https://verifier.divine.video/', BINDING_HASH)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Could not discover Bluesky authorization server for this handle' })
    expect([...cache.store.keys()]).toEqual([])
    expect(warn).toHaveBeenCalledWith('Bluesky sign-in discovery:', logged)
  })

  // A server that answers without the metadata is a "no", not an outage.
  it.each([
    ['PDS metadata', `${PDS}/.well-known/oauth-protected-resource`],
    ['authorization server metadata', `${ISSUER}/.well-known/oauth-authorization-server`],
  ])('the %s lookup that answers 404 stops the sign-in without being logged as an outage', async (_step, lookupUrl) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers = discovery()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input) === lookupUrl ? json({ error: 'not found' }, 404) : answers(input)))
    const env = { CACHE_KV: kv(), OAUTH_REDIRECT_BASE: 'https://verifier.divine.video' } as never
    const response = await startBlueskyOAuth(env, PUBKEY, HANDLE, 'https://verifier.divine.video/', BINDING_HASH)
    expect(response.status).toBe(400)
    expect(warn).not.toHaveBeenCalled()
  })

  it('doesn\'t mistake a failure in its own lookup code for a lookup that found nothing', async () => {
    vi.stubGlobal('fetch', discovery())
    const env = { CACHE_KV: kv(), OAUTH_REDIRECT_BASE: 'https://verifier.divine.video' } as never
    // A lone surrogate can't be put in a URL, so building the lookup throws.
    await expect(startBlueskyOAuth(env, PUBKEY, '\uD800', 'https://verifier.divine.video/', BINDING_HASH)).rejects.toThrow(URIError)
  })
})
