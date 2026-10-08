// ABOUTME: Sign-ins count only when finished in the browser that started them:
// ABOUTME: the cookie set at /start, the check at the callback, and the modes.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Bindings } from '../types'
import auth from './auth'
import { oauthStateKey } from '../oauth/state'

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
