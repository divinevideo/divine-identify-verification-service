// ABOUTME: Every platform check a /verified answer makes counts against the per-pubkey
// ABOUTME: and per-platform limits once, as /verify counts them, through one reservation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import worker from '../index'
import { fakeRelays, type FakeRelay } from '../contract/harness'
import { DIVINE_RELAY } from '../verified/linked-accounts'
import { cacheKey, putCached } from '../utils/cache'
import type { Bindings } from '../types'
import type { SignedNostrEvent } from '../utils/nostr-event'

const DAMUS = 'wss://relay.damus.io'
const PRIMAL = 'wss://relay.primal.net'
// 30 s into a minute, so a test never straddles two counting windows.
const NOW_MS = 1_800_000_030_000

const secretFor = (n: number) => hexToBytes(n.toString(16).padStart(2, '0').repeat(32))
const pubkeyOf = (secret: Uint8Array) => bytesToHex(schnorr.getPublicKey(secret))
const SECRET = secretFor(0x11)
const PK = pubkeyOf(SECRET)
const OTHER_SECRET = secretFor(0x22)
const OTHER_PK = pubkeyOf(OTHER_SECRET)

async function signedList(tags: string[][], secret = SECRET, createdAt = 1_700_000_000, kind = 10011): Promise<SignedNostrEvent> {
  const pubkey = pubkeyOf(secret)
  const serialized = JSON.stringify([0, pubkey, createdAt, kind, tags, ''])
  const id = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))))
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secret))
  return { id, pubkey, sig, kind, tags, created_at: createdAt, content: '' }
}

const relay = (url: string, events: unknown[] = []): FakeRelay => ({ url, events, seenFilters: [] })

let fetchedUrls: string[]
// Distinct and never a substring of one another, so a fetch URL names one tag.
const checked = (proof: string) => fetchedUrls.some(url => url.includes(proof))

function relaysWith(events: unknown[]): void {
  // Every platform check is answered 404 and recorded, so the test sees which ran.
  fakeRelays([relay(DIVINE_RELAY, events), relay(DAMUS), relay(PRIMAL)], (async (input: RequestInfo | URL) => {
    fetchedUrls.push(input instanceof Request ? input.url : String(input))
    return new Response('not found', { status: 404 })
  }) as typeof fetch)
}

function memoryKv(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async ({ prefix = '' }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace
  return { kv, store }
}

function envWith() {
  const cache = memoryKv()
  const limits = memoryKv()
  const env = { CACHE_KV: cache.kv, RATE_LIMIT_KV: limits.kv } as Bindings
  return { env, cacheKv: cache.kv, limitStore: limits.store }
}

const counterKey = (prefix: string, id: string) => `${prefix}:${id}:${Math.floor(Date.now() / 60_000)}`

const get = (env: Bindings, path: string) =>
  worker.fetch(new Request(`https://verifier.divine.video${path}`), env)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_MS)
  fetchedUrls = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('/verified counts its checks against the limits', () => {
  it('/verified/<pubkey> checks only as many tags as the pubkey limit has left and lists the rest as not checked', async () => {
    const { env, limitStore } = envWith()
    limitStore.set(counterKey('rl:pk', PK), '10')
    const tags = Array.from({ length: 20 }, (_, i) => {
      const nn = String(i).padStart(2, '0')
      return ['i', `github:user${nn}`, `proof${nn}x`]
    })
    relaysWith([await signedList(tags)])

    const res = await get(env, `/verified/${PK}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { verifications: unknown[]; unchecked: Array<{ platform: string; identity: string }> }

    const proofs = tags.map(tag => tag[2])
    expect(proofs.slice(0, 10).filter(checked)).toEqual(proofs.slice(0, 10))
    expect(proofs.slice(10).filter(checked)).toEqual([])
    expect(body.verifications).toEqual([])
    expect(body.unchecked).toEqual(tags.slice(10).map(tag => ({ platform: 'github', identity: tag[1].slice('github:'.length) })))
  })

  it('a lookup spends the platform limit once per check, in candidate order', async () => {
    const { env, limitStore } = envWith()
    limitStore.set(counterKey('rl:plat', 'github'), '27')
    // Relay candidates, newest first, each with its own proof for the account.
    const lists = await Promise.all(Array.from({ length: 5 }, (_, c) =>
      signedList([['i', 'github:alice', `cand${c}x`]], secretFor(0x41 + c), 1_700_000_100 - c)))
    relaysWith(lists)

    const res = await get(env, '/verified?platform=github&identity=alice')
    const proofs = lists.map(list => list.tags[0][2])
    expect(proofs.filter(checked)).toEqual(proofs.slice(0, 3))
    // The last two could not be checked and none verified, so the answer is unknown.
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: { code: 'temporarily_unavailable', message: 'this platform identity could not be fully checked; the result is unknown' },
    })
  })

  it("a lookup answers from one candidate when another candidate's limit cannot be read", async () => {
    const { env, cacheKv } = envWith()
    const checkedAt = Math.floor(NOW_MS / 1000) - 120
    await putCached(cacheKv, cacheKey('github', 'alice', 'p1', PK), {
      verified: true, method: 'proof_post', checked_at: checkedAt, type: 'verified',
    } as never)
    relaysWith([
      await signedList([['i', 'github:alice', 'p1']], SECRET, 1_700_000_000),
      await signedList([['i', 'github:alice', 'p2']], OTHER_SECRET, 1_700_000_500),
    ])
    const limits = env.RATE_LIMIT_KV
    const failing = {
      ...(limits as object),
      get: async (key: string) => {
        if (key.startsWith('rl:pk:') && key.includes(OTHER_PK)) throw new Error(`kv down for ${key}`)
        return limits.get(key)
      },
    } as unknown as KVNamespace

    const res = await get({ ...env, RATE_LIMIT_KV: failing }, '/verified?platform=github&identity=alice')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ platform: 'github', identity: 'alice', pubkey: PK, method: 'proof-post', verified_at: checkedAt })
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join(' ')
    expect(logged).not.toContain(OTHER_PK)
  })
})
