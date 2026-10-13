// ABOUTME: Sign-ins through the real routes, on every sign-in platform: how
// ABOUTME: they start, finish and are confirmed (#113).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Bindings } from '../types'
import auth from './auth'
import { oauthStateKey, oauthVerificationKey } from '../oauth/state'

const app = new Hono<{ Bindings: Bindings }>()
app.route('/auth', auth)

function createMockKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
  } as unknown as KVNamespace
}

const BASE = 'https://verifier.divine.video'
const PLATFORMS = ['twitter', 'youtube', 'tiktok', 'bluesky'] as const
type Platform = typeof PLATFORMS[number]
const BLUESKY_HANDLE = 'alice.bsky.social'
const BLUESKY_DID = 'did:plc:alice111111111111111111'
const BLUESKY_ISSUER = 'https://bsky.social'
const BLUESKY_PDS = 'https://pds.example.com'

function baseEnv(extra: Partial<Bindings> = {}): Bindings {
  return {
    CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV(),
    TWITTER_CLIENT_ID: 'id', TWITTER_CLIENT_SECRET: 'secret', OAUTH_REDIRECT_BASE: BASE, ...extra,
  } as Bindings
}

function platformEnv(platform: Platform, extra: Partial<Bindings> = {}): Bindings {
  switch (platform) {
    case 'youtube': return baseEnv({ GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', ...extra })
    case 'tiktok': return baseEnv({ TIKTOK_CLIENT_KEY: 'tkey', TIKTOK_CLIENT_SECRET: 'tsecret', TIKTOK_OAUTH_ENABLED: 'true', ...extra })
    default: return baseEnv(extra)
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Bluesky's start resolves the handle, the DID document, the PDS resource
// metadata and the authorization server metadata, then pushes the
// authorization request. Its redirect carries no `state` (AT Protocol OAuth
// sends it inside the pushed request), so it's captured from the PAR body.
function blueskyStartFetch(capture: { stateId?: string }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('com.atproto.identity.resolveHandle')) return jsonResponse({ did: BLUESKY_DID })
    if (url === `https://plc.directory/${BLUESKY_DID}`) {
      return jsonResponse({ alsoKnownAs: [`at://${BLUESKY_HANDLE}`], service: [{ id: '#atproto_pds', serviceEndpoint: BLUESKY_PDS }] })
    }
    if (url === `${BLUESKY_PDS}/.well-known/oauth-protected-resource`) return jsonResponse({ authorization_servers: [BLUESKY_ISSUER] })
    if (url === `${BLUESKY_ISSUER}/.well-known/oauth-authorization-server`) {
      return jsonResponse({
        issuer: BLUESKY_ISSUER,
        authorization_endpoint: `${BLUESKY_ISSUER}/oauth/authorize`,
        token_endpoint: `${BLUESKY_ISSUER}/oauth/token`,
        pushed_authorization_request_endpoint: `${BLUESKY_ISSUER}/oauth/par`,
      })
    }
    if (url === `${BLUESKY_ISSUER}/oauth/par`) {
      if (init?.body instanceof URLSearchParams) capture.stateId = init.body.get('state') ?? undefined
      return jsonResponse({ request_uri: 'urn:ietf:params:oauth:request_uri:test' })
    }
    throw new Error(`unexpected fetch during Bluesky start: ${url}`)
  })
}

function blueskyCallbackFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === `${BLUESKY_ISSUER}/oauth/token`) return jsonResponse({ sub: BLUESKY_DID, access_token: 'token' })
    if (url === `https://plc.directory/${BLUESKY_DID}`) {
      return jsonResponse({ alsoKnownAs: [`at://${BLUESKY_HANDLE}`], service: [{ id: '#atproto_pds', serviceEndpoint: BLUESKY_PDS }] })
    }
    if (url === `${BLUESKY_PDS}/.well-known/oauth-protected-resource`) return jsonResponse({ authorization_servers: [BLUESKY_ISSUER] })
    throw new Error(`unexpected fetch during Bluesky callback: ${url}`)
  })
}

function callbackFetchFor(platform: Platform) {
  switch (platform) {
    case 'twitter':
      return vi.fn()
        .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
        .mockResolvedValueOnce(jsonResponse({ data: { id: '1', username: 'jack' } }))
    case 'youtube':
      return vi.fn()
        .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
        .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'UC1', snippet: { customUrl: 'creator' } }] }))
    case 'tiktok':
      return vi.fn()
        .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
        .mockResolvedValueOnce(jsonResponse({ data: { user: { username: 'creator' } } }))
    case 'bluesky':
      return blueskyCallbackFetch()
  }
}

function identityFor(platform: Platform): string {
  return platform === 'twitter' ? 'jack' : platform === 'bluesky' ? BLUESKY_HANDLE : 'creator'
}

function recordKeysFor(platform: Platform, pubkey: string): string[] {
  if (platform === 'bluesky') return [oauthVerificationKey('bluesky', BLUESKY_HANDLE, pubkey), oauthVerificationKey('bluesky', BLUESKY_DID, pubkey)]
  return [oauthVerificationKey(platform, identityFor(platform), pubkey)]
}

function callbackQueryExtra(platform: Platform): string {
  return platform === 'bluesky' ? `&iss=${encodeURIComponent(BLUESKY_ISSUER)}` : ''
}

// The state id a start created: Twitter, YouTube and TikTok carry it on the
// provider address; Bluesky's is captured from the PAR request.
function stateIdFrom(platform: Platform, providerUrl: string, capture: { stateId?: string }): string {
  if (platform === 'bluesky') return capture.stateId as string
  return new URL(providerUrl).searchParams.get('state') as string
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const PUBKEY = 'a'.repeat(64)

describe('the sign-in browser cookie is gone', () => {
  it.each(PLATFORMS)('%s: a GET start sets no cookie and stores no binding', async (platform) => {
    const env = platformEnv(platform)
    const capture: { stateId?: string } = {}
    if (platform === 'bluesky') vi.stubGlobal('fetch', blueskyStartFetch(capture))
    const query = platform === 'bluesky' ? `pubkey=${PUBKEY}&handle=${BLUESKY_HANDLE}` : `pubkey=${PUBKEY}`
    const res = await app.request(`${BASE}/auth/${platform}/start?${query}`, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Set-Cookie')).toBeNull()
    const state = JSON.parse((await env.CACHE_KV.get(oauthStateKey(stateIdFrom(platform, res.headers.get('Location') as string, capture)))) as string)
    expect(state.bindingHash).toBeUndefined()
    expect(state.startCheck).toBeUndefined()
  })

  it('a GET start on the other verifier host starts there, with no redirect to the base host', async () => {
    const env = baseEnv()
    const returnUrl = 'https://verifyer.divine.video/#verify-here'
    const res = await app.request(`https://verifyer.divine.video/auth/twitter/start?pubkey=${PUBKEY}&return_url=${encodeURIComponent(returnUrl)}`, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toMatch(/^https:\/\/twitter\.com\/i\/oauth2\/authorize\?/)
    const state = JSON.parse((await env.CACHE_KV.get(oauthStateKey(stateIdFrom('twitter', res.headers.get('Location') as string, {})))) as string)
    expect(state.returnUrl).toBe(returnUrl)
  })

  it.each(PLATFORMS)('%s: a callback clears no cookie and writes no bound flag', async (platform) => {
    const env = platformEnv(platform)
    const capture: { stateId?: string } = {}
    if (platform === 'bluesky') vi.stubGlobal('fetch', blueskyStartFetch(capture))
    const query = platform === 'bluesky' ? `pubkey=${PUBKEY}&handle=${BLUESKY_HANDLE}` : `pubkey=${PUBKEY}`
    const start = await app.request(`${BASE}/auth/${platform}/start?${query}`, {}, env)
    const stateId = stateIdFrom(platform, start.headers.get('Location') as string, capture)
    vi.stubGlobal('fetch', callbackFetchFor(platform))
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await app.request(`${BASE}/auth/${platform}/callback?code=c&state=${stateId}${callbackQueryExtra(platform)}`, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Set-Cookie')).toBeNull()
    for (const key of recordKeysFor(platform, PUBKEY)) {
      const raw = await env.CACHE_KV.get(key)
      expect(raw).not.toBeNull()
      expect(JSON.parse(raw as string).bound).toBeUndefined()
    }
  })
})

describe('a sign-in the provider did not complete', () => {
  it.each(PLATFORMS)('%s: records nothing and sets no cookie', async (platform) => {
    const put = vi.fn(async (_key: string, _value: string) => {})
    const cache = { get: async () => null, put, delete: async () => {}, list: async () => ({ keys: [], list_complete: true, caches_used: 0 }) } as unknown as KVNamespace
    const env = baseEnv({ CACHE_KV: cache })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await app.request(`${BASE}/auth/${platform}/callback?error=access_denied&state=missing`, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(put.mock.calls.some(([key]) => String(key).startsWith('oauth_verified:'))).toBe(false)
  })
})

describe('what a sign-in callback logs', () => {
  async function startTwitter(env: Bindings): Promise<string> {
    const start = await app.request(`${BASE}/auth/twitter/start?pubkey=${PUBKEY}`, {}, env)
    return stateIdFrom('twitter', start.headers.get('Location') as string, {})
  }

  it('logs nothing that identifies the person', async () => {
    const env = baseEnv()
    const stateId = await startTwitter(env)
    vi.stubGlobal('fetch', callbackFetchFor('twitter'))
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await app.request(`${BASE}/auth/twitter/callback?code=c&state=${stateId}`, {}, env)
    expect(new URL(res.headers.get('Location') as string, BASE).searchParams.get('oauth_verified')).toBe('true')
    expect(info.mock.calls).toEqual([['twitter sign-in finished: installed app, unconfirmed']])
  })

  it('logs nothing when a callback fails without throwing (unknown state)', async () => {
    const env = baseEnv()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await app.request(`${BASE}/auth/twitter/callback?code=c&state=unknown-state`, {}, env)
    expect(new URL(res.headers.get('Location') as string, BASE).searchParams.get('oauth_error')).toBe('Verification failed')
    expect(info).not.toHaveBeenCalled()
  })

  it('logs nothing when a callback fails without throwing (token exchange answers non-200)', async () => {
    const env = baseEnv()
    const stateId = await startTwitter(env)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 500 })))
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await app.request(`${BASE}/auth/twitter/callback?code=c&state=${stateId}`, {}, env)
    expect(new URL(res.headers.get('Location') as string, BASE).searchParams.get('oauth_error')).toBe('Verification failed')
    expect(info).not.toHaveBeenCalled()
  })
})

// A callback for a state stored by hand, so these tests don't depend on how a
// start is made.
async function finishWithState(
  platform: Platform,
  env: Bindings,
  state: Record<string, unknown>,
  fetchStub: ReturnType<typeof vi.fn> = callbackFetchFor(platform),
) {
  const full: Record<string, unknown> = { platform, pubkey: PUBKEY, codeVerifier: 'v', createdAt: Date.now(), ...state }
  if (platform === 'bluesky') {
    const { generateDPoPKeyPair } = await import('../oauth/crypto')
    const { publicJwk, privateJwk } = await generateDPoPKeyPair()
    Object.assign(full, {
      dpopPrivateJwk: privateJwk, dpopPublicJwk: publicJwk,
      issuer: 'https://bsky.social', tokenEndpoint: 'https://bsky.social/oauth/token',
      did: BLUESKY_DID, handle: BLUESKY_HANDLE,
    })
  }
  await env.CACHE_KV.put(oauthStateKey('s1'), JSON.stringify(full))
  vi.stubGlobal('fetch', fetchStub)
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const res = await app.request(`${BASE}/auth/${platform}/callback?code=c&state=s1${callbackQueryExtra(platform)}`, {}, env)
  return { res, info, location: new URL(res.headers.get('Location') as string, BASE) }
}

const START_CHECK = 'G2CN_J8Es1JmsWz0QXd2Kc-4p-lCo8GCsR-tVw6vre4'
const PAGE_RETURN = `${BASE}/?signin=nonce1#verify-here`
const CODE = /^[A-Za-z0-9_-]{43}$/

describe('a finished sign-in started with a start check', () => {
  it.each(PLATFORMS)('%s: sends a one-time code after the # and holds the sign-in for confirmation', async (platform) => {
    const env = platformEnv(platform)
    const { location, info } = await finishWithState(platform, env, { returnUrl: PAGE_RETURN, startCheck: START_CHECK })
    const code = new URLSearchParams(location.hash.slice(1)).get('oauth_confirm') as string
    expect(code).toMatch(CODE)
    expect(location.hash).toBe(`#oauth_confirm=${code}`)
    expect(location.searchParams.get('oauth_confirm')).toBeNull()
    expect(location.searchParams.get('signin')).toBe('nonce1')
    expect(location.searchParams.get('platform')).toBe(platform)
    expect(location.searchParams.get('identity')).toBe(identityFor(platform))
    const { getPendingSignIn } = await import('../oauth/confirm')
    expect(await getPendingSignIn(env.CACHE_KV, code)).toMatchObject({ platform, pubkey: PUBKEY, identity: identityFor(platform), startCheck: START_CHECK })
    expect(info.mock.calls).toEqual([[`${platform} sign-in finished: awaiting confirmation`]])
  })

  it('puts the code in the query when set to', async () => {
    const env = baseEnv({ SIGNIN_CODE_PLACEMENT: 'query' })
    const { location } = await finishWithState('twitter', env, { returnUrl: PAGE_RETURN, startCheck: START_CHECK })
    expect(location.searchParams.get('oauth_confirm')).toMatch(CODE)
    expect(location.hash).toBe('#verify-here')
  })

  it('before the switch: also saves an unconfirmed record and says oauth_verified', async () => {
    const env = baseEnv()
    const { location } = await finishWithState('twitter', env, { returnUrl: PAGE_RETURN, startCheck: START_CHECK })
    expect(location.searchParams.get('oauth_verified')).toBe('true')
    const record = JSON.parse((await env.CACHE_KV.get(oauthVerificationKey('twitter', 'jack', PUBKEY))) as string)
    expect(record.confirmed).toBeUndefined()
  })

  it.each(PLATFORMS)('%s: once required, saves no record and does not say oauth_verified', async (platform) => {
    const env = platformEnv(platform, { SIGNIN_CONFIRMATION: 'required' })
    const { location } = await finishWithState(platform, env, { returnUrl: PAGE_RETURN, startCheck: START_CHECK })
    expect(location.searchParams.get('oauth_verified')).toBeNull()
    for (const key of recordKeysFor(platform, PUBKEY)) expect(await env.CACHE_KV.get(key)).toBeNull()
  })

  it('replaces names the return address arrived with, and a fragment that carried a code', async () => {
    const env = baseEnv()
    const returnUrl = `${BASE}/?signin=n&identity=evil&oauth_confirm=old#oauth_confirm=old`
    const { location } = await finishWithState('twitter', env, { returnUrl, startCheck: START_CHECK })
    expect(location.searchParams.get('identity')).toBe('jack')
    expect(location.searchParams.getAll('oauth_confirm')).toEqual([])
    const code = new URLSearchParams(location.hash.slice(1)).get('oauth_confirm') as string
    expect(code).toMatch(CODE)
    expect(location.hash).toBe(`#oauth_confirm=${code}`)
  })

  it('with the code in the query: drops a fragment that carried a code', async () => {
    const env = baseEnv({ SIGNIN_CODE_PLACEMENT: 'query' })
    const returnUrl = `${BASE}/?signin=n&oauth_confirm=old#oauth_confirm=old`
    const { location } = await finishWithState('twitter', env, { returnUrl, startCheck: START_CHECK })
    const codes = location.searchParams.getAll('oauth_confirm')
    expect(codes).toHaveLength(1)
    expect(codes[0]).toMatch(CODE)
    expect(location.hash).toBe('')
  })
})

describe('a finished sign-in started without a start check (installed app)', () => {
  it.each(PLATFORMS)('%s: gets no code, saves an unconfirmed record, and logs it as an installed app', async (platform) => {
    const env = platformEnv(platform)
    const { location, info } = await finishWithState(platform, env, { returnUrl: 'https://divine.video/app/callback' })
    expect(location.hash).toBe('')
    expect(location.searchParams.get('oauth_confirm')).toBeNull()
    expect(location.searchParams.get('oauth_verified')).toBe('true')
    for (const key of recordKeysFor(platform, PUBKEY)) {
      const raw = await env.CACHE_KV.get(key)
      expect(raw).not.toBeNull()
      expect(JSON.parse(raw as string).confirmed).toBeUndefined()
    }
    expect(info.mock.calls).toEqual([[`${platform} sign-in finished: installed app, unconfirmed`]])
  })
})

describe('a sign-in callback that throws', () => {
  it.each(PLATFORMS)('%s: sends the person to the verifier page with an error and sets no cookie', async (platform) => {
    const env = platformEnv(platform)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { res, info } = await finishWithState(platform, env, { returnUrl: PAGE_RETURN, startCheck: START_CHECK },
      vi.fn().mockRejectedValue(new Error('network down')))
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/?oauth_error=Verification+failed')
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(info).not.toHaveBeenCalled()
  })
})
