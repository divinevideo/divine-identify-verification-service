import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import worker from '../index'
import { fakeRelays, type FakeRelay } from '../contract/harness'
import { oauthVerificationKey } from '../oauth/state'
import { DIVINE_RELAY } from '../verified/linked-accounts'
import { cacheKey, putCached } from '../utils/cache'
import { MAX_LIST_CLAIMS } from './verified'
import type { Bindings } from '../types'
import type { SignedNostrEvent } from '../utils/nostr-event'

const SECRET = hexToBytes('11'.repeat(32))
const PK = bytesToHex(schnorr.getPublicKey(SECRET))
const DAMUS = 'wss://relay.damus.io'
const PRIMAL = 'wss://relay.primal.net'
const NOW = () => Math.floor(Date.now() / 1000)

async function signedList(tags: string[][]): Promise<SignedNostrEvent> {
  const createdAt = 1_700_000_000
  const serialized = JSON.stringify([0, PK, createdAt, 10011, tags, ''])
  const id = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))))
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), SECRET))
  return { id, pubkey: PK, sig, kind: 10011, tags, created_at: createdAt, content: '' }
}

const relay = (url: string, events: unknown[] = [], over: Partial<FakeRelay> = {}): FakeRelay => ({ url, events, seenFilters: [], ...over })

function relaysWith(list: SignedNostrEvent | null, divine: Partial<FakeRelay> = {}): void {
  fakeRelays([relay(DIVINE_RELAY, list ? [list] : [], divine), relay(DAMUS), relay(PRIMAL)])
}

function memoryKv(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
  } as unknown as KVNamespace
  return { kv, store }
}

function envWith(vars: Partial<Bindings> = {}) {
  const { kv, store } = memoryKv()
  return { env: { CACHE_KV: kv, RATE_LIMIT_KV: kv, ...vars } as Bindings, kv, store }
}

function seedSignIn(store: Map<string, string>, platform: string, identity: string, over: Record<string, unknown> = {}): number {
  const checkedAt = NOW() - 60
  store.set(oauthVerificationKey(platform as 'twitter', identity, PK), JSON.stringify({
    platform, identity, pubkey: PK, verified: true, method: 'oauth', checked_at: checkedAt, ...over,
  }))
  return checkedAt
}

async function seedProof(kv: KVNamespace, platform: string, identity: string, proof: string, over: Record<string, unknown> = {}): Promise<number> {
  const entry = { verified: true, method: 'proof_post', checked_at: NOW() - 120, type: 'verified', ...over }
  await putCached(kv, cacheKey(platform, identity, proof, PK), entry as never)
  return entry.checked_at as number
}

const get = (env: Bindings, path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://verifier.divine.video${path}`, { headers }), env)

type Answer = {
  pubkey: string
  verifications: Array<{ platform: string; identity: string; method: string; proof_url: string | null; verified_at: number }>
  unchecked: Array<{ platform: string; identity: string }>
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('GET /verified/:pubkey', () => {
  it('answers the old shape for a confirmed sign-in', async () => {
    const { env, store } = envWith({ SIGNIN_CONFIRMATION: 'required' })
    const checkedAt = seedSignIn(store, 'twitter', 'jack', { confirmed: true })
    relaysWith(await signedList([['i', 'twitter:jack', 'oauth']]))
    const res = await get(env, `/verified/${PK}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      pubkey: PK,
      verifications: [{ platform: 'x', identity: 'jack', method: 'oauth', proof_url: null, verified_at: checkedAt }],
      unchecked: [],
    })
  })

  it('leaves out a confirmed sign-in while its platform\'s links are switched off', async () => {
    const { env, store } = envWith({ SIGNIN_CONFIRMATION: 'required', SIGNIN_LINKS_OFF: 'twitter' })
    seedSignIn(store, 'twitter', 'jack', { confirmed: true })
    relaysWith(await signedList([['i', 'twitter:jack', 'oauth']]))
    const res = await get(env, `/verified/${PK}`)
    expect(res.status).toBe(200)
    const body = await res.json() as Answer
    expect(body.verifications).toEqual([])
    expect(body.unchecked).toEqual([])
  })

  it('answers a cached proof post with its link', async () => {
    const { env, kv } = envWith()
    const checkedAt = await seedProof(kv, 'github', 'alice', 'abc123')
    relaysWith(await signedList([['i', 'github:alice', 'abc123']]))
    const body = await (await get(env, `/verified/${PK}`)).json() as Answer
    expect(body.verifications).toEqual([{
      platform: 'github', identity: 'alice', method: 'proof-post',
      proof_url: 'https://gist.github.com/alice/abc123', verified_at: checkedAt,
    }])
  })

  it('leaves out an unconfirmed or lapsed sign-in', async () => {
    const { env, store } = envWith({ SIGNIN_CONFIRMATION: 'required' })
    seedSignIn(store, 'twitter', 'unconfirmed', {})
    seedSignIn(store, 'twitter', 'lapsed', { confirmed: true, checked_at: NOW() - 31 * 24 * 60 * 60 })
    relaysWith(await signedList([['i', 'twitter:unconfirmed', 'oauth'], ['i', 'twitter:lapsed', 'oauth']]))
    const body = await (await get(env, `/verified/${PK}`)).json() as Answer
    expect(body.verifications).toEqual([])
    expect(body.unchecked).toEqual([])
  })

  it('leaves out a sign-in the person removed from their list', async () => {
    const { env, store } = envWith()
    seedSignIn(store, 'twitter', 'jack', { confirmed: true })
    relaysWith(await signedList([]))
    const body = await (await get(env, `/verified/${PK}`)).json() as Answer
    expect(body.verifications).toEqual([])
  })

  it('lists a platform that could not be checked', async () => {
    const { env } = envWith()
    const list = await signedList([['i', 'twitter:alice', '1234567890']])
    fakeRelays([relay(DIVINE_RELAY, [list]), relay(DAMUS), relay(PRIMAL)], async () => { throw new Error('no network in tests') })
    const body = await (await get(env, `/verified/${PK}`)).json() as Answer
    expect(body.verifications).toEqual([])
    expect(body.unchecked).toEqual([{ platform: 'x', identity: 'alice' }])
  })

  it('lists claims past the cap as unchecked', async () => {
    const { env, kv } = envWith()
    const names = Array.from({ length: 25 }, (_, i) => `user${String(i).padStart(2, '0')}`)
    for (const name of names) await seedProof(kv, 'github', name, '1')
    relaysWith(await signedList(names.map(name => ['i', `github:${name}`, '1'])))
    const body = await (await get(env, `/verified/${PK}`)).json() as Answer
    expect(MAX_LIST_CLAIMS).toBe(20)
    expect(body.verifications.map(v => v.identity)).toEqual(names.slice(0, 20))
    expect(body.unchecked.map(u => u.identity)).toEqual(names.slice(20))
  })

  it('answers one entry per account, the first verified in tag order', async () => {
    const { env, kv } = envWith()
    const first = await seedProof(kv, 'github', 'Alice', '1', { checked_at: NOW() - 500 })
    await seedProof(kv, 'github', 'alice', '2', { checked_at: NOW() - 900 })
    relaysWith(await signedList([['i', 'github:Alice', '1'], ['i', 'github:alice', '2']]))
    const body = await (await get(env, `/verified/${PK}`)).json() as Answer
    expect(body.verifications).toHaveLength(1)
    expect(body.verifications[0].identity).toBe('Alice')
    expect(body.verifications[0].verified_at).toBe(first)
  })

  it('skips a failed first spelling and keeps the verified one', async () => {
    const { env, kv } = envWith()
    await seedProof(kv, 'github', 'Alice', '1', { verified: false, method: undefined, type: 'failed', code: 'proof_not_found' })
    await seedProof(kv, 'github', 'alice', '2')
    relaysWith(await signedList([['i', 'github:Alice', '1'], ['i', 'github:alice', '2']]))
    const body = await (await get(env, `/verified/${PK}`)).json() as Answer
    expect(body.verifications.map(v => v.identity)).toEqual(['alice'])
  })

  it('sorts by platform, then identity', async () => {
    const { env, kv } = envWith()
    await seedProof(kv, 'github', 'zed', '1')
    await seedProof(kv, 'github', 'amy', '1')
    await seedProof(kv, 'telegram', 'bob', '1')
    relaysWith(await signedList([['i', 'telegram:bob', '1'], ['i', 'github:zed', '1'], ['i', 'github:amy', '1']]))
    const body = await (await get(env, `/verified/${PK}`)).json() as Answer
    expect(body.verifications.map(v => `${v.platform}:${v.identity}`)).toEqual(['github:amy', 'github:zed', 'telegram:bob'])
  })

  it('lowercases the pubkey', async () => {
    const { env } = envWith()
    relaysWith(null)
    const res = await get(env, `/verified/${PK.toUpperCase()}`)
    expect(res.status).toBe(200)
    expect((await res.json() as Answer).pubkey).toBe(PK)
  })

  it('rejects a bad pubkey', async () => {
    const { env } = envWith()
    const res = await get(env, '/verified/xyz')
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({ error: { code: 'invalid_pubkey', message: 'pubkey must be 64 lowercase hex chars' } })
  })

  it("asks to try later when Divine's relay is down", async () => {
    const { env } = envWith()
    relaysWith(null, { behaviour: 'refuse' })
    const res = await get(env, `/verified/${PK}`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: { code: 'temporarily_unavailable', message: 'linked accounts could not be read right now, try again shortly' },
    })
  })

  it('answers 429 in the old shape', async () => {
    const { env } = envWith()
    relaysWith(null)
    for (let i = 0; i < 60; i++) expect((await get(env, `/verified/${PK}`, { 'cf-connecting-ip': '203.0.113.9' })).status).toBe(200)
    const res = await get(env, `/verified/${PK}`, { 'cf-connecting-ip': '203.0.113.9' })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: { code: 'rate_limited', message: 'rate limit exceeded' } })
  })

  it('checks the rate limit before the pubkey', async () => {
    const { env } = envWith()
    for (let i = 0; i < 60; i++) await get(env, '/verified/xyz', { 'cf-connecting-ip': '203.0.113.9' })
    expect((await get(env, '/verified/xyz', { 'cf-connecting-ip': '203.0.113.9' })).status).toBe(429)
  })

  it('gives an unknown pubkey an empty list', async () => {
    const { env } = envWith()
    relaysWith(null)
    const res = await get(env, `/verified/${PK}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pubkey: PK, verifications: [], unchecked: [] })
  })

  it('allows any origin', async () => {
    const { env } = envWith()
    relaysWith(null)
    const res = await get(env, `/verified/${PK}`, { Origin: 'https://example.com' })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('sorts what could not be checked together with what was past the cap', async () => {
    const { env, kv } = envWith()
    const names = Array.from({ length: 19 }, (_, i) => `user${String(i).padStart(2, '0')}`)
    for (const name of names) await seedProof(kv, 'github', name, '1')
    await seedProof(kv, 'github', 'zzz', '1', { verified: false, method: undefined, type: 'platform_error', code: 'temporarily_unavailable' })
    // zzz is the twentieth tag, so it is checked and fails; aaa is past the cap and sorts first.
    relaysWith(await signedList([...names, 'zzz', 'aaa'].map(name => ['i', `github:${name}`, '1'])))
    const body = await (await get(env, `/verified/${PK}`)).json() as Answer
    expect(body.unchecked).toEqual([{ platform: 'github', identity: 'aaa' }, { platform: 'github', identity: 'zzz' }])
  })

  it('lists an account once in unchecked, and not when another spelling verified', async () => {
    const { env, kv } = envWith()
    const down = { verified: false, method: undefined, type: 'platform_error', code: 'temporarily_unavailable' }
    await seedProof(kv, 'github', 'Amy', '1', down)
    await seedProof(kv, 'github', 'amy', '2', down)
    await seedProof(kv, 'github', 'bob', '1')
    await seedProof(kv, 'github', 'Bob', '2', down)
    relaysWith(await signedList([['i', 'github:Amy', '1'], ['i', 'github:amy', '2'], ['i', 'github:bob', '1'], ['i', 'github:Bob', '2']]))
    const body = await (await get(env, `/verified/${PK}`)).json() as Answer
    expect(body.verifications.map(v => v.identity)).toEqual(['bob'])
    expect(body.unchecked).toEqual([{ platform: 'github', identity: 'Amy' }])
  })

  it('gives no post link for an identity-link verification', async () => {
    const { env, kv } = envWith()
    await seedProof(kv, 'bluesky', 'alice.bsky.social', 'oauth', { method: 'identity_link' })
    relaysWith(await signedList([['i', 'bluesky:alice.bsky.social', 'oauth']]))
    const body = await (await get(env, `/verified/${PK}`)).json() as Answer
    expect(body.verifications).toMatchObject([{ platform: 'bluesky', method: 'identity_link', proof_url: null }])
  })

  it('answers 503 in the old shape when storage fails during the check', async () => {
    const { env } = envWith()
    const failing = { ...(env.CACHE_KV as object), get: async () => { throw new Error('kv down') } } as unknown as KVNamespace
    relaysWith(await signedList([['i', 'github:alice', '1']]))
    const res = await get({ ...env, CACHE_KV: failing }, `/verified/${PK}`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: { code: 'temporarily_unavailable', message: 'linked accounts could not be read right now, try again shortly' },
    })
  })

  it('answers 503 in the old shape when the request cannot be counted', async () => {
    const { env } = envWith()
    const failing = { ...(env.RATE_LIMIT_KV as object), get: async () => { throw new Error('kv down') } } as unknown as KVNamespace
    const res = await get({ ...env, RATE_LIMIT_KV: failing }, `/verified/${PK}`)
    expect(res.status).toBe(503)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('temporarily_unavailable')
  })

  it('sends the charset the old host sent, and allows any origin, on a 200 with a link', async () => {
    const { env, kv } = envWith()
    await seedProof(kv, 'github', 'alice', 'abc123')
    relaysWith(await signedList([['i', 'github:alice', 'abc123']]))
    const res = await get(env, `/verified/${PK}`, { Origin: 'https://example.com' })
    expect(res.status).toBe(200)
    expect((await res.json() as Answer).verifications).toHaveLength(1)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

})
