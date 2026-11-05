import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Bindings, OAuthVerification } from '../types'
import type { SignedNostrEvent } from '../utils/nostr-event'
import auth, { isAllowedReturnUrl } from './auth'
import worker from '../index'
import { oauthStateKey, oauthVerificationKey, storeOAuthVerification } from '../oauth/state'
import { sha256Hex } from '../oauth/unlink-proof'

// Mount auth sub-app at /auth to match production routing
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

function createTestEnv(): Bindings {
  return {
    CACHE_KV: createMockKV(),
    RATE_LIMIT_KV: createMockKV(),
  }
}

const REVOKE_URL = 'http://localhost/auth/oauth/revoke'

function buildNip98Event(
  pubkey: string,
  overrides: Partial<{ url: string; method: string; created_at: number }> = {}
) {
  return {
    id: 'a'.repeat(64),
    pubkey,
    sig: 'b'.repeat(128),
    kind: 27235,
    tags: [
      ['u', overrides.url || REVOKE_URL],
      ['method', overrides.method || 'POST'],
    ],
    created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    content: '',
  }
}

const LOGIN_URL = 'http://localhost/auth/nostr/login'

// A really signed NIP-98 event (NIP-01 id + BIP-340 signature), so these tests
// exercise the verifier's own signature check rather than a stubbed upstream.
async function signNip98Event(
  secretKey: Uint8Array,
  overrides: Partial<{ url: string; method: string; created_at: number; content: string }> = {}
) {
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))
  const created_at = overrides.created_at ?? Math.floor(Date.now() / 1000)
  const tags = [
    ['u', overrides.url || REVOKE_URL],
    ['method', overrides.method || 'POST'],
  ]
  const content = overrides.content ?? ''
  const serialized = JSON.stringify([0, pubkey, created_at, 27235, tags, content])
  const id = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))))
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey))
  return { id, pubkey, sig, kind: 27235, tags, created_at, content }
}

// The verifier must check signatures itself; reaching out to another service
// to do it is the bug these tests guard against.
function forbidUpstreamFetch() {
  const fetchSpy = vi.fn(() => { throw new Error('verifier must not call an upstream service to check NIP-98') })
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('POST /auth/oauth/revoke', () => {
  const testPubkey = 'aa'.repeat(32)

  it('rejects missing body fields', async () => {
    const env = createTestEnv()
    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env)
    expect(res.status).toBe(400)
  })

  it('rejects unsupported platform', async () => {
    const env = createTestEnv()
    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'github',
        identity: 'user',
        pubkey: testPubkey,
        event: buildNip98Event(testPubkey),
      }),
    }, env)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toMatch(/OAuth/)
  })

  it('rejects invalid pubkey', async () => {
    const env = createTestEnv()
    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'twitter',
        identity: 'user',
        pubkey: 'not-a-pubkey',
        event: buildNip98Event('not-a-pubkey'),
      }),
    }, env)
    expect(res.status).toBe(400)
  })

  it('will not revoke another user\'s record with a validly signed event from a different key', async () => {
    const env = createTestEnv()
    const victimPubkey = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))
    const victimKey = `oauth_verified:twitter:alice:${victimPubkey}`
    await env.CACHE_KV.put(victimKey, JSON.stringify({ verified: true }))
    // A real, correctly addressed event, but signed by someone else.
    const attackerEvent = await signNip98Event(schnorr.utils.randomSecretKey())
    forbidUpstreamFetch()

    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'twitter', identity: 'alice', pubkey: victimPubkey, event: attackerEvent }),
    }, env)
    expect(res.status).toBe(401)
    expect(await env.CACHE_KV.get(victimKey)).not.toBeNull()
  })

  it('rejects NIP-98 events for a different URL', async () => {
    const env = createTestEnv()
    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'twitter',
        identity: 'user',
        pubkey: testPubkey,
        event: buildNip98Event(testPubkey, { url: 'http://localhost/auth/nostr/login' }),
      }),
    }, env)
    expect(res.status).toBe(401)
    const data = await res.json() as { error: string }
    expect(data.error).toMatch(/URL/)
  })

  it('rejects NIP-98 events for a different method', async () => {
    const env = createTestEnv()
    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'twitter',
        identity: 'user',
        pubkey: testPubkey,
        event: buildNip98Event(testPubkey, { method: 'GET' }),
      }),
    }, env)
    expect(res.status).toBe(401)
    const data = await res.json() as { error: string }
    expect(data.error).toMatch(/method/)
  })

  it('rejects stale NIP-98 events', async () => {
    const env = createTestEnv()
    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'twitter',
        identity: 'user',
        pubkey: testPubkey,
        event: buildNip98Event(testPubkey, {
          created_at: Math.floor(Date.now() / 1000) - 600,
        }),
      }),
    }, env)
    expect(res.status).toBe(401)
    const data = await res.json() as { error: string }
    expect(data.error).toMatch(/too old/)
  })

  it('returns revoked:true and deletes KV entry for an event signed by a non-admin key, without calling any upstream', async () => {
    const env = createTestEnv()
    const secretKey = schnorr.utils.randomSecretKey()
    const event = await signNip98Event(secretKey)
    const key = `oauth_verified:twitter:alice:${event.pubkey}`
    await env.CACHE_KV.put(key, JSON.stringify({ verified: true }))
    const fetchSpy = forbidUpstreamFetch()

    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'twitter',
        identity: 'alice',
        pubkey: event.pubkey,
        event,
      }),
    }, env)
    expect(res.status).toBe(200)
    const data = await res.json() as { revoked: boolean; platform: string; identity: string }
    expect(data.revoked).toBe(true)
    expect(data.platform).toBe('twitter')
    expect(data.identity).toBe('alice')
    expect(fetchSpy).not.toHaveBeenCalled()

    const after = await env.CACHE_KV.get(key)
    expect(after).toBeNull()
  })

  it('deletes the signer\'s record when the body pubkey is sent in uppercase', async () => {
    const env = createTestEnv()
    const event = await signNip98Event(schnorr.utils.randomSecretKey())
    const key = `oauth_verified:twitter:alice:${event.pubkey}`
    await env.CACHE_KV.put(key, JSON.stringify({ verified: true }))
    forbidUpstreamFetch()

    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'twitter', identity: 'Alice', pubkey: event.pubkey.toUpperCase(), event }),
    }, env)
    expect(res.status).toBe(200)
    expect(await env.CACHE_KV.get(key)).toBeNull()
  })

  it('returns revoked:true even when KV entry already absent (idempotent)', async () => {
    const env = createTestEnv()
    const event = await signNip98Event(schnorr.utils.randomSecretKey())
    forbidUpstreamFetch()

    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'bluesky',
        identity: 'alice.bsky.social',
        pubkey: event.pubkey,
        event,
      }),
    }, env)
    expect(res.status).toBe(200)
    const data = await res.json() as { revoked: boolean }
    expect(data.revoked).toBe(true)
  })

  it('rejects an event whose signature was not made by its pubkey', async () => {
    const env = createTestEnv()
    const secretKey = schnorr.utils.randomSecretKey()
    const event = await signNip98Event(secretKey)
    // Correct id, but a signature over a different message.
    const forged = { ...event, sig: bytesToHex(schnorr.sign(hexToBytes('11'.repeat(32)), secretKey)) }
    const key = `oauth_verified:twitter:alice:${event.pubkey}`
    await env.CACHE_KV.put(key, JSON.stringify({ verified: true }))
    forbidUpstreamFetch()

    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'twitter', identity: 'alice', pubkey: event.pubkey, event: forged }),
    }, env)
    expect(res.status).toBe(401)
    const data = await res.json() as { error: string }
    expect(data.error).toMatch(/signature/i)
    expect(await env.CACHE_KV.get(key)).not.toBeNull()
  })

  async function revokeWith(event: Record<string, unknown>, pubkey = event.pubkey as string) {
    return app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'twitter', identity: 'alice', pubkey, event }),
    }, createTestEnv())
  }

  describe('time window (NIP-98 suggests 60 seconds)', () => {
    // Pin the clock so the boundary is exact rather than racing the wall clock.
    const NOW = 1_790_000_000
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW * 1000)
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('accepts events exactly 60 seconds old or ahead', async () => {
      forbidUpstreamFetch()
      for (const created_at of [NOW - 60, NOW + 60]) {
        const res = await revokeWith(await signNip98Event(schnorr.utils.randomSecretKey(), { created_at }))
        expect(res.status).toBe(200)
      }
    })

    it('rejects events 61 seconds old or ahead', async () => {
      forbidUpstreamFetch()
      for (const created_at of [NOW - 61, NOW + 61]) {
        const res = await revokeWith(await signNip98Event(schnorr.utils.randomSecretKey(), { created_at }))
        expect(res.status).toBe(401)
      }
    })
  })

  it('rejects malformed NIP-98 fields before checking the signature', async () => {
    forbidUpstreamFetch()
    const event = await signNip98Event(schnorr.utils.randomSecretKey())
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...event, created_at: event.created_at + 0.5 }, /created_at/],
      [{ ...event, content: 7 }, /content/],
      [{ ...event, kind: 1 }, /kind/],
      [{ ...event, pubkey: event.pubkey.toUpperCase() }, /lowercase/],
      [{ ...event, sig: event.sig.toUpperCase() }, /lowercase/],
      [{ ...event, id: event.id.toUpperCase() }, /lowercase/],
      [{ ...event, tags: {} }, /tags/],
      [{ ...event, tags: null }, /tags/],
      [{ ...event, tags: [...event.tags, 'x'] }, /tags/],
      [{ ...event, id: [event.id] }, /required/],
      [{ ...event, pubkey: 5 }, /required/],
      [{ ...event, sig: [event.sig] }, /required/],
    ]
    for (const [bad, message] of cases) {
      const res = await revokeWith(bad, event.pubkey)
      expect(res.status).toBe(400)
      const data = await res.json() as { error: string }
      expect(data.error).toMatch(message)
    }
  })

  it('rejects an event whose id does not match its contents', async () => {
    const env = createTestEnv()
    const event = await signNip98Event(schnorr.utils.randomSecretKey())
    // Signed as-is, then altered: the id and signature no longer cover the event.
    const tampered = { ...event, content: 'altered after signing' }
    forbidUpstreamFetch()

    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'twitter', identity: 'alice', pubkey: event.pubkey, event: tampered }),
    }, env)
    expect(res.status).toBe(401)
    const data = await res.json() as { error: string }
    expect(data.error).toMatch(/id does not match/)
  })
})

describe('POST /auth/nostr/login', () => {
  async function login(event: unknown) {
    return app.request('/auth/nostr/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event }),
    }, createTestEnv())
  }

  it('accepts an event signed for this endpoint by a non-admin key and returns its pubkey, without calling any upstream', async () => {
    const event = await signNip98Event(schnorr.utils.randomSecretKey(), { url: LOGIN_URL })
    const fetchSpy = forbidUpstreamFetch()

    const res = await login(event)
    expect(res.status).toBe(200)
    const data = await res.json() as { authenticated: boolean; pubkey: string }
    expect(data.authenticated).toBe(true)
    expect(data.pubkey).toBe(event.pubkey)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects an event signed for login.divine.video instead of this endpoint', async () => {
    const event = await signNip98Event(schnorr.utils.randomSecretKey(), { url: 'https://login.divine.video/api/auth/login' })
    forbidUpstreamFetch()

    const res = await login(event)
    expect(res.status).toBe(401)
    const data = await res.json() as { error: string }
    expect(data.error).toMatch(/URL/)
  })

  it('rejects an event whose signature was not made by its pubkey', async () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const event = await signNip98Event(secretKey, { url: LOGIN_URL })
    const forged = { ...event, sig: bytesToHex(schnorr.sign(hexToBytes('22'.repeat(32)), secretKey)) }
    forbidUpstreamFetch()

    const res = await login(forged)
    expect(res.status).toBe(401)
    const data = await res.json() as { error: string }
    expect(data.error).toMatch(/signature/i)
  })
})

describe('POST /auth/oauth/revoke rejects a non-text or malformed identity with 400, not a crash', () => {
  for (const identity of [123, ['a'], { a: 1 }, 'x'.repeat(501), 'a<b']) {
    it(`identity ${JSON.stringify(identity)}`, async () => {
      forbidUpstreamFetch()
      const event = await signNip98Event(schnorr.utils.randomSecretKey())
      const res = await app.request('/auth/oauth/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'twitter', identity, pubkey: event.pubkey, event }),
      }, createTestEnv())
      expect(res.status).toBe(400)
    })
  }
})

describe('NIP-98 routes reject a null JSON body with 400, not a crash', () => {
  for (const path of ['/auth/nostr/login', '/auth/oauth/revoke']) {
    it(`POST ${path}`, async () => {
      forbidUpstreamFetch()
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'null',
      }, createTestEnv())
      expect(res.status).toBe(400)
    })
  }
})

describe('isAllowedReturnUrl', () => {
  it('accepts only the verifier pages and the app\'s return address, by origin and path', () => {
    expect(isAllowedReturnUrl('https://verifier.divine.video/')).toBe(true)
    expect(isAllowedReturnUrl('https://verifier.divine.video/?signin=abc#verify-here')).toBe(true)
    expect(isAllowedReturnUrl('https://verifyer.divine.video/?signin=abc#verify-here')).toBe(true)
    expect(isAllowedReturnUrl('https://verifyer.divine.video/other')).toBe(false)
    expect(isAllowedReturnUrl('https://divine.video/app/callback')).toBe(true)
    expect(isAllowedReturnUrl('https://divine.video/app/callback?signin=abc')).toBe(true)
    expect(isAllowedReturnUrl('https://verify.divine.video/#verify-here')).toBe(false)
    expect(isAllowedReturnUrl('https://divine.video/')).toBe(false)
    expect(isAllowedReturnUrl('https://divine.video/app/callback/x')).toBe(false)
    expect(isAllowedReturnUrl('https://www.divine.video/app/callback')).toBe(false)
    expect(isAllowedReturnUrl('https://verifier.divine.video/other')).toBe(false)
  })

  it('refuses near misses of an allowed page', () => {
    expect(isAllowedReturnUrl('https://divine.video/app/callback/..')).toBe(false)
    expect(isAllowedReturnUrl('http://divine.video/app/callback')).toBe(false)
    expect(isAllowedReturnUrl('https://divine.video./app/callback')).toBe(false)
    expect(isAllowedReturnUrl('https://divine.video:8443/app/callback')).toBe(false)
  })

  it('refuses an allowed page with a user name or password in the address', () => {
    expect(isAllowedReturnUrl('https://someone@divine.video/app/callback')).toBe(false)
    expect(isAllowedReturnUrl('https://:secret@verifier.divine.video/')).toBe(false)
    expect(isAllowedReturnUrl('http://someone@localhost:5173/x', 'http://localhost:8787')).toBe(false)
  })

  it('rejects untrusted origins (open-redirect guard still holds)', () => {
    expect(isAllowedReturnUrl('https://evil.example.com/')).toBe(false)
    // A trusted host as a subdomain label must not slip through.
    expect(isAllowedReturnUrl('https://verify.divine.video.evil.com/')).toBe(false)
  })

  it('honours the configured OAUTH_REDIRECT_BASE page', () => {
    expect(isAllowedReturnUrl('https://staging.divine.video/?signin=x', 'https://staging.divine.video')).toBe(true)
    expect(isAllowedReturnUrl('https://staging.divine.video/x', 'https://staging.divine.video')).toBe(false)
  })

  it('returns false for malformed input', () => {
    expect(isAllowedReturnUrl('not a url')).toBe(false)
  })

  it('accepts localhost addresses only when the verifier itself runs locally', () => {
    expect(isAllowedReturnUrl('http://localhost:5173/x')).toBe(false)
    expect(isAllowedReturnUrl('http://127.0.0.1:3000/x', 'https://verifier.divine.video')).toBe(false)
    expect(isAllowedReturnUrl('http://localhost:5173/x', 'http://127.0.0.1:8787')).toBe(true)
    expect(isAllowedReturnUrl('http://127.0.0.1:3000/x', 'http://localhost:8787')).toBe(true)
    // Running locally widens the rule to localhost only, not to every address.
    expect(isAllowedReturnUrl('https://example.com/x', 'http://localhost:8787')).toBe(false)
  })

  it('treats the verifier as local when the request itself reaches it on localhost', () => {
    // No .dev.vars: no base at all.
    expect(isAllowedReturnUrl('http://localhost:8787/#verify-here', undefined, 'http://localhost:8787/auth/twitter/start')).toBe(true)
    // A public tunnel as the base (Bluesky and TikTok need one), page opened at localhost.
    expect(isAllowedReturnUrl('http://localhost:8787/#verify-here', 'https://abc.trycloudflare.com', 'http://localhost:8787/auth/bluesky/start')).toBe(true)
    // The IPv6 loopback address.
    expect(isAllowedReturnUrl('http://[::1]:8787/x', undefined, 'http://[::1]:8787/auth/twitter/start')).toBe(true)
    expect(isAllowedReturnUrl('http://[::1]:5173/x', 'http://[::1]:8787')).toBe(true)
    // Still only local addresses, even then.
    expect(isAllowedReturnUrl('https://example.com/x', undefined, 'http://localhost:8787/auth/twitter/start')).toBe(false)
  })

  it('turns away localhost addresses when the request reaches the live verifier', () => {
    expect(isAllowedReturnUrl('http://localhost:5173/x', 'https://verifier.divine.video', 'https://verifier.divine.video/auth/twitter/start')).toBe(false)
    expect(isAllowedReturnUrl('http://localhost:5173/x', undefined, 'https://verifier.divine.video/auth/twitter/start')).toBe(false)
  })

  it('accepts only web addresses, even on a trusted origin', () => {
    expect(isAllowedReturnUrl('blob:https://verifier.divine.video/x')).toBe(false)
    expect(isAllowedReturnUrl('blob:https://staging.divine.video/x', 'https://staging.divine.video')).toBe(false)
  })

  it('accepts only web addresses on localhost during local development', () => {
    expect(isAllowedReturnUrl('https://localhost:5173/x', 'http://localhost:8787')).toBe(true)
    // file://localhost/x would parse with an empty hostname and never reach the
    // protocol check, so use an address that does.
    expect(isAllowedReturnUrl('file://127.0.0.1/x', 'http://localhost:8787')).toBe(false)
    expect(isAllowedReturnUrl('ws://localhost:5173/x', 'http://localhost:8787')).toBe(false)
    expect(isAllowedReturnUrl('ftp://localhost/x', 'http://localhost:8787')).toBe(false)
  })
})

describe('GET /auth/:platform/start return address', () => {
  it('turns away a localhost return address in production', async () => {
    const env = { ...createTestEnv(), OAUTH_REDIRECT_BASE: 'https://verifier.divine.video' }
    // A Bluesky start looks the handle up upstream, so if this check ever
    // lets the address through, fail here instead of calling bsky.social.
    const upstream = vi.fn(() => { throw new Error('a turned-away sign-in must not contact the provider') })
    vi.stubGlobal('fetch', upstream)
    const res = await app.request(`https://verifier.divine.video/auth/bluesky/start?pubkey=${'a'.repeat(64)}&handle=alice.bsky.social&return_url=${encodeURIComponent('http://localhost:5173/x')}`, {}, env)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid return_url: must be a trusted origin' })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('says sign-in is not set up, rather than blaming the return address, on a local verifier with no settings', async () => {
    const res = await app.request(`http://localhost:8787/auth/twitter/start?pubkey=${'a'.repeat(64)}&return_url=${encodeURIComponent('http://localhost:8787/?signin=abc#verify-here')}`, {}, createTestEnv())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Twitter OAuth not configured' })
  })

  it('starts a sign-in that returns to a local page when the verifier runs locally', async () => {
    const env = {
      ...createTestEnv(),
      TWITTER_CLIENT_ID: 'test-client-id',
      TWITTER_CLIENT_SECRET: 'test-client-secret',
      OAUTH_REDIRECT_BASE: 'http://localhost:8787',
    }
    // Reached on the configured local address, so the verifier counts as
    // running locally and accepts a local return address.
    const res = await app.request(`http://localhost:8787/auth/twitter/start?pubkey=${'a'.repeat(64)}&return_url=${encodeURIComponent('http://localhost:5173/?signin=abc#verify-here')}`, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toMatch(/^https:\/\/twitter\.com\/i\/oauth2\/authorize\?/)
  })
})

describe('GET /auth/tiktok/start', () => {
  const pubkey = 'aa'.repeat(32)
  const configured = {
    TIKTOK_CLIENT_KEY: 'sandbox-key',
    TIKTOK_CLIENT_SECRET: 'sandbox-secret',
    OAUTH_REDIRECT_BASE: 'https://verifier.divine.video',
  }

  // Absolute, on the live host: a bare path would reach the verifier on
  // http://localhost, where it counts as running locally.
  function startUrl(): string {
    return `https://verifier.divine.video/auth/tiktok/start?pubkey=${pubkey}&return_url=https://verifier.divine.video/`
  }

  it('returns 503 when production OAuth is not enabled', async () => {
    const env = { ...createTestEnv(), ...configured }
    const res = await app.request(startUrl(), {}, env)
    expect(res.status).toBe(503)
  })

  it('starts OAuth once production OAuth is enabled and the flow is configured', async () => {
    const env = { ...createTestEnv(), ...configured, TIKTOK_OAUTH_ENABLED: 'true' }
    const res = await app.request(startUrl(), {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('tiktok.com')
  })

  it('starts OAuth for sandbox reviewers who carry the review cookie', async () => {
    const env = { ...createTestEnv(), ...configured }
    const res = await app.request(startUrl(), {
      headers: { Cookie: 'tiktok_oauth_review=1' },
    }, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('tiktok.com')
  })
})

describe('GET /auth/twitter/callback return address', () => {
  it('keeps the page\'s one-time code when it sends the person back', async () => {
    const env = {
      ...createTestEnv(),
      TWITTER_CLIENT_ID: 'test-client-id',
      TWITTER_CLIENT_SECRET: 'test-client-secret',
      OAUTH_REDIRECT_BASE: 'https://verifier.divine.video',
    }
    await env.CACHE_KV.put(oauthStateKey('state-1'), JSON.stringify({
      platform: 'twitter',
      pubkey: 'a'.repeat(64),
      codeVerifier: 'verifier',
      returnUrl: 'https://verifier.divine.video/?signin=abc123#verify-here',
      createdAt: Date.now(),
    }))
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: '1', username: 'jack' } }), { status: 200 })))
    vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const res = await app.request('/auth/twitter/callback?code=abc&state=state-1', {}, env)
      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('Location') as string)
      expect(location.searchParams.get('signin')).toBe('abc123')
      expect(location.searchParams.get('oauth_verified')).toBe('true')
      expect(location.hash).toBe('#verify-here')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('GET /auth/:platform/callback after the person cancels or denies sign-in', () => {
  const PLATFORMS = ['twitter', 'youtube', 'tiktok', 'bluesky'] as const
  const RETURN_URL = 'https://verifier.divine.video/#verify-here'
  const LABELS = { twitter: 'Twitter', youtube: 'YouTube', tiktok: 'TikTok', bluesky: 'Bluesky' }

  // The cancel path logs; keep that out of the test output and let the log
  // test read what was written. The file-level afterEach restores the spies.
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  async function storeState(env: Bindings, stateId: string, platform: string) {
    await env.CACHE_KV.put(oauthStateKey(stateId), JSON.stringify({
      platform,
      pubkey: 'a'.repeat(64),
      codeVerifier: 'verifier',
      returnUrl: RETURN_URL,
      createdAt: Date.now(),
    }))
  }

  it.each(PLATFORMS)('%s: sends the person back to where they started, with a reason', async (platform) => {
    const env = createTestEnv()
    await storeState(env, 'state-1', platform)
    const res = await app.request(`/auth/${platform}/callback?error=access_denied&state=state-1`, {}, env)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('Location') as string)
    expect(location.origin + location.pathname).toBe('https://verifier.divine.video/')
    expect(location.hash).toBe('#verify-here')
    expect(location.searchParams.get('oauth_error')).toBe(`cancelled or declined at ${LABELS[platform]}`)
    expect(location.searchParams.get('oauth_error_code')).toBe('cancelled')
    expect(location.searchParams.has('oauth_verified')).toBe(false)
  })

  it.each(PLATFORMS)('%s: uses up the stored sign-in state', async (platform) => {
    const env = createTestEnv()
    await storeState(env, 'state-1', platform)
    await app.request(`/auth/${platform}/callback?error=access_denied&state=state-1`, {}, env)
    expect(await env.CACHE_KV.get(oauthStateKey('state-1'))).toBeNull()
  })

  it.each(PLATFORMS)('%s: falls back to the verifier page when the state is unknown or expired', async (platform) => {
    const res = await app.request(`/auth/${platform}/callback?error=access_denied&state=missing`, {}, createTestEnv())
    expect(res.status).toBe(302)
    const location = res.headers.get('Location') as string
    expect(location.startsWith('/?')).toBe(true)
    expect(new URLSearchParams(location.slice(2)).get('oauth_error')).toBe(`cancelled or declined at ${LABELS[platform]}`)
    expect(new URLSearchParams(location.slice(2)).get('oauth_error_code')).toBe('cancelled')
  })

  it.each(PLATFORMS)('%s: falls back to the verifier page when the provider sends no state', async (platform) => {
    const res = await app.request(`/auth/${platform}/callback?error=access_denied`, {}, createTestEnv())
    expect(res.status).toBe(302)
    const location = res.headers.get('Location') as string
    expect(location.startsWith('/?')).toBe(true)
    expect(new URLSearchParams(location.slice(2)).get('oauth_error')).toBe(`cancelled or declined at ${LABELS[platform]}`)
    expect(new URLSearchParams(location.slice(2)).get('oauth_error_code')).toBe('cancelled')
  })

  it.each(PLATFORMS)('%s: falls back to the verifier page when the state store fails', async (platform) => {
    const env = createTestEnv()
    env.CACHE_KV = { ...env.CACHE_KV, get: async () => { throw new Error('storage unavailable') } } as unknown as KVNamespace
    const res = await app.request(`/auth/${platform}/callback?error=access_denied&state=state-1`, {}, env)
    expect(res.status).toBe(302)
    const location = res.headers.get('Location') as string
    expect(location.startsWith('/?')).toBe(true)
    expect(new URLSearchParams(location.slice(2)).get('oauth_error')).toBe(`cancelled or declined at ${LABELS[platform]}`)
    expect(new URLSearchParams(location.slice(2)).get('oauth_error_code')).toBe('cancelled')
  })

  it('ignores, and keeps, a state that belongs to a different platform', async () => {
    const env = createTestEnv()
    await storeState(env, 'state-1', 'bluesky')
    const res = await app.request('/auth/twitter/callback?error=access_denied&state=state-1', {}, env)
    expect(res.status).toBe(302)
    expect((res.headers.get('Location') as string).startsWith('/?')).toBe(true)
    expect(await env.CACHE_KV.get(oauthStateKey('state-1'))).not.toBeNull()
  })

  it('logs only a well-formed provider error code, never its description or the state id', async () => {
    const env = createTestEnv()
    await storeState(env, 'state-1', 'twitter')
    await app.request('/auth/twitter/callback?error=access_denied&error_description=private+detail&state=state-1', {}, env)
    await app.request('/auth/twitter/callback?error=%3Cb%3Eboom%3C%2Fb%3E&state=state-2', {}, env)
    expect(warn.mock.calls.map(call => call[1])).toEqual(['access_denied', 'other'])
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain('private detail')
    expect(logged).not.toContain('state-1')
    expect(logged).not.toContain('boom')
  })

  it.each(PLATFORMS)('%s: describes a provider-side error as not completed, not as a cancel', async (platform) => {
    const env = createTestEnv()
    await storeState(env, 'state-1', platform)
    const res = await app.request(`/auth/${platform}/callback?error=server_error&state=state-1`, {}, env)
    const location = new URL(res.headers.get('Location') as string)
    expect(location.origin + location.pathname).toBe('https://verifier.divine.video/')
    expect(location.searchParams.get('oauth_error')).toBe(`could not be completed at ${LABELS[platform]}`)
    expect(location.searchParams.get('oauth_error_code')).toBe('provider_error')
  })

  it('still returns the person to where they started when clearing the state fails', async () => {
    const env = createTestEnv()
    await storeState(env, 'state-1', 'twitter')
    env.CACHE_KV = { ...env.CACHE_KV, delete: async () => { throw new Error('storage unavailable') } } as unknown as KVNamespace
    const res = await app.request('/auth/twitter/callback?error=access_denied&state=state-1', {}, env)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('Location') as string)
    expect(location.origin + location.pathname + location.hash).toBe('https://verifier.divine.video/#verify-here')
    expect(location.searchParams.get('oauth_error')).toBe('cancelled or declined at Twitter')
  })

  it('does not pass the provider\'s error text through to the page', async () => {
    const env = createTestEnv()
    await storeState(env, 'state-1', 'twitter')
    const res = await app.request('/auth/twitter/callback?error=%3Cb%3Eboom%3C%2Fb%3E&state=state-1', {}, env)
    const location = new URL(res.headers.get('Location') as string)
    expect(location.searchParams.get('oauth_error')).toBe('could not be completed at Twitter')
    expect(location.searchParams.get('oauth_error_code')).toBe('provider_error')
  })

  it('replaces a reason code the return address arrived with', async () => {
    const env = createTestEnv()
    await env.CACHE_KV.put(oauthStateKey('state-1'), JSON.stringify({
      platform: 'twitter',
      pubkey: 'a'.repeat(64),
      codeVerifier: 'verifier',
      returnUrl: 'https://verifier.divine.video/?oauth_error_code=failed&oauth_error_code=other#verify-here',
      createdAt: Date.now(),
    }))
    const res = await app.request('/auth/twitter/callback?error=access_denied&state=state-1', {}, env)
    const location = new URL(res.headers.get('Location') as string)
    expect(location.searchParams.getAll('oauth_error_code')).toEqual(['cancelled'])
  })
})

describe('GET /auth/bluesky/start handle', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  // The page strips a leading @ before starting; apps may not, and people type
  // their handle the way Bluesky shows it.
  it('looks up the handle without a leading @ or surrounding spaces', async () => {
    for (const typed of ['@alice.bsky.social', ' @alice.bsky.social ', '  alice.bsky.social', '@ alice.bsky.social']) {
      const upstream = vi.fn(async (_input: RequestInfo | URL) => new Response('{}', { status: 404 }))
      vi.stubGlobal('fetch', upstream)
      await app.request(`https://verifier.divine.video/auth/bluesky/start?pubkey=${'a'.repeat(64)}&handle=${encodeURIComponent(typed)}`, {}, { ...createTestEnv(), OAUTH_REDIRECT_BASE: 'https://verifier.divine.video' })
      const lookup = String(upstream.mock.calls[0]?.[0])
      expect(lookup, typed).toContain('resolveHandle?handle=alice.bsky.social')
    }
  })

  it('treats a handle that is only @ as missing', async () => {
    const upstream = vi.fn(() => { throw new Error('a missing handle must not contact the provider') })
    vi.stubGlobal('fetch', upstream)
    const res = await app.request(`https://verifier.divine.video/auth/bluesky/start?pubkey=${'a'.repeat(64)}&handle=${encodeURIComponent(' @ ')}`, {}, { ...createTestEnv(), OAUTH_REDIRECT_BASE: 'https://verifier.divine.video' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Missing handle parameter (e.g., user.bsky.social)' })
    expect(upstream).not.toHaveBeenCalled()
  })
})

async function revoke(env: Bindings, identity: string, event: Awaited<ReturnType<typeof signNip98Event>>) {
  return app.request('/auth/oauth/revoke', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'bluesky', identity, pubkey: event.pubkey, event }),
  }, env)
}

describe('unlinking a kept Bluesky sign-in', () => {
  const DID = 'did:plc:alice111111111111111111'
  async function linked(env: Bindings, pubkey: string) {
    const record = (identity: string) => JSON.stringify({ platform: 'bluesky', identity, pubkey, verified: true, method: 'oauth', checked_at: 1, account_id: DID, handle: 'alice.bsky.social' })
    await env.CACHE_KV.put(`oauth_verified:bluesky:alice.bsky.social:${pubkey}`, record('alice.bsky.social'))
    await env.CACHE_KV.put(`oauth_verified:bluesky:${DID}:${pubkey}`, record(DID))
  }

  for (const identity of ['alice.bsky.social', DID]) {
    it(`removes both the handle and the DID record when unlinking by ${identity.startsWith('did:') ? 'DID' : 'handle'}`, async () => {
      const env = createTestEnv()
      const event = await signNip98Event(schnorr.utils.randomSecretKey())
      await linked(env, event.pubkey)
      forbidUpstreamFetch()
      const res = await app.request('/auth/oauth/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'bluesky', identity, pubkey: event.pubkey, event }),
      }, env)
      expect(res.status).toBe(200)
      expect(await env.CACHE_KV.get(`oauth_verified:bluesky:alice.bsky.social:${event.pubkey}`)).toBeNull()
      expect(await env.CACHE_KV.get(`oauth_verified:bluesky:${DID}:${event.pubkey}`)).toBeNull()
    })
  }

  it('can be retried when part of an unlink fails', async () => {
    const env = createTestEnv()
    const event = await signNip98Event(schnorr.utils.randomSecretKey())
    await linked(env, event.pubkey)
    const realDelete = env.CACHE_KV.delete.bind(env.CACHE_KV)
    let failed = false
    env.CACHE_KV.delete = async (key: string) => {
      if (!failed && key.includes(DID)) { failed = true; throw new Error('KV DELETE failed') }
      return realDelete(key)
    }
    forbidUpstreamFetch()
    expect((await revoke(env, 'alice.bsky.social', event)).status).toBe(500)
    expect((await revoke(env, 'alice.bsky.social', event)).status).toBe(200)
    expect(await env.CACHE_KV.get(`oauth_verified:bluesky:alice.bsky.social:${event.pubkey}`)).toBeNull()
    expect(await env.CACHE_KV.get(`oauth_verified:bluesky:${DID}:${event.pubkey}`)).toBeNull()
  })
})

describe('unlinking after the Bluesky handle changed', () => {
  const DID = 'did:plc:alice111111111111111111'
  const record = (identity: string, handle: string, pubkey: string) => JSON.stringify({ platform: 'bluesky', identity, pubkey, verified: true, method: 'oauth', checked_at: 1, account_id: DID, handle })

  it('does not remove the newer link when the old handle is unlinked', async () => {
    const env = createTestEnv()
    const event = await signNip98Event(schnorr.utils.randomSecretKey())
    await env.CACHE_KV.put(`oauth_verified:bluesky:alice.bsky.social:${event.pubkey}`, record('alice.bsky.social', 'alice.bsky.social', event.pubkey))
    await env.CACHE_KV.put(`oauth_verified:bluesky:alice2.bsky.social:${event.pubkey}`, record('alice2.bsky.social', 'alice2.bsky.social', event.pubkey))
    await env.CACHE_KV.put(`oauth_verified:bluesky:${DID}:${event.pubkey}`, record(DID, 'alice2.bsky.social', event.pubkey))
    forbidUpstreamFetch()
    expect((await revoke(env, 'alice.bsky.social', event)).status).toBe(200)
    expect(await env.CACHE_KV.get(`oauth_verified:bluesky:alice.bsky.social:${event.pubkey}`)).toBeNull()
    expect(await env.CACHE_KV.get(`oauth_verified:bluesky:${DID}:${event.pubkey}`)).not.toBeNull()
    expect(await env.CACHE_KV.get(`oauth_verified:bluesky:alice2.bsky.social:${event.pubkey}`)).not.toBeNull()
  })

  it('does not remove a handle now linked to a different account when the DID is unlinked', async () => {
    const env = createTestEnv()
    const event = await signNip98Event(schnorr.utils.randomSecretKey())
    const otherDid = 'did:plc:other222222222222222222'
    await env.CACHE_KV.put(`oauth_verified:bluesky:${DID}:${event.pubkey}`, record(DID, 'alice.bsky.social', event.pubkey))
    // alice.bsky.social later moved to another account, which this person linked too
    await env.CACHE_KV.put(`oauth_verified:bluesky:alice.bsky.social:${event.pubkey}`, JSON.stringify({ platform: 'bluesky', identity: 'alice.bsky.social', pubkey: event.pubkey, verified: true, method: 'oauth', checked_at: 1, account_id: otherDid, handle: 'alice.bsky.social' }))
    forbidUpstreamFetch()
    expect((await revoke(env, DID, event)).status).toBe(200)
    expect(await env.CACHE_KV.get(`oauth_verified:bluesky:${DID}:${event.pubkey}`)).toBeNull()
    expect(await env.CACHE_KV.get(`oauth_verified:bluesky:alice.bsky.social:${event.pubkey}`)).not.toBeNull()
  })
})

describe('GET /auth/bluesky/status for a kept sign-in', () => {
  it('is verified while the handle still points to the linked account', async () => {
    const env = createTestEnv()
    const pubkey = 'a'.repeat(64)
    await env.CACHE_KV.put(`oauth_verified:bluesky:alice.bsky.social:${pubkey}`, JSON.stringify({ platform: 'bluesky', identity: 'alice.bsky.social', pubkey, verified: true, method: 'oauth', checked_at: Math.floor(Date.now() / 1000), account_id: 'did:plc:alice111111111111111111', handle: 'alice.bsky.social' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ did: 'did:plc:alice111111111111111111' }), { status: 200 })))
    const res = await app.request(`/auth/bluesky/status?pubkey=${pubkey}&identity=alice.bsky.social`, {}, env)
    expect(await res.json()).toMatchObject({ verified: true, method: 'oauth' })
  })

  it('is not verified when the handle now points to a different account', async () => {
    const env = createTestEnv()
    const pubkey = 'a'.repeat(64)
    await env.CACHE_KV.put(`oauth_verified:bluesky:alice.bsky.social:${pubkey}`, JSON.stringify({ platform: 'bluesky', identity: 'alice.bsky.social', pubkey, verified: true, method: 'oauth', checked_at: Math.floor(Date.now() / 1000), account_id: 'did:plc:alice111111111111111111', handle: 'alice.bsky.social' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ did: 'did:plc:other222222222222222222' }), { status: 200 })))
    const res = await app.request(`/auth/bluesky/status?pubkey=${pubkey}&identity=alice.bsky.social`, {}, env)
    expect((await res.json() as { verified: boolean }).verified).toBe(false)
  })
})

// Signed the same way as signNip98Event, for any kind and tags.
async function signEvent(secretKey: Uint8Array, kind: number, tags: string[][], createdAt = Math.floor(Date.now() / 1000)): Promise<SignedNostrEvent> {
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))
  const content = ''
  const serialized = JSON.stringify([0, pubkey, createdAt, kind, tags, content])
  const id = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))))
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey))
  return { id, pubkey, sig, kind, tags, created_at: createdAt, content }
}

const aliceKey = (pubkey: string) => oauthVerificationKey('twitter', 'alice', pubkey)

async function seedRecord(env: Bindings, over: Partial<OAuthVerification> & { pubkey: string }) {
  await storeOAuthVerification(env.CACHE_KV, {
    platform: 'twitter', identity: 'alice', verified: true, method: 'oauth',
    checked_at: 1000, confirmed: true, confirm_event_id: '5'.repeat(64), confirm_created_at: 2000,
    ...over,
  })
}

function revokeRequest(env: Bindings, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/auth/oauth/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }, env)
}

const nostrHeader = (event: unknown) => 'Nostr ' + btoa(JSON.stringify(event))

const bodySha = (body: unknown) => sha256Hex(new TextEncoder().encode(JSON.stringify(body)))

async function headerEvent(secretKey: Uint8Array, payload: string | null, createdAt?: number) {
  const tags = [['u', REVOKE_URL], ['method', 'POST'], ...(payload === null ? [] : [['payload', payload]])]
  return signEvent(secretKey, 27235, tags, createdAt)
}

async function errorCode(res: Response) {
  return ((await res.json()) as { code?: string }).code
}

describe('POST /auth/oauth/revoke body and NIP-98 proofs', () => {
  afterEach(() => { vi.useRealTimers() })

  it('answers 413 to a body over 64 KiB and keeps the record', async () => {
    const env = createTestEnv()
    const key = schnorr.utils.randomSecretKey()
    const event = await signNip98Event(key)
    await seedRecord(env, { pubkey: event.pubkey })
    forbidUpstreamFetch()
    const res = await revokeRequest(env, { platform: 'twitter', identity: 'alice', pubkey: event.pubkey, event, pad: 'a'.repeat(65536) })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'Request body too large' })
    expect(await env.CACHE_KV.get(aliceKey(event.pubkey))).not.toBeNull()
  })

  it('answers 415 to a body sent without a JSON content type', async () => {
    const env = createTestEnv()
    const event = await signNip98Event(schnorr.utils.randomSecretKey())
    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ platform: 'twitter', identity: 'alice', pubkey: event.pubkey, event }),
    }, env)
    expect(res.status).toBe(415)
  })

  it('accepts an Authorization header whose payload is the sha256 of the body', async () => {
    const env = createTestEnv()
    const key = schnorr.utils.randomSecretKey()
    const pubkey = bytesToHex(schnorr.getPublicKey(key))
    await seedRecord(env, { pubkey })
    const body = { platform: 'twitter', identity: 'alice', pubkey }
    const event = await headerEvent(key, await bodySha(body))
    forbidUpstreamFetch()
    const res = await revokeRequest(env, body, { Authorization: nostrHeader(event) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: true, platform: 'twitter', identity: 'alice' })
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).toBeNull()
  })

  it('refuses a header whose payload does not match the body, or has none', async () => {
    const env = createTestEnv()
    const key = schnorr.utils.randomSecretKey()
    const pubkey = bytesToHex(schnorr.getPublicKey(key))
    await seedRecord(env, { pubkey })
    const body = { platform: 'twitter', identity: 'alice', pubkey }
    forbidUpstreamFetch()
    for (const payload of [await bodySha({ ...body, identity: 'bob' }), null]) {
      const res = await revokeRequest(env, body, { Authorization: nostrHeader(await headerEvent(key, payload)) })
      expect(res.status, String(payload)).toBe(401)
      expect(await errorCode(res)).toBe('unlink_proof_invalid')
      expect(await env.CACHE_KV.get(aliceKey(pubkey))).not.toBeNull()
    }
  })

  it('refuses a malformed Nostr Authorization header', async () => {
    const env = createTestEnv()
    const pubkey = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))
    forbidUpstreamFetch()
    for (const header of ['Nostr', 'Nostr !!!']) {
      const res = await revokeRequest(env, { platform: 'twitter', identity: 'alice', pubkey }, { Authorization: header })
      expect(res.status, header).toBe(400)
      expect(await errorCode(res)).toBe('unlink_proof_invalid')
    }
  })

  it('refuses an unreadable or invalid Nostr header even when the body carries a valid event', async () => {
    const env = createTestEnv()
    const key = schnorr.utils.randomSecretKey()
    const event = await signNip98Event(key)
    await seedRecord(env, { pubkey: event.pubkey })
    const body = { platform: 'twitter', identity: 'alice', pubkey: event.pubkey, event }
    forbidUpstreamFetch()
    const cases: Array<[string, string, number]> = [
      ['unreadable', 'Nostr !!!', 400],
      ['no payload', nostrHeader(await headerEvent(key, null)), 401],
    ]
    for (const [name, header, status] of cases) {
      const res = await revokeRequest(env, body, { Authorization: header })
      expect(res.status, name).toBe(status)
      expect(await errorCode(res), name).toBe('unlink_proof_invalid')
      expect(await env.CACHE_KV.get(aliceKey(event.pubkey)), name).not.toBeNull()
    }
  })

  it('uses the header when the body also carries an event', async () => {
    const env = createTestEnv()
    const key = schnorr.utils.randomSecretKey()
    const pubkey = bytesToHex(schnorr.getPublicKey(key))
    await seedRecord(env, { pubkey })
    const body = { platform: 'twitter', identity: 'alice', pubkey, event: await signNip98Event(schnorr.utils.randomSecretKey()) }
    forbidUpstreamFetch()
    const res = await revokeRequest(env, body, { Authorization: nostrHeader(await headerEvent(key, await bodySha(body))) })
    expect(res.status).toBe(200)
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).toBeNull()
  })

  it('ignores an Authorization header with another scheme', async () => {
    const env = createTestEnv()
    const event = await signNip98Event(schnorr.utils.randomSecretKey())
    await seedRecord(env, { pubkey: event.pubkey })
    forbidUpstreamFetch()
    const res = await revokeRequest(env, { platform: 'twitter', identity: 'alice', pubkey: event.pubkey, event }, { Authorization: 'Bearer abc' })
    expect(res.status).toBe(200)
    expect(await env.CACHE_KV.get(aliceKey(event.pubkey))).toBeNull()
  })

  it('refuses a header signed by a key other than the body pubkey', async () => {
    const env = createTestEnv()
    const pubkey = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))
    await seedRecord(env, { pubkey })
    const body = { platform: 'twitter', identity: 'alice', pubkey }
    forbidUpstreamFetch()
    const res = await revokeRequest(env, body, { Authorization: nostrHeader(await headerEvent(schnorr.utils.randomSecretKey(), await bodySha(body))) })
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('unlink_proof_invalid')
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).not.toBeNull()
  })

  it('refuses a NIP-98 event dated before the server saved the link, and accepts the same second', async () => {
    const T = 1_790_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T * 1000)
    const env = createTestEnv()
    const key = schnorr.utils.randomSecretKey()
    const pubkey = bytesToHex(schnorr.getPublicKey(key))
    await seedRecord(env, { pubkey, checked_at: T + 30, confirm_created_at: T + 30 })
    forbidUpstreamFetch()

    const early = await revokeRequest(env, { platform: 'twitter', identity: 'alice', pubkey, event: await signNip98Event(key, { created_at: T }) })
    expect(early.status).toBe(401)
    expect(await errorCode(early)).toBe('unlink_proof_invalid')
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).not.toBeNull()

    vi.setSystemTime((T + 30) * 1000)
    const same = await revokeRequest(env, { platform: 'twitter', identity: 'alice', pubkey, event: await signNip98Event(key, { created_at: T + 30 }) })
    expect(same.status).toBe(200)
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).toBeNull()
  })

  it('after unlinking and linking again, the earlier NIP-98 event is refused', async () => {
    const T = 1_790_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T * 1000)
    const env = createTestEnv()
    const key = schnorr.utils.randomSecretKey()
    const pubkey = bytesToHex(schnorr.getPublicKey(key))
    await seedRecord(env, { pubkey, checked_at: T - 100, confirm_created_at: T - 100 })
    const event = await signNip98Event(key, { created_at: T - 5 })
    const body = { platform: 'twitter', identity: 'alice', pubkey, event }
    forbidUpstreamFetch()
    expect((await revokeRequest(env, body)).status).toBe(200)
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).toBeNull()

    await seedRecord(env, { pubkey, checked_at: T, confirm_created_at: T })
    const replay = await revokeRequest(env, body)
    expect(replay.status).toBe(401)
    expect(await errorCode(replay)).toBe('unlink_proof_invalid')
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).not.toBeNull()
  })

  it('unlinks immediately with either NIP-98 form when the confirming list was dated ahead', async () => {
    const T = 1_790_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T * 1000)
    const env = createTestEnv()
    const key = schnorr.utils.randomSecretKey()
    const pubkey = bytesToHex(schnorr.getPublicKey(key))
    const body = { platform: 'twitter', identity: 'alice', pubkey }
    for (const form of ['body', 'header']) {
      await seedRecord(env, { pubkey, checked_at: T, confirm_created_at: T + 120 })
      const res = form === 'body'
        ? await revokeRequest(env, { ...body, event: await signNip98Event(key) })
        : await revokeRequest(env, body, { Authorization: nostrHeader(await headerEvent(key, await bodySha(body))) })
      expect(res.status, form).toBe(200)
      expect(await env.CACHE_KV.get(aliceKey(pubkey))).toBeNull()
    }
  })

  it('deletes the requested key even when its initial KV read is a cached miss', async () => {
    const env = createTestEnv()
    const event = await signNip98Event(schnorr.utils.randomSecretKey())
    await seedRecord(env, { pubkey: event.pubkey })
    const get = env.CACHE_KV.get.bind(env.CACHE_KV)
    const read = vi.spyOn(env.CACHE_KV as { get(key: string): Promise<string | null> }, 'get').mockResolvedValue(null)
    const del = vi.spyOn(env.CACHE_KV, 'delete')
    expect((await revokeRequest(env, { platform: 'twitter', identity: '@alice', pubkey: event.pubkey, event })).status).toBe(200)
    expect(read).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith(aliceKey(event.pubkey))
    expect(await get(aliceKey(event.pubkey))).toBeNull()
  })

  it('marks every refused NIP-98 proof unlink_proof_invalid', async () => {
    const env = createTestEnv()
    const key = schnorr.utils.randomSecretKey()
    const event = await signNip98Event(key)
    await seedRecord(env, { pubkey: event.pubkey })
    forbidUpstreamFetch()
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['wrong URL', await signNip98Event(key, { url: LOGIN_URL }), event.pubkey],
      ['wrong method', await signNip98Event(key, { method: 'GET' }), event.pubkey],
      ['61 seconds old', await signNip98Event(key, { created_at: Math.floor(Date.now() / 1000) - 61 }), event.pubkey],
      ['bad signature', { ...event, sig: bytesToHex(schnorr.sign(hexToBytes('11'.repeat(32)), key)) }, event.pubkey],
      ['id mismatch', { ...event, content: 'altered after signing' }, event.pubkey],
      ['pubkey mismatch', await signNip98Event(schnorr.utils.randomSecretKey()), event.pubkey],
    ]
    for (const [name, bad, pubkey] of cases) {
      const res = await revokeRequest(env, { platform: 'twitter', identity: 'alice', pubkey, event: bad })
      expect(res.status, name).toBeGreaterThanOrEqual(400)
      expect(await errorCode(res), name).toBe('unlink_proof_invalid')
    }
    expect(await env.CACHE_KV.get(aliceKey(event.pubkey))).not.toBeNull()
  })
})

describe('POST /auth/oauth/revoke with a signed list', () => {
  const DID = 'did:plc:alice111111111111111111'
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(2005 * 1000)
  })
  afterEach(() => { vi.useRealTimers() })

  function owner() {
    const key = schnorr.utils.randomSecretKey()
    return { key, pubkey: bytesToHex(schnorr.getPublicKey(key)) }
  }

  const listRevoke = (env: Bindings, pubkey: string, list: unknown, platform = 'twitter', identity = 'alice') =>
    revokeRequest(env, { platform, identity, pubkey, list })

  it('removes the record when a newer list no longer holds the claim, and /verify then answers signin_expired', async () => {
    const env = { ...createTestEnv(), SIGNIN_CONFIRMATION: 'required' } as Bindings
    const { key, pubkey } = owner()
    const now = Math.floor(Date.now() / 1000)
    await seedRecord(env, { pubkey, checked_at: now, confirm_created_at: now - 10 })
    forbidUpstreamFetch()
    const claim = { platform: 'twitter', identity: 'alice', proof: 'oauth', pubkey }
    const verify = async () => {
      const res = await worker.fetch(new Request('http://localhost/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claims: [claim] }),
      }), env)
      return ((await res.json()) as { results: Array<{ verified: boolean; code?: string }> }).results[0]
    }
    expect((await verify()).verified).toBe(true)

    const list = await signEvent(key, 10011, [['i', 'github:alice', 'gist1']], now - 9)
    const res = await listRevoke(env, pubkey, list)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: true, platform: 'twitter', identity: 'alice' })
    expect(await verify()).toMatchObject({ verified: false, code: 'signin_expired' })
  })

  it('treats an empty event field as absent and unlinks through the list', async () => {
    const env = { ...createTestEnv(), SIGNIN_CONFIRMATION: 'required' } as Bindings
    const { key, pubkey } = owner()
    const now = Math.floor(Date.now() / 1000)
    await seedRecord(env, { pubkey, checked_at: now, confirm_created_at: now - 10 })
    const list = await signEvent(key, 10011, [['i', 'github:alice', 'gist1']], now - 9)
    const res = await revokeRequest(env, { platform: 'twitter', identity: 'alice', pubkey, event: '', list })
    expect(res.status).toBe(200)
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).toBeNull()
  })

  it('treats an empty list field as absent, so a request with no other proof is a missing-field error', async () => {
    const env = { ...createTestEnv(), SIGNIN_CONFIRMATION: 'required' } as Bindings
    const { pubkey } = owner()
    await seedRecord(env, { pubkey })
    const res = await revokeRequest(env, { platform: 'twitter', identity: 'alice', pubkey, list: '' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/^Missing required fields/)
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).not.toBeNull()
  })

  it('refuses a list dated before the confirmation', async () => {
    const env = createTestEnv()
    const { key, pubkey } = owner()
    await seedRecord(env, { pubkey })
    const res = await listRevoke(env, pubkey, await signEvent(key, 10011, [], 1999))
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe('unlink_list_older')
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).not.toBeNull()
  })

  it('on the same second, refuses a higher id and accepts a lower one', async () => {
    const env = createTestEnv()
    const { key, pubkey } = owner()
    const list = await signEvent(key, 10011, [], 2000)
    await seedRecord(env, { pubkey, confirm_event_id: '0'.repeat(64) })
    const higher = await listRevoke(env, pubkey, list)
    expect(higher.status).toBe(409)
    expect(await errorCode(higher)).toBe('unlink_list_older')
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).not.toBeNull()

    await seedRecord(env, { pubkey, confirm_event_id: 'f'.repeat(64) })
    expect((await listRevoke(env, pubkey, list)).status).toBe(200)
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).toBeNull()
  })

  it('refuses a list that still holds the claim', async () => {
    const env = createTestEnv()
    const { key, pubkey } = owner()
    await seedRecord(env, { pubkey })
    const res = await listRevoke(env, pubkey, await signEvent(key, 10011, [['i', 'twitter:alice', 'oauth']], 2001))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      code: 'unlink_claim_listed',
      error: 'This list still holds the linked account. Remove the remaining row for this account (including any alternate handle or platform name), then retry.',
    })
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).not.toBeNull()
  })

  it('refuses a list that still holds the claim as @Alice', async () => {
    const env = createTestEnv()
    const { key, pubkey } = owner()
    await seedRecord(env, { pubkey })
    const res = await listRevoke(env, pubkey, await signEvent(key, 10011, [['i', 'twitter:@Alice', 'oauth']], 2001))
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe('unlink_claim_listed')
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).not.toBeNull()
  })

  it('refuses a Bluesky unlink while the DID is still listed, and removes both records when neither is', async () => {
    const env = createTestEnv()
    const { key, pubkey } = owner()
    for (const identity of ['alice.bsky.social', DID]) {
      await seedRecord(env, { pubkey, platform: 'bluesky', identity, checked_at: 1, account_id: DID, handle: 'alice.bsky.social' })
    }
    const handleKey = oauthVerificationKey('bluesky', 'alice.bsky.social', pubkey)
    const didKey = oauthVerificationKey('bluesky', DID, pubkey)

    const listed = await listRevoke(env, pubkey, await signEvent(key, 10011, [['i', `bluesky:${DID}`, 'oauth']], 2001), 'bluesky', 'alice.bsky.social')
    expect(listed.status).toBe(409)
    expect(await errorCode(listed)).toBe('unlink_claim_listed')
    expect(await env.CACHE_KV.get(handleKey)).not.toBeNull()
    expect(await env.CACHE_KV.get(didKey)).not.toBeNull()

    const gone = await listRevoke(env, pubkey, await signEvent(key, 10011, [], 2001), 'bluesky', 'alice.bsky.social')
    expect(gone.status).toBe(200)
    expect(await env.CACHE_KV.get(handleKey)).toBeNull()
    expect(await env.CACHE_KV.get(didKey)).toBeNull()
  })

  it('refuses a list from another key, with a bad signature, or of another kind', async () => {
    const env = createTestEnv()
    const { key, pubkey } = owner()
    await seedRecord(env, { pubkey })
    const good = await signEvent(key, 10011, [], 2001)
    const cases: Array<[string, unknown, number]> = [
      ['another key', await signEvent(schnorr.utils.randomSecretKey(), 10011, [], 2001), 401],
      ['bad signature', { ...good, sig: bytesToHex(schnorr.sign(hexToBytes('11'.repeat(32)), key)) }, 401],
      ['another kind', await signEvent(key, 1, [], 2001), 400],
    ]
    for (const [name, list, status] of cases) {
      const res = await listRevoke(env, pubkey, list)
      expect(res.status, name).toBe(status)
      expect(await errorCode(res), name).toBe('unlink_proof_invalid')
      expect(await env.CACHE_KV.get(aliceKey(pubkey)), name).not.toBeNull()
    }
  })

  it('refuses a list whose signature does not check out before comparing it with the link', async () => {
    const env = createTestEnv()
    const { key, pubkey } = owner()
    await seedRecord(env, { pubkey, confirm_event_id: '8'.repeat(64) })
    const forgedSig = (list: SignedNostrEvent) => ({ ...list, sig: bytesToHex(schnorr.sign(hexToBytes('11'.repeat(32)), key)) })
    const sameSecond = await signEvent(key, 10011, [], 2000)
    const cases: Array<[string, unknown]> = [
      // Newer than the link and without the claim, but not signed by its pubkey.
      ['newer', forgedSig(await signEvent(key, 10011, [], 2001))],
      // The same second as the link, with an id that would sort first.
      ['lower id', { ...sameSecond, id: '0'.repeat(64) }],
      // Older than the link: refused as a bad proof, not as an older list.
      ['older', forgedSig(await signEvent(key, 10011, [], 1999))],
    ]
    for (const [name, list] of cases) {
      const res = await listRevoke(env, pubkey, list)
      expect(res.status, name).toBe(401)
      expect(await errorCode(res), name).toBe('unlink_proof_invalid')
      expect(await env.CACHE_KV.get(aliceKey(pubkey)), name).not.toBeNull()
    }
  })

  it('accepts a list 600 seconds ahead and refuses one 601 ahead', async () => {
    const T = 1_790_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T * 1000)
    const env = createTestEnv()
    const { key, pubkey } = owner()
    await seedRecord(env, { pubkey, checked_at: T - 10, confirm_created_at: T - 10 })
    expect((await listRevoke(env, pubkey, await signEvent(key, 10011, [], T + 600))).status).toBe(200)

    await seedRecord(env, { pubkey, checked_at: T - 10, confirm_created_at: T - 10 })
    const ahead = await listRevoke(env, pubkey, await signEvent(key, 10011, [], T + 601))
    expect(ahead.status).toBe(400)
    expect(await errorCode(ahead)).toBe('unlink_proof_invalid')
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).not.toBeNull()
  })

  it('accepts a list 60 seconds old but refuses a 61-second-old list even when newer than the link', async () => {
    const env = createTestEnv()
    const { key, pubkey } = owner()
    vi.setSystemTime(2100 * 1000)
    await seedRecord(env, { pubkey })
    const old = await listRevoke(env, pubkey, await signEvent(key, 10011, [], 2039))
    expect(old.status).toBe(401)
    expect(await errorCode(old)).toBe('unlink_proof_invalid')
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).not.toBeNull()
    expect((await listRevoke(env, pubkey, await signEvent(key, 10011, [], 2040))).status).toBe(200)
  })

  it('allows a slow signer to unlink a transitional unconfirmed record within the freshness window', async () => {
    const env = createTestEnv()
    const { key, pubkey } = owner()
    await storeOAuthVerification(env.CACHE_KV, {
      platform: 'twitter', identity: 'alice', pubkey, verified: true, method: 'oauth', checked_at: 2005,
    })
    expect((await listRevoke(env, pubkey, await signEvent(key, 10011, [], 1945))).status).toBe(200)
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).toBeNull()
  })

  it('still deletes a cached-miss key, but never when the submitted list holds the claim', async () => {
    const env = createTestEnv()
    const { key, pubkey } = owner()
    await seedRecord(env, { pubkey })
    const get = env.CACHE_KV.get.bind(env.CACHE_KV)
    const read = vi.spyOn(env.CACHE_KV as { get(key: string): Promise<string | null> }, 'get').mockResolvedValue(null)
    const del = vi.spyOn(env.CACHE_KV, 'delete')
    const listed = await listRevoke(env, pubkey, await signEvent(key, 10011, [['i', 'twitter:alice', 'oauth']], 2005))
    expect(listed.status).toBe(409)
    expect(del).not.toHaveBeenCalled()
    expect((await listRevoke(env, pubkey, await signEvent(key, 10011, [], 2005))).status).toBe(200)
    expect(read).toHaveBeenCalledTimes(2)
    expect(del).toHaveBeenCalledWith(aliceKey(pubkey))
    expect(await get(aliceKey(pubkey))).toBeNull()
  })

  it('after unlinking and linking again, the earlier list is refused', async () => {
    const env = createTestEnv()
    const { key, pubkey } = owner()
    await seedRecord(env, { pubkey })
    const first = await signEvent(key, 10011, [], 2001)
    expect((await listRevoke(env, pubkey, first)).status).toBe(200)

    await seedRecord(env, { pubkey, confirm_created_at: first.created_at + 5 })
    const replay = await listRevoke(env, pubkey, first)
    expect(replay.status).toBe(409)
    expect(await errorCode(replay)).toBe('unlink_list_older')
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).not.toBeNull()
  })

  it('answers revoked when nothing is stored, once the list checks out', async () => {
    const env = createTestEnv()
    const { key, pubkey } = owner()
    const list = await signEvent(key, 10011, [], 2001)
    const res = await listRevoke(env, pubkey, list)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: true, platform: 'twitter', identity: 'alice' })

    const forged = { ...list, sig: bytesToHex(schnorr.sign(hexToBytes('11'.repeat(32)), key)) }
    const bad = await listRevoke(env, pubkey, forged)
    expect(bad.status).toBe(401)
    expect(await errorCode(bad)).toBe('unlink_proof_invalid')
  })

  it('gives the same answer when the same list is sent twice', async () => {
    const env = createTestEnv()
    const { key, pubkey } = owner()
    await seedRecord(env, { pubkey })
    const list = await signEvent(key, 10011, [], 2001)
    for (let i = 0; i < 2; i++) {
      const res = await listRevoke(env, pubkey, list)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ revoked: true, platform: 'twitter', identity: 'alice' })
    }
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).toBeNull()
  })

  it('logs which proof was used, without the pubkey or identity', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const env = createTestEnv()
    const { key, pubkey } = owner()
    forbidUpstreamFetch()

    await seedRecord(env, { pubkey })
    const body = { platform: 'twitter', identity: 'alice', pubkey }
    expect((await revokeRequest(env, body, { Authorization: nostrHeader(await headerEvent(key, await bodySha(body))) })).status).toBe(200)

    await seedRecord(env, { pubkey })
    expect((await revokeRequest(env, { ...body, event: await signNip98Event(key) })).status).toBe(200)

    await seedRecord(env, { pubkey })
    expect((await listRevoke(env, pubkey, await signEvent(key, 10011, [], 2001))).status).toBe(200)

    await seedRecord(env, { pubkey })
    expect((await listRevoke(env, pubkey, await signEvent(key, 10011, [], 1999))).status).toBe(409)

    const lines = info.mock.calls.map(call => call.map(String).join(' '))
    // One line per revoke, and nothing else logged on these paths.
    expect(lines).toEqual([
      'twitter unlink: header proof, revoked',
      'twitter unlink: body proof, revoked',
      'twitter unlink: list proof, revoked',
      'twitter unlink: list proof, unlink_list_older',
    ])
    for (const line of lines) {
      expect(line).not.toContain(pubkey)
      expect(line.toLowerCase()).not.toContain('alice')
    }
  })
})

describe('POST /auth/oauth/revoke finds the record /verify counts, however the identity was typed', () => {
  const key = () => schnorr.utils.randomSecretKey()

  for (const typed of ['@Alice', '  alice  ', '@alice']) {
    it(`deletes the record stored under alice when the body form sends ${JSON.stringify(typed)}`, async () => {
      const env = createTestEnv()
      const event = await signNip98Event(key())
      await seedRecord(env, { pubkey: event.pubkey })
      const res = await revokeRequest(env, { platform: 'twitter', identity: typed, pubkey: event.pubkey, event })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ revoked: true, platform: 'twitter', identity: typed })
      expect(await env.CACHE_KV.get(aliceKey(event.pubkey))).toBeNull()
    })
  }

  it('deletes the record stored under alice when the list form sends @alice, and /verify then answers signin_expired', async () => {
    const env = { ...createTestEnv(), SIGNIN_CONFIRMATION: 'required' } as Bindings
    const owner = key()
    const pubkey = bytesToHex(schnorr.getPublicKey(owner))
    const now = Math.floor(Date.now() / 1000)
    await seedRecord(env, { pubkey, checked_at: now, confirm_created_at: now - 10 })
    forbidUpstreamFetch()
    const list = await signEvent(owner, 10011, [['i', 'github:alice', 'gist1']], now - 9)
    const res = await revokeRequest(env, { platform: 'twitter', identity: '@alice', pubkey, list })
    expect(res.status).toBe(200)
    expect(await env.CACHE_KV.get(aliceKey(pubkey))).toBeNull()
    const verify = await worker.fetch(new Request('http://localhost/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claims: [{ platform: 'twitter', identity: '@alice', proof: 'oauth', pubkey }] }),
    }), env)
    const result = ((await verify.json()) as { results: Array<{ verified: boolean; code?: string }> }).results[0]
    expect(result).toMatchObject({ verified: false, code: 'signin_expired' })
  })
})
