import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import worker from '../index'
import { fakeRelays, type FakeRelay } from '../contract/harness'
import { oauthVerificationKey } from '../oauth/state'
import { DIVINE_RELAY } from '../verified/linked-accounts'
import { cacheKey, putCached } from '../utils/cache'
import { hexToNpub } from '../utils/npub'
import { MAX_LIST_CLAIMS, MAX_LOOKUP_CANDIDATES } from './verified'
import type { Bindings } from '../types'
import type { SignedNostrEvent } from '../utils/nostr-event'

const DAMUS = 'wss://relay.damus.io'
const PRIMAL = 'wss://relay.primal.net'
const NOW = () => Math.floor(Date.now() / 1000)

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

const relay = (url: string, events: unknown[] = [], over: Partial<FakeRelay> = {}): FakeRelay => ({ url, events, seenFilters: [], ...over })

function relaysWith(events: unknown[], divine: Partial<FakeRelay> = {}, otherFetch?: typeof fetch): FakeRelay {
  const divineRelay = relay(DIVINE_RELAY, events, divine)
  fakeRelays([divineRelay, relay(DAMUS), relay(PRIMAL)], otherFetch)
  return divineRelay
}

// Each REQ that names authors is a read of that person's current list.
const listReads = (r: FakeRelay): string[] =>
  r.seenFilters.flatMap(filters => (filters as Array<{ authors?: string[] }>)[0]?.authors ?? [])

function memoryKv(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    // KV lists keys in lexicographic order.
    list: async ({ prefix = '' }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace
  return { kv, store }
}

function envWith(vars: Partial<Bindings> = {}) {
  const { kv, store } = memoryKv()
  return { env: { CACHE_KV: kv, RATE_LIMIT_KV: kv, ...vars } as Bindings, kv, store }
}

function seedSignIn(store: Map<string, string>, platform: string, identity: string, pubkey = PK, over: Record<string, unknown> = {}): number {
  const checkedAt = NOW() - 60
  store.set(oauthVerificationKey(platform, identity, pubkey), JSON.stringify({
    platform, identity, pubkey, verified: true, method: 'oauth', checked_at: checkedAt, confirmed: true, ...over,
  }))
  return checkedAt
}

async function seedProof(kv: KVNamespace, platform: string, identity: string, proof: string, pubkey = PK, over: Record<string, unknown> = {}): Promise<number> {
  const entry = { verified: true, method: 'proof_post', checked_at: NOW() - 120, type: 'verified', ...over }
  await putCached(kv, cacheKey(platform, identity, proof, pubkey), entry as never)
  return entry.checked_at as number
}

const get = (env: Bindings, path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://verifier.divine.video${path}`, { headers }), env)

const UNAVAILABLE = {
  error: { code: 'temporarily_unavailable', message: 'this platform identity could not be checked right now, try again shortly' },
}
const NOT_FOUND = { error: { code: 'not_found', message: 'no live verification for this platform identity' } }
const INVALID = { error: { code: 'invalid_request', message: 'platform and identity are required' } }

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('GET /verified?platform=&identity=', () => {
  it("finds a sign-in owner from the verifier's own records", async () => {
    const { env, store } = envWith()
    const checkedAt = seedSignIn(store, 'twitter', 'jack')
    relaysWith([await signedList([['i', 'twitter:jack', 'oauth']])])
    const res = await get(env, '/verified?platform=twitter&identity=jack')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({ platform: 'x', identity: 'jack', pubkey: PK, method: 'oauth', verified_at: checkedAt })
  })

  it('finds a sign-in owner whose list is on no relay search', async () => {
    const { env, store } = envWith()
    seedSignIn(store, 'twitter', 'jack')
    const list = await signedList([['i', 'twitter:jack', 'oauth']])
    // The search finds nothing, so only the sign-in record names the owner.
    relaysWith([list], { behaviour: filters => ((filters as Array<{ authors?: string[] }>)[0].authors ? 'answer' : 'refuse') })
    const res = await get(env, '/verified?platform=x&identity=jack')
    expect(res.status).toBe(200)
    expect((await res.json() as { pubkey: string }).pubkey).toBe(PK)
  })

  it('finds a proof-post owner through relays', async () => {
    const { env, kv } = envWith()
    const checkedAt = await seedProof(kv, 'github', 'alice', 'abc123')
    const divine = relaysWith([await signedList([['i', 'github:alice', 'abc123']])])
    const res = await get(env, '/verified?platform=github&identity=alice')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ platform: 'github', identity: 'alice', pubkey: PK, method: 'proof-post', verified_at: checkedAt })
    const search = divine.seenFilters.find(filters => (filters as Array<{ '#i'?: string[] }>)[0]['#i'])
    expect((search as Array<{ '#i': string[] }>)[0]['#i']).toContain('github:alice')
  })

  it('accepts x and twitter', async () => {
    const { env, store } = envWith()
    seedSignIn(store, 'twitter', 'jack')
    relaysWith([await signedList([['i', 'twitter:jack', 'oauth']])])
    const viaX = await (await get(env, '/verified?platform=X&identity=jack')).json()
    const viaTwitter = await (await get(env, '/verified?platform=twitter&identity=jack')).json()
    expect(viaX).toMatchObject({ platform: 'x', pubkey: PK })
    expect(viaTwitter).toEqual(viaX)
  })

  it('not found when the sign-in owner removed the tag', async () => {
    const { env, store } = envWith()
    seedSignIn(store, 'twitter', 'jack')
    relaysWith([await signedList([])])
    const res = await get(env, '/verified?platform=twitter&identity=jack')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND)
    const person = await (await get(env, `/verified/${PK}`)).json() as { verifications: unknown[] }
    expect(person.verifications).toEqual([])
  })

  it('not found for an expired sign-in', async () => {
    const { env, store } = envWith()
    seedSignIn(store, 'twitter', 'jack', PK, { checked_at: NOW() - 31 * 24 * 60 * 60 })
    relaysWith([await signedList([['i', 'twitter:jack', 'oauth']])])
    const res = await get(env, '/verified?platform=twitter&identity=jack')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND)
  })

  it("try later when the only candidate's platform could not be checked", async () => {
    const { env } = envWith()
    relaysWith([await signedList([['i', 'twitter:alice', '1234567890']])], {}, async () => { throw new Error('no network in tests') })
    const res = await get(env, '/verified?platform=twitter&identity=alice')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(UNAVAILABLE)
  })

  it("try later when the only candidate's list could not be read", async () => {
    const { env, kv } = envWith()
    await seedProof(kv, 'github', 'alice', 'abc123')
    // Divine's relay answers the search but refuses the read of the person's list.
    relaysWith([await signedList([['i', 'github:alice', 'abc123']])], {
      behaviour: filters => ((filters as Array<{ authors?: string[] }>)[0].authors ? 'refuse' : 'answer'),
    })
    const res = await get(env, '/verified?platform=github&identity=alice')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(UNAVAILABLE)
  })

  it('picks the most recently verified owner', async () => {
    const { env, kv } = envWith()
    await seedProof(kv, 'github', 'alice', '1', PK, { checked_at: NOW() - 900 })
    const newest = await seedProof(kv, 'github', 'alice', '2', OTHER_PK, { checked_at: NOW() - 100 })
    // The older verification has the newer list, so it comes first in candidate order.
    relaysWith([
      await signedList([['i', 'github:alice', '1']], SECRET, 1_700_000_500),
      await signedList([['i', 'github:alice', '2']], OTHER_SECRET, 1_700_000_000),
    ])
    const res = await get(env, '/verified?platform=github&identity=alice')
    expect(await res.json()).toEqual({ platform: 'github', identity: 'alice', pubkey: OTHER_PK, method: 'proof-post', verified_at: newest })
  })

  it('never names a pubkey whose claim does not check out', async () => {
    const { env, kv } = envWith()
    await seedProof(kv, 'github', 'alice', 'abc123')
    await seedProof(kv, 'github', 'bob', 'abc123')
    // An older list still carries the tag, but the person's current list verifies only another account.
    const old = await signedList([['i', 'github:alice', 'abc123']], SECRET, 1_600_000_000)
    const current = await signedList([['i', 'github:bob', 'abc123']], SECRET, 1_700_000_000)
    fakeRelays([relay(DIVINE_RELAY, [current]), relay(DAMUS, [old]), relay(PRIMAL)])
    const res = await get(env, '/verified?platform=github&identity=alice')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND)
  })

  it('ignores a search hit whose signature does not verify', async () => {
    const { env } = envWith()
    const genuine = await signedList([['i', 'github:alice', 'abc123']], OTHER_SECRET)
    const forged = { ...genuine, sig: genuine.sig.replace(/^./, c => (c === '0' ? '1' : '0')) }
    const divine = relay(DIVINE_RELAY)
    fakeRelays([divine, relay(DAMUS, [forged]), relay(PRIMAL)])
    const res = await get(env, '/verified?platform=github&identity=alice')
    expect(res.status).toBe(404)
    expect(listReads(divine)).toEqual([])
  })

  it('checks at most 10 candidates, sign-ins first', async () => {
    const { env, store } = envWith()
    const signIns = [0x31, 0x32, 0x33].map(n => pubkeyOf(secretFor(n)))
    for (const pubkey of signIns) seedSignIn(store, 'twitter', 'jack', pubkey)
    const lists = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      signedList([['i', 'twitter:jack', 'oauth']], secretFor(0x41 + i), 1_700_000_000 + i)))
    const divine = relaysWith(lists)
    await get(env, '/verified?platform=twitter&identity=jack')
    const read = listReads(divine)
    expect(MAX_LOOKUP_CANDIDATES).toBe(10)
    expect(read).toHaveLength(10)
    expect(new Set(read).size).toBe(10)
    for (const pubkey of signIns) expect(read).toContain(pubkey)
    // The remaining room goes to the newest relay hits.
    const newestSeven = lists.slice(5).map(list => list.pubkey)
    expect(read.filter(pubkey => !signIns.includes(pubkey)).sort()).toEqual(newestSeven.sort())
  })

  it("reads every candidate's list in one request per relay", async () => {
    const { env } = envWith()
    const lists = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      signedList([['i', 'twitter:jack', 'oauth']], secretFor(0x41 + i), 1_700_000_000 + i)))
    const relays = [relay(DIVINE_RELAY, lists), relay(DAMUS), relay(PRIMAL)]
    fakeRelays(relays)
    await get(env, '/verified?platform=twitter&identity=jack')
    for (const r of relays) {
      const listRequests = r.seenFilters.filter(filters => (filters as Array<{ authors?: string[] }>)[0].authors)
      expect(listRequests).toHaveLength(1)
      expect((listRequests[0] as Array<{ authors: string[] }>)[0].authors).toHaveLength(10)
    }
  })

  it('keeps the first candidate on a tie', async () => {
    const { env, kv } = envWith()
    const checkedAt = NOW() - 300
    await seedProof(kv, 'github', 'alice', '1', PK, { checked_at: checkedAt })
    await seedProof(kv, 'github', 'alice', '2', OTHER_PK, { checked_at: checkedAt })
    // PK's list is newer, so PK comes first.
    relaysWith([
      await signedList([['i', 'github:alice', '1']], SECRET, 1_700_000_500),
      await signedList([['i', 'github:alice', '2']], OTHER_SECRET, 1_700_000_000),
    ])
    const res = await get(env, '/verified?platform=github&identity=alice')
    expect(await res.json()).toMatchObject({ pubkey: PK, verified_at: checkedAt })
  })

  it('answers a verified owner even when another candidate could not be read', async () => {
    const { env, store } = envWith()
    seedSignIn(store, 'twitter', 'jack', PK)
    seedSignIn(store, 'twitter', 'jack', OTHER_PK)
    const genuine = await signedList([['i', 'twitter:jack', 'oauth']], OTHER_SECRET)
    // Divine sends OTHER_PK a list that fails the checks, so only OTHER_PK is unread.
    const forged = { ...genuine, sig: genuine.sig.replace(/^./, c => (c === '0' ? '1' : '0')) }
    relaysWith([await signedList([['i', 'twitter:jack', 'oauth']]), forged])
    const res = await get(env, '/verified?platform=twitter&identity=jack')
    expect(res.status).toBe(200)
    expect((await res.json() as { pubkey: string }).pubkey).toBe(PK)
  })

  it("try later when Divine's relay could not be searched", async () => {
    const { env } = envWith()
    relaysWith([], { behaviour: filters => ((filters as Array<{ authors?: string[] }>)[0].authors ? 'answer' : 'refuse') })
    const res = await get(env, '/verified?platform=github&identity=alice')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(UNAVAILABLE)
  })

  it('not found when only another relay could not be searched', async () => {
    const { env } = envWith()
    fakeRelays([relay(DIVINE_RELAY), relay(DAMUS, [], { behaviour: 'refuse' }), relay(PRIMAL, [], { behaviour: 'drop' })])
    const res = await get(env, '/verified?platform=github&identity=alice')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND)
  })

  it('finds the owner from a pasted profile link', async () => {
    const { env, kv } = envWith()
    const channel = 'UCabcdefghijklmnopqrstuv'
    await seedProof(kv, 'youtube', channel, 'dQw4w9WgXcQ')
    relaysWith([await signedList([['i', `youtube:${channel}`, 'dQw4w9WgXcQ']])])
    const link = encodeURIComponent(`https://www.youtube.com/channel/${channel}`)
    const res = await get(env, `/verified?platform=youtube&identity=${link}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ platform: 'youtube', identity: channel, pubkey: PK })
  })

  it('matches a Bluesky tag naming the DID from a lookup by handle', async () => {
    const { env, store } = envWith()
    const record = { account_id: 'did:plc:abcdefghijklmnopqrstuvwx', handle: 'alice.bsky.social' }
    seedSignIn(store, 'bluesky', 'alice.bsky.social', PK, record)
    seedSignIn(store, 'bluesky', 'did:plc:abcdefghijklmnopqrstuvwx', PK, record)
    const divine = relaysWith([await signedList([['i', 'bluesky:did:plc:abcdefghijklmnopqrstuvwx', 'oauth']])])
    const res = await get(env, '/verified?platform=bluesky&identity=alice.bsky.social')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ platform: 'bluesky', identity: 'alice.bsky.social', pubkey: PK, method: 'oauth' })
    const search = divine.seenFilters.find(filters => (filters as Array<{ '#i'?: string[] }>)[0]['#i'])
    expect((search as Array<{ '#i': string[] }>)[0]['#i']).toContain('bluesky:did:plc:abcdefghijklmnopqrstuvwx')
  })

  it('not found when the looked-up handle now points to another account', async () => {
    const { env, store } = envWith()
    const record = { account_id: 'did:plc:abcdefghijklmnopqrstuvwx', handle: 'alice.bsky.social' }
    seedSignIn(store, 'bluesky', 'alice.bsky.social', PK, record)
    seedSignIn(store, 'bluesky', 'did:plc:abcdefghijklmnopqrstuvwx', PK, record)
    const resolved: string[] = []
    relaysWith([await signedList([['i', 'bluesky:did:plc:abcdefghijklmnopqrstuvwx', 'oauth']])], {}, (async (input: RequestInfo | URL) => {
      resolved.push(String(input))
      return new Response(JSON.stringify({ did: 'did:plc:newowner' }), { status: 200 })
    }) as typeof fetch)
    const res = await get(env, '/verified?platform=bluesky&identity=alice.bsky.social')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND)
    expect(resolved.some(url => url.includes('resolveHandle') && url.includes('alice.bsky.social'))).toBe(true)
  })

  it("not found when a tag naming the handle's old DID only holds as the handle", async () => {
    const { env, store } = envWith()
    const oldDid = 'did:plc:abcdefghijklmnopqrstuvwx'
    // Another person signed in as the handle back when it pointed to the old DID.
    seedSignIn(store, 'bluesky', 'alice.bsky.social', OTHER_PK, { account_id: oldDid, handle: 'alice.bsky.social' })
    // PK tags the old DID with a post and has no sign-in of its own.
    relaysWith([await signedList([['i', `bluesky:${oldDid}`, '3kabcdefghi22']])], {}, (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('resolveHandle')) return new Response(JSON.stringify({ did: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz' }), { status: 200 })
      // The handle's new owner posts PK's npub at the same record key.
      if (url.includes('getPostThread') && url.includes(encodeURIComponent('at://alice.bsky.social/'))) {
        return new Response(JSON.stringify({ thread: { post: {
          author: { handle: 'alice.bsky.social', did: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz' }, record: { text: hexToNpub(PK) },
        } } }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }) as typeof fetch)
    const res = await get(env, '/verified?platform=bluesky&identity=alice.bsky.social')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND)
  })

  it('not found by DID when the tag names a handle that moved to another account', async () => {
    const { env, store } = envWith()
    const did = 'did:plc:abcdefghijklmnopqrstuvwx'
    const record = { account_id: did, handle: 'alice.bsky.social' }
    seedSignIn(store, 'bluesky', 'alice.bsky.social', PK, record)
    seedSignIn(store, 'bluesky', did, PK, record)
    relaysWith([await signedList([['i', 'bluesky:alice.bsky.social', 'oauth']])], {}, (async (input: RequestInfo | URL) =>
      String(input).includes('resolveHandle')
        ? new Response(JSON.stringify({ did: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz' }), { status: 200 })
        : new Response('{}', { status: 404 })) as typeof fetch)
    const res = await get(env, `/verified?platform=bluesky&identity=${did}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND)
    // Both endpoints agree.
    expect((await (await get(env, `/verified/${PK}`)).json() as { verifications: unknown[] }).verifications).toEqual([])
  })

  describe('a tag naming another spelling of the account', () => {
    const did = 'did:plc:abcdefghijklmnopqrstuvwx'
    const handle = 'alice.bsky.social'
    const failed = { verified: false, method: undefined, type: 'failed', code: 'proof_not_found' }
    const down = { verified: false, method: undefined, type: 'platform_error', code: 'temporarily_unavailable' }

    // Another person's sign-in links the handle to the DID; PK's checks come from the cache.
    async function setUp(tags: string[][]) {
      const { env, kv, store } = envWith()
      seedSignIn(store, 'bluesky', handle, OTHER_PK, { account_id: did, handle })
      relaysWith([await signedList(tags)])
      return { env, kv }
    }

    it('is not found when it fails as tagged, even if the other check could not be made', async () => {
      const { env, kv } = await setUp([['i', `bluesky:${did}`, 'p1']])
      await seedProof(kv, 'bluesky', did, 'p1', PK, failed)
      await seedProof(kv, 'bluesky', handle, 'p1', PK, down)
      const res = await get(env, `/verified?platform=bluesky&identity=${handle}`)
      expect(res.status).toBe(404)
    })

    it('is try later when it holds as tagged and the other check could not be made', async () => {
      const { env, kv } = await setUp([['i', `bluesky:${did}`, 'p1']])
      await seedProof(kv, 'bluesky', did, 'p1', PK)
      await seedProof(kv, 'bluesky', handle, 'p1', PK, down)
      const res = await get(env, `/verified?platform=bluesky&identity=${handle}`)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual(UNAVAILABLE)
    })

    it('answers the account asked about, verified when that check was made', async () => {
      const { env, kv } = await setUp([['i', `bluesky:${did}`, 'p1']])
      await seedProof(kv, 'bluesky', did, 'p1', PK, { checked_at: NOW() - 900 })
      const checkedAt = await seedProof(kv, 'bluesky', handle, 'p1', PK, { checked_at: NOW() - 100 })
      const res = await get(env, `/verified?platform=bluesky&identity=${handle}`)
      expect(await res.json()).toEqual({ platform: 'bluesky', identity: handle, pubkey: PK, method: 'proof-post', verified_at: checkedAt })
    })

    it('uses two of the checks a list is allowed', async () => {
      const proofs = Array.from({ length: 11 }, (_, i) => `p${i}`)
      const { env, kv } = await setUp(proofs.map(proof => ['i', `bluesky:${did}`, proof]))
      for (const proof of proofs.slice(0, 10)) {
        await seedProof(kv, 'bluesky', did, proof, PK, failed)
        await seedProof(kv, 'bluesky', handle, proof, PK, failed)
      }
      // Only the eleventh tag holds, and it needs checks 21 and 22.
      await seedProof(kv, 'bluesky', did, 'p10', PK)
      await seedProof(kv, 'bluesky', handle, 'p10', PK)
      expect(MAX_LIST_CLAIMS).toBe(20)
      const res = await get(env, `/verified?platform=bluesky&identity=${handle}`)
      expect(res.status).toBe(404)
    })

    it('stops at the first tag that does not fit in the checks left', async () => {
      const aliases = Array.from({ length: 10 }, (_, i) => `a${i}`)
      const { env, kv } = await setUp([
        ['i', `bluesky:${handle}`, 'd0'],
        ...aliases.map(proof => ['i', `bluesky:${did}`, proof]),
        ['i', `bluesky:${handle}`, 'd1'],
      ])
      await seedProof(kv, 'bluesky', handle, 'd0', PK, failed)
      for (const proof of aliases) {
        await seedProof(kv, 'bluesky', did, proof, PK, failed)
        await seedProof(kv, 'bluesky', handle, proof, PK, failed)
      }
      // 1 + 9 x 2 = 19 checks, so the tenth alias tag needs 2 and the list stops there,
      // in tag order, before the last tag, which would hold.
      await seedProof(kv, 'bluesky', handle, 'd1', PK)
      const res = await get(env, `/verified?platform=bluesky&identity=${handle}`)
      expect(res.status).toBe(404)
    })
  })

  describe('key-size guard', () => {
    const did = 'did:plc:abcdefghijklmnopqrstuvwx'
    // Fits a sign-in record's key, but not a proof's key together with a long proof.
    const longHandle = `${'a'.repeat(188)}.bsky.social`
    const longProof = 'p'.repeat(300)

    // KV refuses keys over 512 bytes.
    function strictKv(kv: KVNamespace): KVNamespace {
      const guard = (key: string) => {
        if (new TextEncoder().encode(key).length > 512) throw new Error('key too long')
      }
      return {
        ...(kv as object),
        get: async (key: string) => { guard(key); return kv.get(key) },
        put: async (key: string, value: string, opts?: unknown) => { guard(key); return kv.put(key, value, opts as never) },
      } as unknown as KVNamespace
    }

    it("skips a tag whose check as the account asked about wouldn't fit, and answers the owner", async () => {
      const { env, store } = envWith()
      const record = { account_id: did, handle: longHandle }
      seedSignIn(store, 'bluesky', longHandle, PK, record)
      seedSignIn(store, 'bluesky', did, PK, record)
      relaysWith([
        await signedList([['i', `bluesky:${longHandle}`, 'oauth']]),
        await signedList([['i', `bluesky:${did}`, longProof]], OTHER_SECRET),
      ])
      const kv = strictKv(env.CACHE_KV)
      const res = await get({ ...env, CACHE_KV: kv, RATE_LIMIT_KV: kv }, `/verified?platform=bluesky&identity=${longHandle}`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ identity: longHandle, pubkey: PK })
    })

    it('checks a tag with a long pasted proof whose tidy form fits as the account asked about', async () => {
      const { env, store } = envWith()
      const record = { account_id: did, handle: longHandle }
      seedSignIn(store, 'bluesky', longHandle, PK, record)
      seedSignIn(store, 'bluesky', did, PK, record)
      // Sent with the long handle, this link's keys would not fit; tidied to the post's
      // record key, they do, and /verify checks it in that form.
      const pastedLink = `https://bsky.app/profile/${did}/post/3k2abcdefgh2a?ref=${'x'.repeat(250)}`
      relaysWith([await signedList([['i', `bluesky:${did}`, pastedLink]])])
      const kv = strictKv(env.CACHE_KV)
      const res = await get({ ...env, CACHE_KV: kv, RATE_LIMIT_KV: kv }, `/verified?platform=bluesky&identity=${longHandle}`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ identity: longHandle, pubkey: PK })
    })

    it("treats a tag whose check wouldn't fit as not verified, not as couldn't-check", async () => {
      const { env, store } = envWith()
      seedSignIn(store, 'bluesky', longHandle, PK, { account_id: did, handle: longHandle })
      relaysWith([await signedList([['i', `bluesky:${did}`, longProof]], OTHER_SECRET)])
      const kv = strictKv(env.CACHE_KV)
      const res = await get({ ...env, CACHE_KV: kv, RATE_LIMIT_KV: kv }, `/verified?platform=bluesky&identity=${longHandle}`)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(NOT_FOUND)
    })
  })

  it('answers a verified owner when checking another candidate fails', async () => {
    const { env, kv } = envWith()
    await seedProof(kv, 'github', 'alice', 'p1')
    relaysWith([
      await signedList([['i', 'github:alice', 'p1']], SECRET, 1_700_000_000),
      await signedList([['i', 'github:alice', 'p2']], OTHER_SECRET, 1_700_000_500),
    ])
    // Storage fails for everything about the other candidate.
    const failing = {
      ...(kv as object),
      get: async (key: string) => { if (key.includes(OTHER_PK)) throw new Error('kv down'); return kv.get(key) },
    } as unknown as KVNamespace
    const res = await get({ ...env, CACHE_KV: failing, RATE_LIMIT_KV: failing }, '/verified?platform=github&identity=alice')
    expect(res.status).toBe(200)
    expect((await res.json() as { pubkey: string }).pubkey).toBe(PK)
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join(' ')
    expect(logged).not.toContain(OTHER_PK)
  })

  it('try later when checking the only candidate fails', async () => {
    const { env, kv } = envWith()
    relaysWith([await signedList([['i', 'github:alice', 'p1']])])
    // Storage fails for everything about the candidate, so its check throws.
    const failing = {
      ...(kv as object),
      get: async (key: string) => { if (key.includes(PK)) throw new Error('kv down'); return kv.get(key) },
    } as unknown as KVNamespace
    const res = await get({ ...env, CACHE_KV: failing, RATE_LIMIT_KV: failing }, '/verified?platform=github&identity=alice')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(UNAVAILABLE)
  })

  it('finds a tag spelled plainly from an identity that tidies more than once', async () => {
    const { env, kv } = envWith()
    await seedProof(kv, 'github', 'alice', 'p1')
    relaysWith([await signedList([['i', 'github:alice', 'p1']])])
    const res = await get(env, `/verified?platform=github&identity=${encodeURIComponent('@@alice')}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ identity: 'alice', pubkey: PK })
  })

  it('ignores sign-in records of a longer account that starts the same', async () => {
    const { env, store } = envWith()
    seedSignIn(store, 'bluesky', 'did:web:a:b', PK)
    const divine = relaysWith([])
    const res = await get(env, '/verified?platform=bluesky&identity=did:web:a')
    expect(res.status).toBe(404)
    expect(listReads(divine)).toEqual([])
  })

  it('answers 400 invalid_request for a missing platform or identity, or an unknown platform', async () => {
    const { env } = envWith()
    relaysWith([])
    for (const query of ['identity=jack', 'platform=twitter', 'platform=twitter&identity=%20', 'platform=myspace&identity=jack']) {
      const res = await get(env, `/verified?${query}`)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual(INVALID)
    }
  })

  it('answers 404 for a platform the old site listed but this service does not verify', async () => {
    const { env } = envWith()
    relaysWith([])
    const res = await get(env, '/verified?platform=Instagram&identity=jack')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND)
  })

  it('judges the identity as sent, not as tidied', async () => {
    const { env } = envWith()
    const divine = relaysWith([])
    // Tidies to the handle @alice, but /verify would reject it as sent.
    const link = encodeURIComponent("https://www.youtube.com/@alice?x='")
    const res = await get(env, `/verified?platform=youtube&identity=${link}`)
    expect(res.status).toBe(404)
    expect(divine.seenFilters).toEqual([])
  })

  it('answers 404 for an identity no claim could carry', async () => {
    const { env } = envWith()
    const divine = relaysWith([])
    const res = await get(env, `/verified?platform=github&identity=${'a'.repeat(501)}`)
    expect(res.status).toBe(404)
    expect(divine.seenFilters).toEqual([])
  })

  it('answers 429 in the old shape', async () => {
    const { env } = envWith()
    relaysWith([])
    const ip = { 'cf-connecting-ip': '203.0.113.9' }
    for (let i = 0; i < 60; i++) expect((await get(env, '/verified?platform=github&identity=alice', ip)).status).toBe(404)
    const res = await get(env, '/verified?platform=github&identity=alice', ip)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: { code: 'rate_limited', message: 'rate limit exceeded' } })
  })

  it('checks the rate limit before the input', async () => {
    const { env } = envWith()
    const ip = { 'cf-connecting-ip': '203.0.113.9' }
    for (let i = 0; i < 60; i++) await get(env, '/verified?platform=myspace', ip)
    expect((await get(env, '/verified?platform=myspace', ip)).status).toBe(429)
  })

  it('answers 503 in the old shape when storage fails', async () => {
    const { env } = envWith()
    const failing = { ...(env.CACHE_KV as object), list: async () => { throw new Error('kv down') } } as unknown as KVNamespace
    relaysWith([])
    const res = await get({ ...env, CACHE_KV: failing }, '/verified?platform=twitter&identity=jack')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(UNAVAILABLE)
  })

  it('answers 503 in the old shape when the request cannot be counted', async () => {
    const { env } = envWith()
    const failing = { ...(env.RATE_LIMIT_KV as object), get: async () => { throw new Error('kv down') } } as unknown as KVNamespace
    const res = await get({ ...env, RATE_LIMIT_KV: failing }, '/verified?platform=twitter&identity=jack')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(UNAVAILABLE)
  })

  it('allows any origin', async () => {
    const { env } = envWith()
    relaysWith([])
    const res = await get(env, '/verified?platform=github&identity=alice', { Origin: 'https://example.com' })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})
