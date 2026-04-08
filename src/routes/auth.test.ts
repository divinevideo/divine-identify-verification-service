import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Bindings } from '../types'
import auth from './auth'

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

afterEach(() => {
  vi.restoreAllMocks()
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

  it('rejects pubkey mismatch between body and event', async () => {
    const env = createTestEnv()
    const otherPubkey = 'cc'.repeat(32)
    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'twitter',
        identity: 'user',
        pubkey: testPubkey,
        event: buildNip98Event(otherPubkey),
      }),
    }, env)
    expect(res.status).toBe(401)
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

  it('returns revoked:true and deletes KV entry', async () => {
    const env = createTestEnv()
    const key = `oauth_verified:twitter:alice:${testPubkey}`
    await env.CACHE_KV.put(key, JSON.stringify({ verified: true }))

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pubkey: testPubkey }),
    }))

    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'twitter',
        identity: 'alice',
        pubkey: testPubkey,
        event: buildNip98Event(testPubkey),
      }),
    }, env)
    expect(res.status).toBe(200)
    const data = await res.json() as { revoked: boolean; platform: string; identity: string }
    expect(data.revoked).toBe(true)
    expect(data.platform).toBe('twitter')
    expect(data.identity).toBe('alice')

    const after = await env.CACHE_KV.get(key)
    expect(after).toBeNull()
  })

  it('returns revoked:true even when KV entry already absent (idempotent)', async () => {
    const env = createTestEnv()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pubkey: testPubkey }),
    }))

    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'bluesky',
        identity: 'alice.bsky.social',
        pubkey: testPubkey,
        event: buildNip98Event(testPubkey),
      }),
    }, env)
    expect(res.status).toBe(200)
    const data = await res.json() as { revoked: boolean }
    expect(data.revoked).toBe(true)
  })
})
