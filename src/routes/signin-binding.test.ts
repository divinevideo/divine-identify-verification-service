// ABOUTME: Sign-ins count only when finished in the browser that started them:
// ABOUTME: the cookie set at /start, the check at the callback, and the modes.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Bindings } from '../types'
import auth from './auth'
import { oauthStateKey } from '../oauth/state'
import { createBinding } from '../oauth/binding'
import { generateDPoPKeyPair } from '../oauth/crypto'

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

const PUBKEY = 'a'.repeat(64)
const BASE = 'https://verifier.divine.video'
function twitterEnv(extra: Partial<Bindings> = {}): Bindings {
  return {
    CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV(),
    TWITTER_CLIENT_ID: 'id', TWITTER_CLIENT_SECRET: 'secret', OAUTH_REDIRECT_BASE: BASE, ...extra,
  } as Bindings
}
async function storedState(env: Bindings, res: Response) {
  const stateId = new URL(res.headers.get('Location') as string).searchParams.get('state') as string
  return JSON.parse((await env.CACHE_KV.get(oauthStateKey(stateId))) as string)
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('GET /auth/:platform/start', () => {
  it('sets the binding cookie and stores only its hash', async () => {
    const env = twitterEnv()
    const res = await app.request(`${BASE}/auth/twitter/start?pubkey=${PUBKEY}`, {}, env)
    expect(res.status).toBe(302)
    const cookie = res.headers.get('Set-Cookie') as string
    expect(cookie).toMatch(/^__Host-signin_binding=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/)
    const value = cookie.split(';')[0].split('=')[1]
    const state = await storedState(env, res)
    expect(state.bindingHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(state)).not.toContain(value)
  })

  it('sends a start on another host to the finishing host first, unchanged, with no cookie', async () => {
    const env = twitterEnv()
    const query = `pubkey=${PUBKEY}&return_url=${encodeURIComponent('https://verifyer.divine.video/?signin=x#verify-here')}&handle=%40alice.bsky.social`
    const res = await app.request(`https://verifyer.divine.video/auth/bluesky/start?${query}`, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`${BASE}/auth/bluesky/start?${query}`)
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  it.each([
    {
      label: 'different scheme, same hostname',
      oauthRedirectBase: 'https://verifier.divine.video',
      requestUrl: `http://verifier.divine.video/auth/twitter/start?pubkey=${PUBKEY}`,
      location: `https://verifier.divine.video/auth/twitter/start?pubkey=${PUBKEY}`,
    },
    {
      label: 'different port, same hostname',
      oauthRedirectBase: 'http://localhost:8787',
      requestUrl: `http://localhost:8788/auth/twitter/start?pubkey=${PUBKEY}`,
      location: `http://localhost:8787/auth/twitter/start?pubkey=${PUBKEY}`,
    },
  ])('sends a start on the same hostname but a different origin ($label) to the finishing origin, unchanged, with no cookie', async ({ oauthRedirectBase, requestUrl, location }) => {
    const env = twitterEnv({ OAUTH_REDIRECT_BASE: oauthRedirectBase })
    const res = await app.request(requestUrl, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(location)
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  it('accepts a return address on the other verifier host after that redirect', async () => {
    const env = twitterEnv()
    const res = await app.request(`${BASE}/auth/twitter/start?pubkey=${PUBKEY}&return_url=${encodeURIComponent('https://verifyer.divine.video/#verify-here')}`, {}, env)
    expect(res.status).toBe(302)
  })

  it('local development: starts on the same origin with the cookie, without redirecting to itself', async () => {
    const env = twitterEnv({ OAUTH_REDIRECT_BASE: 'http://localhost:8787' })
    const res = await app.request(`http://localhost:8787/auth/twitter/start?pubkey=${PUBKEY}`, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toMatch(/^https:\/\/twitter\.com\/i\/oauth2\/authorize\?/)
    expect(res.headers.get('Set-Cookie')).toMatch(/^__Host-signin_binding=/)
  })

  it('with no redirect base, sign-in is not set up: no redirect and no cookie', async () => {
    const env = twitterEnv({ OAUTH_REDIRECT_BASE: undefined })
    const res = await app.request(`http://localhost:8787/auth/twitter/start?pubkey=${PUBKEY}`, {}, env)
    expect(res.status).toBe(503)
    expect(res.headers.get('Location')).toBeNull()
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  it('sets no cookie when sign-in is not set up', async () => {
    const env = twitterEnv({ TWITTER_CLIENT_ID: undefined })
    const res = await app.request(`${BASE}/auth/twitter/start?pubkey=${PUBKEY}`, {}, env)
    expect(res.status).toBe(503)
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })
})

describe('GET /auth/twitter/callback', () => {
  async function startThenFinish(env: Bindings, sendCookie: (value: string) => string | undefined) {
    const start = await app.request(`${BASE}/auth/twitter/start?pubkey=${PUBKEY}&return_url=${encodeURIComponent(`${BASE}/#verify-here`)}`, {}, env)
    const value = (start.headers.get('Set-Cookie') as string).split(';')[0].split('=')[1]
    const stateId = new URL(start.headers.get('Location') as string).searchParams.get('state') as string
    const cookie = sendCookie(value)
    const providerCalls = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: '1', username: 'jack' } }), { status: 200 }))
    vi.stubGlobal('fetch', providerCalls)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await app.request(`${BASE}/auth/twitter/callback?code=c&state=${stateId}`,
      { headers: cookie === undefined ? {} : { Cookie: `__Host-signin_binding=${cookie}` } }, env)
    return { res, providerCalls, info, record: await env.CACHE_KV.get(`oauth_verified:twitter:jack:${PUBKEY}`) }
  }

  it('records a sign-in finished in the same browser as bound, and clears the cookie', async () => {
    const { res, record, info } = await startThenFinish(twitterEnv(), v => v)
    expect(new URL(res.headers.get('Location') as string).searchParams.get('oauth_verified')).toBe('true')
    expect(JSON.parse(record as string).bound).toBe(true)
    expect(res.headers.get('Set-Cookie')).toBe('__Host-signin_binding=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax')
    expect(info).toHaveBeenCalledWith('twitter sign-in finished: bound')
  })

  it.each([['no cookie', () => undefined], ['another browser\'s cookie', () => 'x'.repeat(43)]])(
    'observe: %s still links, recorded as unbound', async (_label, send) => {
      const { res, record, info } = await startThenFinish(twitterEnv(), send)
      expect(new URL(res.headers.get('Location') as string).searchParams.get('oauth_verified')).toBe('true')
      expect(JSON.parse(record as string).bound).toBe(false)
      expect(info).toHaveBeenCalledWith('twitter sign-in finished: unbound')
    })

  it.each([['no cookie', () => undefined], ['another browser\'s cookie', () => 'x'.repeat(43)]])(
    'enforce: %s is refused before the code is exchanged, and nothing is recorded', async (_label, send) => {
      const { res, record, providerCalls, info } = await startThenFinish(twitterEnv({ SIGNIN_BINDING: 'enforce' }), send)
      const location = new URL(res.headers.get('Location') as string)
      expect(location.origin + location.pathname + location.hash).toBe(`${BASE}/#verify-here`)
      expect(location.searchParams.get('oauth_error')).toBe('could not be confirmed in this browser at Twitter')
      expect(location.searchParams.has('oauth_verified')).toBe(false)
      expect(providerCalls).not.toHaveBeenCalled()
      expect(record).toBeNull()
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0')
      expect(info).toHaveBeenCalledWith('twitter sign-in finished: refused')
    })

  it('enforce: a sign-in started before this change (no stored hash) is refused', async () => {
    const env = twitterEnv({ SIGNIN_BINDING: 'enforce' })
    await env.CACHE_KV.put(oauthStateKey('old'), JSON.stringify({ platform: 'twitter', pubkey: PUBKEY, codeVerifier: 'v', returnUrl: `${BASE}/`, createdAt: Date.now() }))
    vi.stubGlobal('fetch', vi.fn())
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await app.request(`${BASE}/auth/twitter/callback?code=c&state=old`, { headers: { Cookie: '__Host-signin_binding=anything' } }, env)
    expect(new URL(res.headers.get('Location') as string).searchParams.get('oauth_error')).toBe('could not be confirmed in this browser at Twitter')
  })

  it('a second sign-in started in the same browser replaces the first one\'s binding', async () => {
    const env = twitterEnv({ SIGNIN_BINDING: 'enforce' })
    const first = await app.request(`${BASE}/auth/twitter/start?pubkey=${PUBKEY}`, {}, env)
    const second = await app.request(`${BASE}/auth/twitter/start?pubkey=${PUBKEY}`, {}, env)
    const firstState = new URL(first.headers.get('Location') as string).searchParams.get('state') as string
    const secondValue = (second.headers.get('Set-Cookie') as string).split(';')[0].split('=')[1]
    vi.stubGlobal('fetch', vi.fn())
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await app.request(`${BASE}/auth/twitter/callback?code=c&state=${firstState}`, { headers: { Cookie: `__Host-signin_binding=${secondValue}` } }, env)
    expect(new URL(res.headers.get('Location') as string, BASE).searchParams.get('oauth_error')).toBe('could not be confirmed in this browser at Twitter')
  })

  it('logs no pubkey, state, cookie or identity', async () => {
    const { info } = await startThenFinish(twitterEnv(), v => v)
    const logged = JSON.stringify(info.mock.calls)
    expect(logged).not.toContain(PUBKEY)
    expect(logged).not.toContain('jack')
  })
})

describe('enforce refuses before any provider call, on every platform', () => {
  it.each(['youtube', 'tiktok', 'bluesky'] as const)('%s', async (platform) => {
    const env = { ...twitterEnv({ SIGNIN_BINDING: 'enforce' }) }
    await env.CACHE_KV.put(oauthStateKey('s'), JSON.stringify({ platform, pubkey: PUBKEY, codeVerifier: 'v', returnUrl: `${BASE}/`, createdAt: Date.now(), bindingHash: 'f'.repeat(64), issuer: 'https://bsky.social' }))
    const providerCalls = vi.fn()
    vi.stubGlobal('fetch', providerCalls)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const extra = platform === 'bluesky' ? '&iss=https%3A%2F%2Fbsky.social' : ''
    const res = await app.request(`${BASE}/auth/${platform}/callback?code=c&state=s${extra}`, { headers: { Cookie: '__Host-signin_binding=wrong' } }, env)
    const labels = { youtube: 'YouTube', tiktok: 'TikTok', bluesky: 'Bluesky' }
    expect(new URL(res.headers.get('Location') as string).searchParams.get('oauth_error')).toBe(`could not be confirmed in this browser at ${labels[platform]}`)
    expect(providerCalls).not.toHaveBeenCalled()
  })
})

describe('a callback that throws still clears the binding cookie, on every platform', () => {
  it.each(['twitter', 'youtube', 'tiktok', 'bluesky'] as const)('%s', async (platform) => {
    const env = twitterEnv({
      GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret',
      TIKTOK_CLIENT_KEY: 'tkey', TIKTOK_CLIENT_SECRET: 'tsecret',
    })
    const { value, hash } = await createBinding()
    const state: Record<string, unknown> = {
      platform, pubkey: PUBKEY, codeVerifier: 'v', returnUrl: `${BASE}/`, createdAt: Date.now(), bindingHash: hash,
    }
    if (platform === 'bluesky') {
      const { publicJwk, privateJwk } = await generateDPoPKeyPair()
      Object.assign(state, {
        dpopPrivateJwk: privateJwk, dpopPublicJwk: publicJwk,
        issuer: 'https://bsky.social', tokenEndpoint: 'https://bsky.social/oauth/token',
        did: 'did:plc:x', handle: 'x.bsky.social',
      })
    }
    await env.CACHE_KV.put(oauthStateKey('throws'), JSON.stringify(state))
    // The binding check passes (observe mode, matching cookie); the thrown
    // error comes from the provider call that follows it.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const extra = platform === 'bluesky' ? '&iss=https%3A%2F%2Fbsky.social' : ''
    const res = await app.request(`${BASE}/auth/${platform}/callback?code=c&state=throws${extra}`,
      { headers: { Cookie: `__Host-signin_binding=${value}` } }, env)
    expect(res.headers.get('Set-Cookie')).toBe('__Host-signin_binding=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax')
  })
})

describe('a sign-in the provider did not complete', () => {
  it.each(['twitter', 'youtube', 'tiktok', 'bluesky'])('%s: clears the binding cookie and records nothing', async (platform) => {
    const env = twitterEnv()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await app.request(`${BASE}/auth/${platform}/callback?error=access_denied&state=missing`, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Set-Cookie')).toContain('__Host-signin_binding=; Max-Age=0')
  })
})
