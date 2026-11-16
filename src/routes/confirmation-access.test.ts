// ABOUTME: Tests GET /auth/confirmation-access: an account asks, with a NIP-98 header, whether it has Divine Confirmation.
// ABOUTME: Covers the signer-only answer, refusals before any access lookup, the IP limit first, headers, and logs without pubkeys.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Bindings } from '../types'
import type { SignedNostrEvent } from '../utils/nostr-event'
import worker from '../index'

const ORIGIN = 'https://verifier.divine.video'
const ACCESS_URL = `${ORIGIN}/auth/confirmation-access`
const ACCESS_SERVICE = 'https://access.example.test/v1/entitlements'
const CLIENT_IP = '203.0.113.7'

function createMockKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
  } as unknown as KVNamespace
}

// Every counter reads as spent, so any rate limit refuses.
function spentKV(): KVNamespace {
  return { ...createMockKV(), get: async () => '9999' } as unknown as KVNamespace
}

function env(extra: Partial<Bindings> = {}): Bindings {
  return {
    CACHE_KV: createMockKV(),
    RATE_LIMIT_KV: createMockKV(),
    CONFIRMATION_ACCESS_URL: ACCESS_SERVICE,
    CONFIRMATION_ACCESS_TOKEN: 'access-token',
    ...extra,
  }
}

const pubkeyOf = (secretKey: Uint8Array) => bytesToHex(schnorr.getPublicKey(secretKey))

// A really signed NIP-98 event (NIP-01 id + BIP-340 signature).
async function signNip98(
  secretKey: Uint8Array,
  over: Partial<{ url: string; method: string; created_at: number; kind: number }> = {},
): Promise<SignedNostrEvent> {
  const pubkey = pubkeyOf(secretKey)
  const created_at = over.created_at ?? Math.floor(Date.now() / 1000)
  const kind = over.kind ?? 27235
  const tags = [['u', over.url ?? ACCESS_URL], ['method', over.method ?? 'GET']]
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, ''])
  const id = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))))
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey))
  return { id, pubkey, sig, kind, tags, created_at, content: '' }
}

const nostrHeader = (event: unknown) => 'Nostr ' + btoa(JSON.stringify(event))

function ask(e: Bindings, authorization?: string, url = ACCESS_URL): Promise<Response> {
  const headers: Record<string, string> = { 'cf-connecting-ip': CLIENT_IP }
  if (authorization !== undefined) headers.Authorization = authorization
  return Promise.resolve(worker.fetch(new Request(url, { headers }), e))
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => json({ isActive: true }))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /auth/confirmation-access', () => {
  it("answers yes for a tester's own valid signature", async () => {
    const key = schnorr.utils.randomSecretKey()
    const e = env({ CONFIRMATION_TESTERS: pubkeyOf(key), CONFIRMATION_ACCESS_URL: undefined, CONFIRMATION_ACCESS_TOKEN: undefined })
    const res = await ask(e, nostrHeader(await signNip98(key)))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ access: 'yes' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers no and yes from the access service for the signer\'s pubkey', async () => {
    for (const [isActive, access] of [[false, 'no'], [true, 'yes']] as const) {
      fetchMock.mockReset()
      fetchMock.mockImplementation(async () => json({ isActive }))
      const key = schnorr.utils.randomSecretKey()
      const res = await ask(env(), nostrHeader(await signNip98(key)))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ access })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0][0]).endsWith(`/${pubkeyOf(key)}`)).toBe(true)
    }
  })

  it('answers about the signer only, whatever the query names', async () => {
    const tester = pubkeyOf(schnorr.utils.randomSecretKey())
    const key = schnorr.utils.randomSecretKey()
    fetchMock.mockImplementation(async () => json({ isActive: false }))
    const url = `${ACCESS_URL}?pubkey=${tester}`
    const res = await ask(env({ CONFIRMATION_TESTERS: tester }), nostrHeader(await signNip98(key, { url })), url)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ access: 'no' })
    expect(String(fetchMock.mock.calls[0][0]).endsWith(`/${pubkeyOf(key)}`)).toBe(true)
  })

  it('answers unavailable when the access service is down', async () => {
    for (const down of [async () => { throw new TypeError('network down') }, async () => new Response('', { status: 503 })]) {
      fetchMock.mockReset()
      fetchMock.mockImplementation(down)
      const res = await ask(env(), nostrHeader(await signNip98(schnorr.utils.randomSecretKey())))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ access: 'unavailable' })
    }
  })

  it('answers unavailable when the access service is not configured, for a non-tester', async () => {
    const e = env({ CONFIRMATION_ACCESS_URL: undefined, CONFIRMATION_ACCESS_TOKEN: undefined })
    const res = await ask(e, nostrHeader(await signNip98(schnorr.utils.randomSecretKey())))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ access: 'unavailable' })
  })

  it('refuses a signature for another URL, another method or a stale time with 401, without asking the access service', async () => {
    const key = schnorr.utils.randomSecretKey()
    const now = Math.floor(Date.now() / 1000)
    const cases: [string, Partial<{ url: string; method: string; created_at: number }>, RegExp][] = [
      ['another URL', { url: `${ORIGIN}/auth/oauth/revoke` }, /URL does not match/],
      ['another host', { url: 'https://elsewhere.example/auth/confirmation-access' }, /URL does not match/],
      ['another method', { method: 'POST' }, /method does not match/],
      ['too old', { created_at: now - 61 }, /too old/],
      ['too far ahead', { created_at: now + 61 }, /too old/],
    ]
    for (const [name, over, message] of cases) {
      // Not a tester: any access lookup would reach the access service.
      const res = await ask(env(), nostrHeader(await signNip98(key, over)))
      expect(res.status, name).toBe(401)
      const body = await res.json() as Record<string, unknown>
      expect(body.error, name).toMatch(message)
      expect(body, name).not.toHaveProperty('access')
      expect(body, name).not.toHaveProperty('code')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a missing or malformed Authorization header with 400', async () => {
    const key = schnorr.utils.randomSecretKey()
    const headers: [string, string | undefined][] = [
      ['missing', undefined],
      ['another scheme', 'Bearer abc'],
      ['no token', 'Nostr'],
      ['not base64', 'Nostr !!!'],
      ['not JSON', 'Nostr ' + btoa('not json')],
      ['not an object', nostrHeader('event')],
      ['no signature', nostrHeader({ kind: 27235 })],
      ['wrong kind', nostrHeader(await signNip98(key, { kind: 1 }))],
    ]
    for (const [name, header] of headers) {
      const res = await ask(env(), header)
      expect(res.status, name).toBe(400)
      const body = await res.json() as Record<string, unknown>
      expect(typeof body.error, name).toBe('string')
      expect(body, name).not.toHaveProperty('access')
      expect(body, name).not.toHaveProperty('code')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a tampered event (pubkey swapped after signing) with 401', async () => {
    const victim = pubkeyOf(schnorr.utils.randomSecretKey())
    const attacker = schnorr.utils.randomSecretKey()
    // Not a tester: any access lookup would reach the access service.
    const e = env()
    const signed = await signNip98(attacker)

    // The id no longer matches the contents.
    const swapped = { ...signed, pubkey: victim }
    // The id recomputed for the victim, but the signature is the attacker's.
    const serialized = JSON.stringify([0, victim, signed.created_at, 27235, signed.tags, ''])
    const victimId = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))))
    const resigned = { ...signed, pubkey: victim, id: victimId, sig: bytesToHex(schnorr.sign(hexToBytes(victimId), attacker)) }

    for (const [name, event] of [['id mismatch', swapped], ['bad signature', resigned]] as const) {
      const res = await ask(e, nostrHeader(event))
      expect(res.status, name).toBe(401)
      expect(await res.json(), name).not.toHaveProperty('access')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses HEAD with 405, even with a valid GET-signed event, without asking the access service', async () => {
    const key = schnorr.utils.randomSecretKey()
    const res = await worker.fetch(new Request(ACCESS_URL, {
      method: 'HEAD',
      headers: { 'cf-connecting-ip': CLIENT_IP, Authorization: nostrHeader(await signNip98(key)) },
    }), env())
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('GET')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Vary') ?? '').toMatch(/(^|,\s*)Authorization(\s*,|$)/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 429 when the IP limit is hit, before verifying', async () => {
    const key = schnorr.utils.randomSecretKey()
    const e = env({ RATE_LIMIT_KV: spentKV() })
    // A valid signature: no access lookup is made.
    const valid = await ask(e, nostrHeader(await signNip98(key)))
    expect(valid.status).toBe(429)
    expect(await valid.json()).not.toHaveProperty('access')
    // A header verification would refuse with 400 still gets 429: the limit comes first.
    const malformed = await ask(e, 'Nostr !!!')
    expect(malformed.status).toBe(429)
    const missing = await ask(e)
    expect(missing.status).toBe(429)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('counts each request against the IP limit', async () => {
    const kv = createMockKV()
    const key = schnorr.utils.randomSecretKey()
    const e = env({ RATE_LIMIT_KV: kv, CONFIRMATION_TESTERS: pubkeyOf(key) })
    const header = nostrHeader(await signNip98(key))
    for (let i = 0; i < 60; i++) expect((await ask(e, header)).status).toBe(200)
    expect((await ask(e, header)).status).toBe(429)
  })

  it('sets Cache-Control: no-store and Vary: Authorization', async () => {
    const key = schnorr.utils.randomSecretKey()
    const answers: [string, () => Promise<Response>][] = [
      ['200', async () => ask(env(), nostrHeader(await signNip98(key)))],
      ['400', async () => ask(env())],
      ['401', async () => ask(env(), nostrHeader(await signNip98(key, { method: 'POST' })))],
      ['429', async () => ask(env({ RATE_LIMIT_KV: spentKV() }), nostrHeader(await signNip98(key)))],
    ]
    for (const [status, answer] of answers) {
      const res = await answer()
      expect(String(res.status), status).toBe(status)
      expect(res.headers.get('Cache-Control'), status).toBe('no-store')
      expect(res.headers.get('Vary') ?? '', status).toMatch(/(^|,\s*)Authorization(\s*,|$)/i)
    }
  })

  it('logs the outcome without the pubkey', async () => {
    const tester = schnorr.utils.randomSecretKey()
    const member = schnorr.utils.randomSecretKey()
    const lines: string[] = []
    const capture = (...args: unknown[]) => { lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) }
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation(capture)
    }

    const testerHeader = nostrHeader(await signNip98(tester))
    await ask(env({ CONFIRMATION_TESTERS: pubkeyOf(tester) }), testerHeader)
    fetchMock.mockImplementation(async () => json({ isActive: false }))
    await ask(env(), nostrHeader(await signNip98(member)))
    fetchMock.mockImplementation(async () => new Response('', { status: 503 }))
    await ask(env(), nostrHeader(await signNip98(member)))
    await ask(env(), nostrHeader(await signNip98(member, { method: 'POST' })))
    await ask(env({ RATE_LIMIT_KV: spentKV() }), testerHeader)

    const outcomes = lines.filter(line => line.startsWith('Confirmation access: '))
    expect(outcomes.map(line => line.split(/[ ,]/)[2])).toEqual(['yes', 'no', 'unavailable', 'refused', 'refused'])
    for (const line of lines) {
      expect(line).not.toMatch(/[0-9a-f]{64}/i)
      expect(line).not.toContain(CLIENT_IP)
      expect(line).not.toContain(testerHeader.slice(6, 40))
    }
  })
})
