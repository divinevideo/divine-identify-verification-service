// ABOUTME: Sign-ins through the real routes, on every sign-in platform: how
// ABOUTME: they start, finish and are confirmed (#113).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Bindings } from '../types'
import auth from './auth'
import { oauthStateKey, oauthVerificationKey } from '../oauth/state'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { startCheckFor, confirmBindingFor } from '../oauth/confirm'

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
        .mockResolvedValueOnce(jsonResponse({ data: { user: { open_id: 'open-1', username: 'creator' } } }))
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
    expect(new URL(res.headers.get('Location') as string, BASE).searchParams.get('oauth_error_code')).toBe('failed')
    expect(info).not.toHaveBeenCalled()
  })

  it('logs nothing when a callback fails without throwing (token exchange answers non-200)', async () => {
    const env = baseEnv()
    const stateId = await startTwitter(env)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 500 })))
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await app.request(`${BASE}/auth/twitter/callback?code=c&state=${stateId}`, {}, env)
    expect(new URL(res.headers.get('Location') as string, BASE).searchParams.get('oauth_error')).toBe('Verification failed')
    expect(new URL(res.headers.get('Location') as string, BASE).searchParams.get('oauth_error_code')).toBe('failed')
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

  it('puts the code in the query when set to, and drops the whole fragment', async () => {
    const env = baseEnv({ SIGNIN_CODE_PLACEMENT: 'query' })
    const { location } = await finishWithState('twitter', env, { returnUrl: PAGE_RETURN, startCheck: START_CHECK })
    const code = location.searchParams.get('oauth_confirm') as string
    expect(code).toMatch(CODE)
    expect(location.hash).toBe('')
    const { getPendingSignIn } = await import('../oauth/confirm')
    expect(await getPendingSignIn(env.CACHE_KV, code)).toMatchObject({ platform: 'twitter', startCheck: START_CHECK })
  })

  it('before the switch: also saves an unconfirmed record and says oauth_verified', async () => {
    const env = baseEnv()
    const { location } = await finishWithState('twitter', env, { returnUrl: PAGE_RETURN, startCheck: START_CHECK })
    expect(location.searchParams.get('oauth_verified')).toBe('true')
    const raw = await env.CACHE_KV.get(oauthVerificationKey('twitter', 'jack', PUBKEY))
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string).confirmed).toBeUndefined()
  })

  it.each(PLATFORMS)('%s: once required, still holds the sign-in under a code, but saves no record and does not say oauth_verified', async (platform) => {
    const env = platformEnv(platform, { SIGNIN_CONFIRMATION: 'required' })
    const { location } = await finishWithState(platform, env, { returnUrl: PAGE_RETURN, startCheck: START_CHECK })
    const code = new URLSearchParams(location.hash.slice(1)).get('oauth_confirm') as string
    expect(code).toMatch(CODE)
    expect(location.hash).toBe(`#oauth_confirm=${code}`)
    const { getPendingSignIn } = await import('../oauth/confirm')
    expect(await getPendingSignIn(env.CACHE_KV, code)).toMatchObject({ platform, startCheck: START_CHECK })
    expect(location.searchParams.get('oauth_verified')).toBeNull()
    for (const key of recordKeysFor(platform, PUBKEY)) expect(await env.CACHE_KV.get(key)).toBeNull()
  })

  it('replaces names the return address arrived with, and a fragment that carried a code', async () => {
    const env = baseEnv()
    const returnUrl = `${BASE}/?signin=n&identity=evil&oauth_confirm=old&oauth_error=old&oauth_error_code=cancelled#oauth_confirm=old`
    const { location } = await finishWithState('twitter', env, { returnUrl, startCheck: START_CHECK })
    expect(location.searchParams.get('identity')).toBe('jack')
    expect(location.searchParams.has('oauth_error')).toBe(false)
    expect(location.searchParams.has('oauth_error_code')).toBe(false)
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

  it('replaces a fragment that carried the code\'s name percent-encoded', async () => {
    const env = baseEnv()
    const returnUrl = `${BASE}/?signin=n#oauth%5Fconfirm=old`
    const { location } = await finishWithState('twitter', env, { returnUrl, startCheck: START_CHECK })
    const code = new URLSearchParams(location.hash.slice(1)).get('oauth_confirm') as string
    expect(code).toMatch(CODE)
    expect(location.hash).toBe(`#oauth_confirm=${code}`)
  })

  it('with the code in the query: drops a fragment that carried the code\'s name percent-encoded', async () => {
    const env = baseEnv({ SIGNIN_CODE_PLACEMENT: 'query' })
    const returnUrl = `${BASE}/?signin=n#oauth%5Fconfirm=old`
    const { location } = await finishWithState('twitter', env, { returnUrl, startCheck: START_CHECK })
    expect(location.searchParams.getAll('oauth_confirm')).toHaveLength(1)
    expect(location.searchParams.get('oauth_confirm')).toMatch(CODE)
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

  it('drops a fragment that carried the code\'s name percent-encoded, though it sends no code', async () => {
    const env = baseEnv()
    const { location } = await finishWithState('twitter', env, { returnUrl: 'https://divine.video/app/callback#oauth%5Fconfirm=old' })
    expect(location.searchParams.get('oauth_confirm')).toBeNull()
    expect(location.hash).toBe('')
  })

  it('drops a fragment that mentions the code\'s name in any form, though it sends no code', async () => {
    const env = baseEnv()
    const { location } = await finishWithState('twitter', env, { returnUrl: 'https://divine.video/app/callback#/done?oauth_confirm=old' })
    expect(location.hash).toBe('')
  })
})

describe('a sign-in callback that throws', () => {
  it.each(PLATFORMS)('%s: sends the person to the verifier page with an error and sets no cookie', async (platform) => {
    const env = platformEnv(platform)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { res, info } = await finishWithState(platform, env, { returnUrl: PAGE_RETURN, startCheck: START_CHECK },
      vi.fn().mockRejectedValue(new Error('network down')))
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/?oauth_error=Verification+failed&oauth_error_code=failed')
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(info).not.toHaveBeenCalled()
  })
})

async function postStart(platform: Platform, env: Bindings, body: Record<string, unknown>, host = BASE) {
  return app.request(`${host}/auth/${platform}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, env)
}

function startBody(platform: Platform, pubkey: string, startCheck: string, returnUrl = PAGE_RETURN): Record<string, unknown> {
  return { pubkey, return_url: returnUrl, start_check: startCheck, ...(platform === 'bluesky' ? { handle: BLUESKY_HANDLE } : {}) }
}

describe('POST /auth/:platform/start', () => {
  it.each(PLATFORMS)('%s: answers with the provider address and stores the start check', async (platform) => {
    const env = platformEnv(platform)
    const capture: { stateId?: string } = {}
    if (platform === 'bluesky') vi.stubGlobal('fetch', blueskyStartFetch(capture))
    const res = await postStart(platform, env, startBody(platform, PUBKEY, START_CHECK))
    expect(res.status).toBe(200)
    const { url } = await res.json() as { url: string }
    expect(new URL(url).protocol).toBe('https:')
    expect(url).not.toContain(START_CHECK)
    const state = JSON.parse((await env.CACHE_KV.get(oauthStateKey(stateIdFrom(platform, url, capture)))) as string)
    expect(state.startCheck).toBe(START_CHECK)
    expect(state.returnUrl).toBe(PAGE_RETURN)
  })

  it.each(PLATFORMS)('%s: logs nothing that carries the start check', async (platform) => {
    if (platform === 'bluesky') vi.stubGlobal('fetch', blueskyStartFetch({}))
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    await postStart(platform, platformEnv(platform), startBody(platform, PUBKEY, START_CHECK))
    const logged = spies.flatMap((spy) => spy.mock.calls.flat().map(String))
    expect(logged.filter((line) => line.includes(START_CHECK))).toEqual([])
  })

  it('starts on any verifier host without redirecting (a redirect would drop the body)', async () => {
    const res = await postStart('twitter', baseEnv(), startBody('twitter', PUBKEY, START_CHECK), 'https://verifyer.divine.video')
    expect(res.status).toBe(200)
  })

  it.each([
    ['no start check', { pubkey: PUBKEY, return_url: PAGE_RETURN }],
    ['a short start check', { pubkey: PUBKEY, return_url: PAGE_RETURN, start_check: 'abc' }],
    ['a bad pubkey', { pubkey: 'nope', return_url: PAGE_RETURN, start_check: START_CHECK }],
    ['a return address on another page', { pubkey: PUBKEY, return_url: 'https://divine.video/somewhere', start_check: START_CHECK }],
  ])('refuses %s with 400', async (_label, body) => {
    expect((await postStart('twitter', baseEnv(), body)).status).toBe(400)
  })

  it('refuses a JSON body that is not an object with 400', async () => {
    const res = await app.request(`${BASE}/auth/twitter/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null',
    }, baseEnv())
    expect(res.status).toBe(400)
  })

  it('refuses a form post with 415 and a large body with 413', async () => {
    const form = await app.request(`${BASE}/auth/twitter/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `pubkey=${PUBKEY}`,
    }, baseEnv())
    expect(form.status).toBe(415)
    const big = await postStart('twitter', baseEnv(), { ...startBody('twitter', PUBKEY, START_CHECK), pad: 'x'.repeat(5000) })
    expect(big.status).toBe(413)
  })

  it('answers 429 once the IP is over its limit', async () => {
    const limited = {
      get: async (key: string) => (key.startsWith('rl:ip') ? '999' : null),
      put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
    } as unknown as KVNamespace
    expect((await postStart('twitter', baseEnv({ RATE_LIMIT_KV: limited }), startBody('twitter', PUBKEY, START_CHECK))).status).toBe(429)
  })

  it('returns to the verifier page when no return address is given', async () => {
    const env = baseEnv()
    const res = await postStart('twitter', env, { pubkey: PUBKEY, start_check: START_CHECK })
    const { url } = await res.json() as { url: string }
    const state = JSON.parse((await env.CACHE_KV.get(oauthStateKey(stateIdFrom('twitter', url, {})))) as string)
    expect(state.returnUrl).toBe(`${BASE}/`)
  })

  // A bare "/" can't carry the code back, so the default is always a full address.
  it('with no return address, returns to the verifier page on the host it started on', async () => {
    const env = baseEnv()
    const res = await postStart('twitter', env, { pubkey: PUBKEY, start_check: START_CHECK }, 'https://verifyer.divine.video')
    const { url } = await res.json() as { url: string }
    const state = JSON.parse((await env.CACHE_KV.get(oauthStateKey(stateIdFrom('twitter', url, {})))) as string)
    expect(state.returnUrl).toBe('https://verifyer.divine.video/')
  })

  it('with no return address, on a host that is not a verifier page, returns to the configured verifier page', async () => {
    const env = baseEnv()
    const res = await postStart('twitter', env, { pubkey: PUBKEY, start_check: START_CHECK }, 'https://other.example.com')
    const { url } = await res.json() as { url: string }
    const state = JSON.parse((await env.CACHE_KV.get(oauthStateKey(stateIdFrom('twitter', url, {})))) as string)
    expect(state.returnUrl).toBe(`${BASE}/`)
  })

  it('with no return address and no OAUTH_REDIRECT_BASE, says sign-in is not set up rather than blaming the return address', async () => {
    const res = await postStart('twitter', baseEnv({ OAUTH_REDIRECT_BASE: undefined }), { pubkey: PUBKEY, start_check: START_CHECK }, 'https://other.example.com')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Twitter OAuth not configured' })
  })

  it('with no OAUTH_REDIRECT_BASE, still refuses a return address it does not allow', async () => {
    const res = await postStart('twitter', baseEnv({ OAUTH_REDIRECT_BASE: undefined }), startBody('twitter', PUBKEY, START_CHECK, 'https://other.example.com/'))
    expect(res.status).toBe(400)
  })

  it('still says sign-in is not set up with 503', async () => {
    expect((await postStart('twitter', baseEnv({ TWITTER_CLIENT_ID: undefined }), startBody('twitter', PUBKEY, START_CHECK))).status).toBe(503)
  })
})

describe('GET /auth/:platform/start', () => {
  it.each(['optional', 'required'] as const)('refuses a start check in the address, in every mode (%s)', async (mode) => {
    const res = await app.request(`${BASE}/auth/twitter/start?pubkey=${PUBKEY}&start_check=${START_CHECK}`, {}, baseEnv({ SIGNIN_CONFIRMATION: mode }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'start_check is only accepted in a POST body' })
  })

  it('still starts for installed apps before the switch', async () => {
    const res = await app.request(`${BASE}/auth/twitter/start?pubkey=${PUBKEY}&return_url=${encodeURIComponent('https://divine.video/app/callback')}`, {}, baseEnv())
    expect(res.status).toBe(302)
  })

  it('once required, refuses an app\'s request with 400 and logs it', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await app.request(`${BASE}/auth/twitter/start?pubkey=${PUBKEY}&return_url=${encodeURIComponent('https://divine.video/app/callback')}`, {}, baseEnv({ SIGNIN_CONFIRMATION: 'required' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Update the Divine app to link by signing in' })
    expect(info.mock.calls).toEqual([['twitter sign-in start refused: GET start']])
  })

  it('once required, logs a platform it does not know as unknown', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await app.request(`${BASE}/auth/myspace/start?pubkey=${PUBKEY}`, {}, baseEnv({ SIGNIN_CONFIRMATION: 'required' }))
    expect(info.mock.calls).toEqual([['unknown sign-in start refused: GET start']])
  })

  it('once required, sends a browser back to its return address with a reason instead of a JSON page', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await app.request(`${BASE}/auth/twitter/start?pubkey=${PUBKEY}&return_url=${encodeURIComponent('https://divine.video/app/callback')}`,
      { headers: { 'Sec-Fetch-Mode': 'navigate' } }, baseEnv({ SIGNIN_CONFIRMATION: 'required' }))
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('Location') as string)
    expect(location.origin + location.pathname).toBe('https://divine.video/app/callback')
    expect(location.searchParams.get('oauth_error')).toBe('update the Divine app to link by signing in')
    expect(location.searchParams.get('oauth_error_code')).toBe('update_required')
  })

  it('once required, answers a browser with a return address it does not allow with 400, not a redirect', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await app.request(`${BASE}/auth/twitter/start?pubkey=${PUBKEY}&return_url=${encodeURIComponent('https://other.example.com/')}`,
      { headers: { 'Sec-Fetch-Mode': 'navigate' } }, baseEnv({ SIGNIN_CONFIRMATION: 'required' }))
    expect(res.status).toBe(400)
    expect(res.headers.get('Location')).toBeNull()
  })
})

// The shared test vector's start secret (43 × S).
const SECRET = 'S'.repeat(43)

// A really signed kind 10011, so the route's own signature check runs.
async function signedList(secretKey: Uint8Array, tags: string[][], createdAt = Math.floor(Date.now() / 1000)) {
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))
  const serialized = JSON.stringify([0, pubkey, createdAt, 10011, tags, ''])
  const id = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))))
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey))
  return { id, pubkey, created_at: createdAt, kind: 10011, tags, content: '', sig }
}

async function confirm(env: Bindings, body: unknown) {
  const res = await app.request(`${BASE}/auth/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, env)
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

// Status only: when a write fails the test app answers with Hono's plain-text 500.
async function confirmStatus(env: Bindings, body: unknown) {
  const res = await app.request(`${BASE}/auth/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, env)
  return res.status
}

// Starts through POST and finishes through the real callback; answers the
// code the callback sent and what the owner needs to confirm it.
async function startedAndFinished(platform: Platform, env: Bindings, opts: { secret?: string } = {}) {
  const secretKey = schnorr.utils.randomSecretKey()
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))
  const secret = opts.secret ?? SECRET
  const startCheck = await startCheckFor(secret)
  const capture: { stateId?: string } = {}
  if (platform === 'bluesky') vi.stubGlobal('fetch', blueskyStartFetch(capture))
  const start = await postStart(platform, env, startBody(platform, pubkey, startCheck))
  const { url } = await start.json() as { url: string }
  vi.stubGlobal('fetch', callbackFetchFor(platform))
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const res = await app.request(`${BASE}/auth/${platform}/callback?code=c&state=${stateIdFrom(platform, url, capture)}${callbackQueryExtra(platform)}`, {}, env)
  const code = new URLSearchParams(new URL(res.headers.get('Location') as string).hash.slice(1)).get('oauth_confirm') as string
  const binding = await confirmBindingFor(code, startCheck)
  const claim = `${platform}:${identityFor(platform)}`
  return { secretKey, pubkey, secret, startCheck, code, binding, claim }
}

describe('POST /auth/confirm', () => {
  it.each(PLATFORMS)('%s: saves a confirmed record when the owner signs the bound claim', async (platform) => {
    const env = platformEnv(platform, { SIGNIN_CONFIRMATION: 'required' })
    const s = await startedAndFinished(platform, env)
    const event = await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding], ['i', 'github:alice', 'gist']])
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await confirm(env, { code: s.code, start_secret: s.secret, event })
    expect(res).toEqual({ status: 200, json: { linked: true, platform, identity: identityFor(platform) } })
    for (const key of recordKeysFor(platform, s.pubkey)) {
      expect(JSON.parse((await env.CACHE_KV.get(key)) as string)).toMatchObject({ confirmed: true, confirm_event_id: event.id, confirm_created_at: event.created_at })
    }
    expect(info).toHaveBeenCalledWith(`${platform} sign-in confirmed`)
  })

  it.each([['twitter', '1'], ['youtube', 'UC1'], ['tiktok', 'open-1']] as const)(
    '%s: keeps the account\'s stable ID with the confirmed record, saved under the username only',
    async (platform, accountId) => {
      const env = platformEnv(platform, { SIGNIN_CONFIRMATION: 'required' })
      const s = await startedAndFinished(platform, env)
      const event = await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]])
      expect((await confirm(env, { code: s.code, start_secret: s.secret, event })).status).toBe(200)
      const record = JSON.parse((await env.CACHE_KV.get(oauthVerificationKey(platform, identityFor(platform), s.pubkey))) as string)
      expect(record).toMatchObject({ identity: identityFor(platform), account_id: accountId, confirmed: true })
      expect(await env.CACHE_KV.get(oauthVerificationKey(platform, accountId, s.pubkey))).toBeNull()
    },
  )

  it.each([['twitter', '1'], ['youtube', 'UC1'], ['tiktok', 'open-1']] as const)(
    '%s: refuses a claim of the account ID instead of the username, since only the username is linked',
    async (platform, accountId) => {
      const env = platformEnv(platform, { SIGNIN_CONFIRMATION: 'required' })
      const s = await startedAndFinished(platform, env)
      const event = await signedList(s.secretKey, [['i', `${platform}:${accountId}`, 'oauth', s.binding]])
      expect((await confirm(env, { code: s.code, start_secret: s.secret, event })).json.code).toBe('signin_claim_mismatch')
    },
  )

  it('answers the same event sent again with the same 200, and another event with 409', async () => {
    const env = baseEnv()
    const s = await startedAndFinished('twitter', env)
    const event = await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]])
    expect((await confirm(env, { code: s.code, start_secret: s.secret, event })).status).toBe(200)
    expect(await confirm(env, { code: s.code, start_secret: s.secret, event })).toEqual({ status: 200, json: { linked: true, platform: 'twitter', identity: 'jack' } })
    const other = await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]], event.created_at + 1)
    expect(await confirm(env, { code: s.code, start_secret: s.secret, event: other })).toMatchObject({ status: 409, json: { code: 'signin_used' } })
  })

  it('answers 404 for a code it does not know', async () => {
    const env = baseEnv()
    const s = await startedAndFinished('twitter', env)
    const event = await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]])
    expect(await confirm(env, { code: 'D'.repeat(43), start_secret: s.secret, event })).toMatchObject({ status: 404, json: { code: 'signin_not_found' } })
  })

  it('refuses another account\'s signature, and keeps the code for the right one', async () => {
    const env = baseEnv()
    const s = await startedAndFinished('twitter', env)
    const stranger = await signedList(schnorr.utils.randomSecretKey(), [['i', s.claim, 'oauth', s.binding]])
    expect(await confirm(env, { code: s.code, start_secret: s.secret, event: stranger })).toMatchObject({ status: 401, json: { code: 'signin_wrong_account' } })
    const own = await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]])
    expect((await confirm(env, { code: s.code, start_secret: s.secret, event: own })).status).toBe(200)
  })

  it('refuses the wrong start secret, and keeps the code for the right one', async () => {
    const env = baseEnv()
    const s = await startedAndFinished('twitter', env)
    const event = await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]])
    expect(await confirm(env, { code: s.code, start_secret: 'T'.repeat(43), event })).toMatchObject({ status: 401, json: { code: 'signin_not_yours', error: 'This sign-in was started somewhere else.' } })
    expect((await confirm(env, { code: s.code, start_secret: s.secret, event })).status).toBe(200)
  })

  it('refuses a claim bound with another start check, even with the right secret (injected return)', async () => {
    const env = baseEnv()
    const s = await startedAndFinished('twitter', env)
    const otherBinding = await confirmBindingFor(s.code, await startCheckFor('U'.repeat(43)))
    const event = await signedList(s.secretKey, [['i', s.claim, 'oauth', otherBinding]])
    expect(await confirm(env, { code: s.code, start_secret: s.secret, event })).toMatchObject({ status: 401, json: { code: 'signin_claim_mismatch' } })
  })

  it('refuses a public list without this code\'s binding (replay)', async () => {
    const env = baseEnv()
    const s = await startedAndFinished('twitter', env)
    const event = await signedList(s.secretKey, [['i', s.claim, 'oauth']])
    expect(await confirm(env, { code: s.code, start_secret: s.secret, event })).toMatchObject({ status: 401, json: { code: 'signin_claim_mismatch' } })
  })

  it('refuses the binding on another claim\'s tag, or a claim for another account', async () => {
    const env = baseEnv()
    const s = await startedAndFinished('twitter', env)
    const elsewhere = await signedList(s.secretKey, [['i', s.claim, 'oauth'], ['i', 'github:alice', 'gist', s.binding]])
    expect((await confirm(env, { code: s.code, start_secret: s.secret, event: elsewhere })).json.code).toBe('signin_claim_mismatch')
    const otherAccount = await signedList(s.secretKey, [['i', 'twitter:someone', 'oauth', s.binding]])
    expect((await confirm(env, { code: s.code, start_secret: s.secret, event: otherAccount })).json.code).toBe('signin_claim_mismatch')
    const notAnITag = await signedList(s.secretKey, [['r', s.claim, 'oauth', s.binding]])
    expect((await confirm(env, { code: s.code, start_secret: s.secret, event: notAnITag })).json.code).toBe('signin_claim_mismatch')
  })

  it('matches a Bluesky claim of the handle in capitals, or of the DID', async () => {
    for (const claim of [`bluesky:${BLUESKY_HANDLE.toUpperCase()}`, `bluesky:${BLUESKY_DID}`]) {
      const env = platformEnv('bluesky')
      const s = await startedAndFinished('bluesky', env)
      const event = await signedList(s.secretKey, [['i', claim, 'oauth', s.binding]])
      expect((await confirm(env, { code: s.code, start_secret: s.secret, event })).status).toBe(200)
    }
  })

  it('confirms two sign-ins in flight with their own secrets, and not with each other\'s', async () => {
    const env = baseEnv()
    const a = await startedAndFinished('twitter', env, { secret: 'A'.repeat(43) })
    const b = await startedAndFinished('twitter', env, { secret: 'B'.repeat(43) })
    const aEvent = await signedList(a.secretKey, [['i', a.claim, 'oauth', a.binding]])
    expect((await confirm(env, { code: a.code, start_secret: b.secret, event: aEvent })).json.code).toBe('signin_not_yours')
    expect((await confirm(env, { code: a.code, start_secret: a.secret, event: aEvent })).status).toBe(200)
    const bEvent = await signedList(b.secretKey, [['i', b.claim, 'oauth', b.binding]])
    expect((await confirm(env, { code: b.code, start_secret: b.secret, event: bEvent })).status).toBe(200)
  })

  it('accepts an event dated long ago, and refuses one more than ten minutes ahead', async () => {
    // A fixed clock, so the ten-minute limit can't move a second between the
    // event being dated and the verifier checking it.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
    try {
      const env = baseEnv()
      const s = await startedAndFinished('twitter', env)
      const now = Math.floor(Date.now() / 1000)
      const ahead = await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]], now + 601)
      expect((await confirm(env, { code: s.code, start_secret: s.secret, event: ahead })).json.code).toBe('invalid_event')
      const old = await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]], 1_600_000_000)
      expect((await confirm(env, { code: s.code, start_secret: s.secret, event: old })).status).toBe(200)
      // The record keeps the event's date for ordering and the server's time as when it was checked.
      const record = JSON.parse((await env.CACHE_KV.get(oauthVerificationKey('twitter', 'jack', s.pubkey))) as string)
      expect(record.confirm_created_at).toBe(1_600_000_000)
      expect(record.checked_at).toBe(now)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cannot confirm a sign-in started without a start check, even before the switch', async () => {
    const env = baseEnv()
    const { storePendingSignIn } = await import('../oauth/confirm')
    const secretKey = schnorr.utils.randomSecretKey()
    const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))
    await storePendingSignIn(env.CACHE_KV, 'C'.repeat(43), { platform: 'twitter', identity: 'jack', pubkey, finishedAt: 1 })
    const binding = await confirmBindingFor('C'.repeat(43), '')
    const event = await signedList(secretKey, [['i', 'twitter:jack', 'oauth', binding]])
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    expect(await confirm(env, { code: 'C'.repeat(43), start_secret: SECRET, event })).toMatchObject({ status: 401, json: { code: 'signin_not_yours', error: 'This sign-in was started somewhere else.' } })
    expect(info.mock.calls).toEqual([['twitter sign-in confirmation refused: no_start_check']])
  })

  it.each([
    ['a kind other than 10011', async (s: Awaited<ReturnType<typeof startedAndFinished>>) => ({ ...(await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]])), kind: 1 })],
    ['a bad signature', async (s: Awaited<ReturnType<typeof startedAndFinished>>) => ({ ...(await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]])), sig: 'f'.repeat(128) })],
    ['an id that does not match its contents', async (s: Awaited<ReturnType<typeof startedAndFinished>>) => ({ ...(await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]])), content: 'changed' })],
    ['a tag with a non-text value', async (s: Awaited<ReturnType<typeof startedAndFinished>>) => signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding], ['i', 1]] as unknown as string[][])],
  ])('refuses %s as invalid_event', async (_label, make) => {
    const env = baseEnv()
    const s = await startedAndFinished('twitter', env)
    expect(await confirm(env, { code: s.code, start_secret: s.secret, event: await make(s) })).toMatchObject({ status: 400, json: { code: 'invalid_event' } })
  })

  it('refuses a malformed code or secret, a form post, and a large body', async () => {
    const env = baseEnv()
    expect((await confirm(env, { code: 'short', start_secret: SECRET, event: {} })).json.code).toBe('invalid_request')
    expect(await confirm(env, { code: 'C'.repeat(43), start_secret: 'short', event: {} })).toMatchObject({ status: 400, json: { code: 'invalid_request' } })
    expect(await confirm(env, { code: 'C'.repeat(43), event: {} })).toMatchObject({ status: 400, json: { code: 'invalid_request' } })
    const form = await app.request(`${BASE}/auth/confirm`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }, env)
    expect(form.status).toBe(415)
    expect((await confirm(env, { code: 'C'.repeat(43), start_secret: SECRET, event: { pad: 'x'.repeat(70000) } })).status).toBe(413)
  })

  it('answers 429 once the IP is over its limit', async () => {
    const limited = {
      get: async (key: string) => (key.startsWith('rl:ip') ? '999' : null),
      put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
    } as unknown as KVNamespace
    const res = await app.request(`${BASE}/auth/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'C'.repeat(43), start_secret: SECRET, event: {} }),
    }, baseEnv({ RATE_LIMIT_KV: limited }))
    expect(res.status).toBe(429)
  })

  it('logs refusals with a reason and nothing that identifies anyone', async () => {
    const env = baseEnv()
    const s = await startedAndFinished('twitter', env)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const event = await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]])
    await confirm(env, { code: s.code, start_secret: 'T'.repeat(43), event })
    expect(info).toHaveBeenCalledWith('twitter sign-in confirmation refused: not_yours')
    const logged = JSON.stringify(info.mock.calls)
    for (const secret of [s.pubkey, s.code, s.binding, s.secret, 'jack']) expect(logged).not.toContain(secret)
  })

  it('keeps the pending sign-in when saving the record fails, so the owner can try again', async () => {
    const env = baseEnv()
    const s = await startedAndFinished('twitter', env)
    const event = await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]])
    const realPut = env.CACHE_KV.put.bind(env.CACHE_KV)
    env.CACHE_KV.put = (async (key: string, value: string, opts?: KVNamespacePutOptions) => {
      if (key.startsWith('oauth_verified:')) throw new Error('KV down')
      return realPut(key, value, opts)
    }) as typeof env.CACHE_KV.put
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await confirmStatus(env, { code: s.code, start_secret: s.secret, event })).toBe(500)
    env.CACHE_KV.put = realPut as typeof env.CACHE_KV.put
    expect((await confirm(env, { code: s.code, start_secret: s.secret, event })).status).toBe(200)
    expect(JSON.parse((await env.CACHE_KV.get(oauthVerificationKey('twitter', 'jack', s.pubkey))) as string)).toMatchObject({ confirmed: true, confirm_event_id: event.id })
  })

  it('when marking the code used fails, the same event sent again still succeeds through the pending sign-in', async () => {
    const env = baseEnv()
    const s = await startedAndFinished('twitter', env)
    const event = await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]])
    const realPut = env.CACHE_KV.put.bind(env.CACHE_KV)
    env.CACHE_KV.put = (async (key: string, value: string, opts?: KVNamespacePutOptions) => {
      if (key.startsWith('oauth_confirmed:')) throw new Error('KV down')
      return realPut(key, value, opts)
    }) as typeof env.CACHE_KV.put
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await confirmStatus(env, { code: s.code, start_secret: s.secret, event })).toBe(500)
    env.CACHE_KV.put = realPut as typeof env.CACHE_KV.put
    expect((await confirm(env, { code: s.code, start_secret: s.secret, event })).status).toBe(200)
  })

  it('still confirms when removing the pending sign-in fails, and says so without identifying anyone', async () => {
    const env = baseEnv()
    const s = await startedAndFinished('twitter', env)
    const event = await signedList(s.secretKey, [['i', s.claim, 'oauth', s.binding]])
    const realDelete = env.CACHE_KV.delete.bind(env.CACHE_KV)
    env.CACHE_KV.delete = (async (key: string) => {
      if (key.startsWith('oauth_pending:')) throw new Error('KV down')
      return realDelete(key)
    }) as typeof env.CACHE_KV.delete
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await confirm(env, { code: s.code, start_secret: s.secret, event })).toEqual({ status: 200, json: { linked: true, platform: 'twitter', identity: 'jack' } })
    expect(JSON.parse((await env.CACHE_KV.get(oauthVerificationKey('twitter', 'jack', s.pubkey))) as string)).toMatchObject({ confirmed: true, confirm_event_id: event.id })
    expect(warn.mock.calls).toEqual([['twitter sign-in confirmed: pending not removed']])
  })
})
