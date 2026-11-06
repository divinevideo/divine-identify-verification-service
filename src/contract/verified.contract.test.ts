// ABOUTME: Pins the /verified answers the old verify.divine.video host gave, so callers that follow
// ABOUTME: its redirect keep working: field names, types, statuses, codes and the error body shape.
import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { adapter } from './adapter'
import { call, fakeRelays, type FakeRelay } from './harness'

const target = adapter.target
const DIVINE_RELAY = 'wss://relay.divine.video'
const SECRET = hexToBytes('11'.repeat(32))
const PUBKEY = bytesToHex(schnorr.getPublicKey(SECRET))
const CLIENT_IP = '192.0.2.7'

// A really signed kind 10011 list, as the app publishes one.
async function signedList(tags: string[][]) {
  const createdAt = 1_700_000_000
  const id = bytesToHex(new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(JSON.stringify([0, PUBKEY, createdAt, 10011, tags, ''])),
  )))
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), SECRET))
  return { id, pubkey: PUBKEY, created_at: createdAt, kind: 10011, tags, content: '', sig }
}

const relay = (url: string, events: unknown[] = [], over: Partial<FakeRelay> = {}): FakeRelay =>
  ({ url, events, seenFilters: [], ...over })

function relaysWith(events: unknown[], divine: Partial<FakeRelay> = {}): void {
  fakeRelays([relay(DIVINE_RELAY, events, divine), relay('wss://relay.damus.io'), relay('wss://relay.primal.net')])
}

const errorBody = (code: string, message?: string) =>
  ({ error: { code, message: message ?? expect.any(String) } })

describe('GET /verified/<pubkey>', () => {
  it('answers the old shape, with twitter named x', async () => {
    const { env } = adapter.env({ SIGNIN_CONFIRMATION: 'required' })
    await adapter.seedSignIn(env, { platform: 'twitter', identity: 'jack', pubkey: PUBKEY })
    await adapter.seedCachedVerified(env, { platform: 'github', identity: 'alice', pubkey: PUBKEY, proof: 'abc123' })
    relaysWith([await signedList([['i', 'twitter:jack', 'oauth'], ['i', 'github:alice', 'abc123']])])
    const res = await call(target, 'GET', `/verified/${PUBKEY}`, undefined, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json() as {
      pubkey: string
      verifications: Array<Record<string, unknown>>
      unchecked: unknown[]
    }
    expect(Object.keys(body).sort()).toEqual(['pubkey', 'unchecked', 'verifications'])
    expect(body.pubkey).toBe(PUBKEY)
    expect(Array.isArray(body.unchecked)).toBe(true)
    expect(body.verifications.map(v => v.platform).sort()).toEqual(['github', 'x'])
    for (const v of body.verifications) {
      expect(Object.keys(v).sort()).toEqual(['identity', 'method', 'platform', 'proof_url', 'verified_at'])
      expect(typeof v.platform).toBe('string')
      expect(typeof v.identity).toBe('string')
      expect(typeof v.method).toBe('string')
      expect(v.proof_url === null || typeof v.proof_url === 'string').toBe(true)
      // Seconds, not milliseconds.
      expect(Number.isInteger(v.verified_at)).toBe(true)
      expect(v.verified_at as number).toBeLessThan(10_000_000_000)
    }
    expect(body.verifications.find(v => v.platform === 'x')).toMatchObject({ identity: 'jack', method: 'oauth', proof_url: null })
  })

  it('answers unchecked as an array of platform and identity when a check could not be made', async () => {
    const { env } = adapter.env()
    // The env's fetch throws for the proof check, which stands for an outage.
    relaysWith([await signedList([['i', 'github:alice', 'abc123']])])
    const res = await call(target, 'GET', `/verified/${PUBKEY}`, undefined, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      pubkey: PUBKEY, verifications: [], unchecked: [{ platform: 'github', identity: 'alice' }],
    })
  })

  it('400 invalid_pubkey for a malformed pubkey', async () => {
    const { env } = adapter.env()
    const res = await call(target, 'GET', '/verified/not-a-pubkey', undefined, env)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(errorBody('invalid_pubkey', 'pubkey must be 64 lowercase hex chars'))
  })

  it('429 rate_limited when the client IP has spent its limit', async () => {
    const { env } = adapter.env()
    await adapter.exhaustRateLimit(env, 'ip', CLIENT_IP)
    const res = await call(target, 'GET', `/verified/${PUBKEY}`, undefined, env, { 'cf-connecting-ip': CLIENT_IP })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual(errorBody('rate_limited', 'rate limit exceeded'))
  })

  it('503 temporarily_unavailable when Divine relay refuses', async () => {
    const { env } = adapter.env()
    relaysWith([], { behaviour: 'refuse' })
    const res = await call(target, 'GET', `/verified/${PUBKEY}`, undefined, env)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(errorBody('temporarily_unavailable'))
  })
})

describe('GET /verified?platform=&identity=', () => {
  it('answers the old shape, with twitter named x', async () => {
    const { env } = adapter.env({ SIGNIN_CONFIRMATION: 'required' })
    await adapter.seedSignIn(env, { platform: 'twitter', identity: 'jack', pubkey: PUBKEY })
    relaysWith([await signedList([['i', 'twitter:jack', 'oauth']])])
    const res = await call(target, 'GET', '/verified?platform=twitter&identity=jack', undefined, env)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['identity', 'method', 'platform', 'pubkey', 'verified_at'])
    expect(body).toMatchObject({ platform: 'x', identity: 'jack', pubkey: PUBKEY, method: 'oauth' })
    expect(Number.isInteger(body.verified_at)).toBe(true)
    expect(body.verified_at as number).toBeLessThan(10_000_000_000)
  })

  it('answers a proof post owner with its method', async () => {
    const { env } = adapter.env()
    await adapter.seedCachedVerified(env, { platform: 'github', identity: 'alice', pubkey: PUBKEY, proof: 'abc123' })
    relaysWith([await signedList([['i', 'github:alice', 'abc123']])])
    const res = await call(target, 'GET', '/verified?platform=github&identity=alice', undefined, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ platform: 'github', identity: 'alice', pubkey: PUBKEY, method: 'proof-post' })
  })

  it('400 invalid_request without a platform and identity', async () => {
    const { env } = adapter.env()
    const res = await call(target, 'GET', '/verified?platform=github', undefined, env)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(errorBody('invalid_request', 'platform and identity are required'))
  })

  it('404 not_found when no one verifies the account', async () => {
    const { env } = adapter.env()
    relaysWith([])
    const res = await call(target, 'GET', '/verified?platform=github&identity=nobody', undefined, env)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(errorBody('not_found', 'no live verification for this platform identity'))
  })

  it('429 rate_limited when the client IP has spent its limit', async () => {
    const { env } = adapter.env()
    await adapter.exhaustRateLimit(env, 'ip', CLIENT_IP)
    const res = await call(target, 'GET', '/verified?platform=github&identity=alice', undefined, env, { 'cf-connecting-ip': CLIENT_IP })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual(errorBody('rate_limited', 'rate limit exceeded'))
  })

  it('503 temporarily_unavailable when Divine relay refuses', async () => {
    const { env } = adapter.env()
    relaysWith([], { behaviour: 'refuse' })
    const res = await call(target, 'GET', '/verified?platform=github&identity=alice', undefined, env)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(errorBody('temporarily_unavailable'))
  })
})
