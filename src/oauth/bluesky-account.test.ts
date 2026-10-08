import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleBlueskyCallback, startBlueskyOAuth } from './bluesky'
import { generateDPoPKeyPair } from './crypto'

// A Bluesky sign-in is recorded only for the account it started with, as the
// AT Protocol OAuth spec requires: the token's `sub` must be that account, its
// PDS must use the same authorization server, and its DID document must claim
// the handle the person typed.

const PUBKEY = 'ab'.repeat(32)
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

async function signInReturning(sub: string, accounts: Account[]) {
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
  vi.stubGlobal('fetch', network(sub, accounts))
  const env = { CACHE_KV: cache, OAUTH_REDIRECT_BASE: 'https://verifier.divine.video' } as never
  const result = await handleBlueskyCallback(env, 'code', 'state1', ISSUER)
  const recorded = [...cache.store.keys()].filter(k => k.startsWith('oauth_verified:bluesky:'))
  return { result, recorded }
}

const alice: Account = { did: DID, handles: [HANDLE], pds: PDS, authServer: ISSUER }

afterEach(() => { vi.unstubAllGlobals() })

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
    const response = await startBlueskyOAuth(env, PUBKEY, 'Alice.Bsky.Social', 'https://verifier.divine.video/')
    expect(response.status).toBe(302)
    const [saved] = [...cache.store.entries()].filter(([k]) => k.startsWith('oauth_state:'))
    expect(JSON.parse(saved[1])).toMatchObject({ did: DID, handle: HANDLE, issuer: ISSUER })
  })

  it('refuses an authorization server whose metadata names a different issuer', async () => {
    vi.stubGlobal('fetch', discovery('https://auth.elsewhere.example'))
    const env = { CACHE_KV: kv(), OAUTH_REDIRECT_BASE: 'https://verifier.divine.video' } as never
    const response = await startBlueskyOAuth(env, PUBKEY, HANDLE, 'https://verifier.divine.video/')
    expect(response.status).toBe(400)
  })
})
