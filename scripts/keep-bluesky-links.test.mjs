import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepsUntilUnlinked } from '../src/oauth/signin-lifetime'
import { CACHE_KV_ID, PREFIX, isKeptRecord, keepBlueskyLinks } from './keep-bluesky-links.mjs'
import { ACCOUNT } from './production-release.mjs'

const PK = 'b'.repeat(64)
const key = id => `${PREFIX}${id}:${PK}`
const record = (extra = {}) => JSON.stringify({
  platform: 'bluesky', identity: 'x', pubkey: PK, confirmed: true, account_id: 'did:plc:abc', checked_at: 1, ...extra,
})
const EXP = 1_900_000_000

// A fake Cloudflare KV API over a Map<name, { value, expiration? }>.
function fake(entries, { onGet, failGet, status } = {}) {
  const store = new Map(entries)
  const calls = []
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    calls.push({ url: String(url), method })
    if (status) return new Response('{}', { status })
    if (u.pathname.endsWith('/keys')) {
      const limit = Number(u.searchParams.get('limit'))
      const start = Number(u.searchParams.get('cursor') || 0)
      const names = [...store.keys()].filter(n => n.startsWith(u.searchParams.get('prefix') ?? ''))
      const page = names.slice(start, start + limit)
      const next = start + limit < names.length ? String(start + limit) : ''
      return Response.json({
        result: page.map(name => ({ name, ...(store.get(name).expiration ? { expiration: store.get(name).expiration } : {}) })),
        result_info: { cursor: next },
      })
    }
    const name = decodeURIComponent(u.pathname.split('/values/')[1])
    if (method === 'PUT') {
      const entry = { value: init.body }
      if (u.searchParams.has('expiration') || u.searchParams.has('expiration_ttl')) entry.expiration = EXP
      store.set(name, entry)
      return Response.json({ success: true })
    }
    if (failGet) return new Response('boom', { status: 500 })
    onGet?.(name, store)
    if (!store.has(name)) return new Response('', { status: 404 })
    return new Response(store.get(name).value)
  })
  const puts = () => calls.filter(c => c.method === 'PUT')
  const lists = () => calls.filter(c => c.url.includes('/keys?'))
  return { store, fetchImpl, calls, puts, lists }
}
const run = (api, opts = {}) => keepBlueskyLinks({ token: 't', fetchImpl: api.fetchImpl, sleep: async () => {}, ...opts })
const sample = () => [
  [key('a'), { value: record(), expiration: EXP }],
  [key('b'), { value: record({ identity: 'b' }), expiration: EXP }],
  [key('c'), { value: record({ confirmed: false }), expiration: EXP }],
  [key('d'), { value: record({ account_id: undefined }), expiration: EXP }],
  [key('e'), { value: record() }],
]

afterEach(() => vi.restoreAllMocks())

describe('keepBlueskyLinks', () => {
  it('a dry run counts what it would keep and writes nothing', async () => {
    const api = fake(sample())
    const counts = await run(api)
    expect(counts).toMatchObject({ listed: 5, expiring: 4, eligible: 2, kept: 0 })
    expect(api.puts()).toHaveLength(0)
  })

  it('a real run re-puts only eligible records, with no expiry and kept: true', async () => {
    const api = fake(sample())
    const before = new Map([...api.store].map(([k, v]) => [k, { ...v }]))
    const counts = await run(api, { write: true })
    expect(counts).toMatchObject({ eligible: 2, kept: 2, changed: 0 })
    expect(api.puts()).toHaveLength(2)
    for (const p of api.puts()) {
      expect(p.url).not.toMatch(/expiration/)
      expect(p.url).not.toContain('?')
    }
    for (const id of ['a', 'b']) {
      const stored = api.store.get(key(id))
      expect(stored.expiration).toBeUndefined()
      expect(stored.value).toBe(JSON.stringify({ ...JSON.parse(before.get(key(id)).value), kept: true }))
    }
    for (const id of ['c', 'd', 'e']) expect(api.store.get(key(id))).toEqual(before.get(key(id)))
  })

  it('writes the same value with kept: true added to a record that has other fields', async () => {
    const api = fake([[key('a'), { value: record({ extra: 1 }), expiration: EXP }]])
    await run(api, { write: true })
    expect(JSON.parse(api.store.get(key('a')).value)).toMatchObject({ extra: 1, kept: true })
  })

  it('skips a record with kept: true and no expiration, and rewrites one with kept: true that expires', async () => {
    const api = fake([
      [key('a'), { value: record({ kept: true }) }],
      [key('b'), { value: record({ kept: true }), expiration: EXP }],
    ])
    const counts = await run(api, { write: true })
    expect(counts).toMatchObject({ listed: 2, expiring: 1, kept: 1 })
    expect(api.store.get(key('b')).expiration).toBeUndefined()
  })

  it('a second real run writes nothing', async () => {
    const api = fake(sample())
    await run(api, { write: true })
    const puts = api.puts().length
    const counts = await run(api, { write: true })
    expect(counts).toMatchObject({ eligible: 0, kept: 0 })
    expect(api.puts()).toHaveLength(puts)
  })

  it('asks only for Bluesky sign-in keys', async () => {
    const api = fake(sample())
    await run(api)
    expect(api.lists().length).toBeGreaterThan(0)
    for (const c of api.lists()) expect(c.url).toContain('prefix=oauth_verified%3Abluesky%3A')
  })

  it('visits every page of keys', async () => {
    const api = fake(sample())
    const original = api.fetchImpl
    const wrapped = vi.fn((url, init) => original(String(url).replace('limit=1000', 'limit=2'), init))
    const counts = await keepBlueskyLinks({ token: 't', fetchImpl: wrapped, sleep: async () => {} })
    expect(counts.listed).toBe(5)
    expect(api.lists()).toHaveLength(3)
  })

  it('keeps the handle and the DID record of a pair alike', async () => {
    const handle = record({ identity: 'alice.example' })
    const did = record({ identity: 'did:plc:abc' })
    const api = fake([
      [`${PREFIX}alice.example:${PK}`, { value: handle, expiration: EXP }],
      [`${PREFIX}did:plc:abc:${PK}`, { value: did, expiration: EXP }],
    ])
    await run(api, { write: true })
    for (const [k, v] of api.store) {
      expect(v.expiration).toBeUndefined()
      expect(JSON.parse(v.value)).toMatchObject({ kept: true })
      expect(k.startsWith(PREFIX)).toBe(true)
    }
  })

  it('does not write back a record deleted after it was read', async () => {
    let gets = 0
    const api = fake([[key('a'), { value: record(), expiration: EXP }]], {
      onGet: (name, store) => { if (++gets === 2) store.delete(name) },
    })
    const counts = await run(api, { write: true })
    expect(api.puts()).toHaveLength(0)
    expect(counts).toMatchObject({ changed: 1, kept: 0 })
  })

  it('does not write back a record that changed after it was read', async () => {
    let gets = 0
    const api = fake([[key('a'), { value: record(), expiration: EXP }]], {
      onGet: (name, store) => { if (++gets === 2) store.set(name, { value: record({ checked_at: 2 }), expiration: EXP }) },
    })
    const counts = await run(api, { write: true })
    expect(api.puts()).toHaveLength(0)
    expect(counts.changed).toBe(1)
  })

  it('skips a value that is not JSON', async () => {
    const api = fake([[key('a'), { value: 'not json', expiration: EXP }]])
    const counts = await run(api, { write: true })
    expect(counts).toMatchObject({ expiring: 1, eligible: 0, skipped: 1 })
    expect(api.puts()).toHaveLength(0)
  })

  it('stops with a run-again message on a 429, naming no key', async () => {
    const api = fake(sample(), { status: 429 })
    await expect(run(api)).rejects.toThrow('Cloudflare API rate limit reached; run the script again to continue')
  })

  it('never prints or throws a key name, value or URL', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const api = fake(sample(), { failGet: true })
    let message = ''
    try { await run(api, { write: true }) } catch (e) { message = e.message }
    expect(message).toBe('Cloudflare API answered 500')
    const all = JSON.stringify([log.mock.calls, err.mock.calls, message])
    for (const bad of ['oauth_verified:', PK, 'api.cloudflare.com', 'did:plc']) expect(all).not.toContain(bad)
  })

  it('waits paceMs between API calls', async () => {
    const api = fake([[key('a'), { value: record(), expiration: EXP }]])
    const sleep = vi.fn(async () => {})
    await keepBlueskyLinks({ token: 't', write: true, fetchImpl: api.fetchImpl, sleep })
    // list, get, get, put: a pause before every call after the first
    expect(api.calls).toHaveLength(4)
    expect(sleep).toHaveBeenCalledWith(300)
    // Pauses before the list's follow-ups only: before the first read and the re-read, none before the PUT.
    expect(sleep).toHaveBeenCalledTimes(2)
    const events = []
    const traced = fake([[key('a'), { value: record(), expiration: EXP }]])
    await keepBlueskyLinks({
      token: 't', write: true, sleep: async () => { events.push('sleep') },
      fetchImpl: (url, init) => { events.push(init?.method ?? 'GET'); return traced.fetchImpl(url, init) },
    })
    expect(events.slice(-3)).toEqual(['sleep', 'GET', 'PUT'])
  })

  it('throws a fixed message when the list body is unreadable', async () => {
    const fetchImpl = async () => new Response('{"result":[{"name":"oauth_verified:bluesky:x')
    const error = await keepBlueskyLinks({ token: 't', fetchImpl, sleep: async () => {} }).catch(e => e)
    expect(error.message).toBe('Cloudflare API answered with an unreadable body')
    expect(error.message).not.toContain('oauth_verified')
  })

  it('throws a fixed message when a value body cannot be read', async () => {
    const api = fake([[key('a'), { value: record(), expiration: EXP }]])
    const fetchImpl = async (url, init) => {
      const response = await api.fetchImpl(url, init)
      if (!String(url).includes('/values/')) return response
      return { ok: true, status: 200, text: async () => { throw new SyntaxError('Unexpected token oauth_verified:bluesky') } }
    }
    const error = await keepBlueskyLinks({ token: 't', fetchImpl, sleep: async () => {} }).catch(e => e)
    expect(error.message).toBe('Cloudflare API answered with an unreadable body')
  })

  it('throws a fixed message when the request itself fails', async () => {
    const fetchImpl = async () => { throw new Error('GET https://api.cloudflare.com/x/oauth_verified:bluesky:x failed') }
    const error = await keepBlueskyLinks({ token: 't', fetchImpl, sleep: async () => {} }).catch(e => e)
    expect(error.message).toBe('Cloudflare API request failed')
  })

  it('sends a cursor only after the first page, and defaults to the production account and namespace', async () => {
    const api = fake(sample())
    const original = api.fetchImpl
    const wrapped = vi.fn((url, init) => original(String(url).replace('limit=1000', 'limit=2'), init))
    await keepBlueskyLinks({ token: 't', fetchImpl: wrapped, sleep: async () => {} })
    const lists = api.lists().map(c => c.url)
    expect(lists[0]).not.toContain('cursor')
    expect(lists[1]).toContain('cursor=2')
    for (const c of api.calls) expect(c.url).toContain(`/accounts/${ACCOUNT}/storage/kv/namespaces/${CACHE_KV_ID}/`)
  })

  it('sends the token and targets the given account and namespace', async () => {
    const api = fake([])
    await run(api, { account: 'acct', namespace: 'ns' })
    expect(api.calls[0].url).toContain('/accounts/acct/storage/kv/namespaces/ns/keys')
    expect(api.fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer t')
  })
})

describe('isKeptRecord', () => {
  it('agrees with keepsUntilUnlinked', () => {
    const base = { platform: 'bluesky', identity: 'x', pubkey: PK, confirmed: true, account_id: 'did:plc:abc', checked_at: 1 }
    const table = [
      base, { ...base, confirmed: false }, { ...base, confirmed: undefined }, { ...base, account_id: undefined },
      { ...base, account_id: '' }, { ...base, platform: 'github' }, { ...base, kept: true },
    ]
    for (const r of table) expect(isKeptRecord(r)).toBe(keepsUntilUnlinked(r))
  })
  it('rejects non-objects', () => {
    for (const v of [null, 'x', 3, [], undefined]) expect(isKeptRecord(v)).toBe(false)
  })
})

describe('constants', () => {
  it('uses the namespace wrangler.toml binds as CACHE_KV', () => {
    const m = readFileSync('wrangler.toml', 'utf8').match(/binding = "CACHE_KV"\nid = "([0-9a-f]{32})"/)
    expect(m?.[1]).toBe(CACHE_KV_ID)
  })
  it('defaults to the production account', () => {
    expect(ACCOUNT).toMatch(/^[0-9a-f]{32}$/)
  })
})
