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
    const res = await app.request(`https://verifyer.divine.video/auth/twitter/start?pubkey=${PUBKEY}`, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toMatch(/^https:\/\/twitter\.com\/i\/oauth2\/authorize\?/)
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
      const record = JSON.parse((await env.CACHE_KV.get(key)) as string)
      expect(record.bound).toBeUndefined()
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
    const logged = JSON.stringify(info.mock.calls)
    for (const value of [PUBKEY, stateId, 'jack']) expect(logged).not.toContain(value)
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
