// ABOUTME: Tests /verify with the Confirmation gate on: a sign-in link saved while the gate is on, whose owner lacks Confirmation
// ABOUTME: tries the free routes first, then reports signin_needs_confirmation instead of signin_expired.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import worker from '../index'
import type { Bindings } from '../types'
import { oauthVerificationKey } from '../oauth/state'
import { confirmationAccessKey } from '../oauth/confirmation-access'
import { cacheKey } from '../utils/cache'
import { storageForm } from './verify'
import { hexToNpub } from '../utils/npub'

const PUBKEY = 'ab'.repeat(32)
const NPUB = hexToNpub(PUBKEY)
const DID = 'did:plc:abcdefghijklmnopqrstuvwx'
const PDS = 'https://example-pds.test'
const ACCESS_URL = 'https://access.example.test/v1/entitlements'
const NEEDS = 'This sign-in link needs Divine Confirmation to count.'

type Answer = { verified: boolean; error?: string; code?: string; method?: string }

function makeEnv(vars: Partial<Bindings> = {}) {
  const store = new Map<string, string>()
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, caches_used: 0 })),
  }
  const env = { CACHE_KV: kv as unknown as KVNamespace, RATE_LIMIT_KV: kv as unknown as KVNamespace, SIGNIN_CONFIRMATION: 'required', YOUTUBE_API_KEY: 'test-key', CONFIRMATION_GATE: 'on', CONFIRMATION_ACCESS_URL: ACCESS_URL, CONFIRMATION_ACCESS_TOKEN: 't', ...vars } as Bindings
  return { env, store, kv }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  // Any platform request a test doesn't expect answers 404: nothing found.
  fetchMock = vi.fn(async () => new Response('', { status: 404 }))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function single(env: Bindings, platform: string, identity: string, proof: string): Promise<Answer> {
  const res = await worker.fetch(new Request('https://verifier.divine.video/verify/single', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, identity, proof, pubkey: PUBKEY }),
  }), env)
  return await res.json() as Answer
}

async function batch(env: Bindings, platform: string, identity: string, proof: string): Promise<Answer> {
  const res = await worker.fetch(new Request('https://verifier.divine.video/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claims: [{ platform, identity, proof, pubkey: PUBKEY }] }),
  }), env)
  return (await res.json() as { results: Answer[] }).results[0]
}

async function link(env: Bindings, platform: string, identity: string, proof: string): Promise<Answer> {
  const res = await worker.fetch(new Request(`https://verifier.divine.video/verify/${platform}/${identity}/${proof}?pubkey=${PUBKEY}`, { headers: { Accept: 'application/json' } }), env)
  return await res.json() as Answer
}

const ROUTES = [['single', single], ['batch', batch], ['link', link]] as const
const ACCOUNTS = [['twitter', 'jack'], ['youtube', '@somechannel'], ['tiktok', 'someone']] as const

function markedRecord(store: Map<string, string>, platform: string, identity: string, { marked = true, ageDays = 0 } = {}) {
  store.set(oauthVerificationKey(platform as 'twitter', identity, PUBKEY), JSON.stringify({
    platform, identity, pubkey: PUBKEY, verified: true, method: 'oauth',
    checked_at: Math.floor(Date.now() / 1000) - ageDays * 24 * 60 * 60, confirmed: true,
    ...(marked ? { access_required: true } : {}),
  }))
}

// The access service answers for PUBKEY; everything else (Bluesky) falls through to routes or 404.
function access(answer: 'yes' | 'no' | 'down', routes?: (url: string) => Response | null) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === `${ACCESS_URL}/${PUBKEY}`) return answer === 'down' ? new Response('', { status: 500 }) : json({ isActive: answer === 'yes' })
    return routes?.(url) ?? new Response('', { status: 404 })
  })
}

function blueskyRoutes(records: unknown[]) {
  return (url: string): Response | null => {
    if (url.startsWith('https://bsky.social/xrpc/com.atproto.identity.resolveHandle')) return json({ did: DID })
    if (url === `https://plc.directory/${DID}`) return json({ service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] })
    if (url.startsWith(`${PDS}/xrpc/com.atproto.repo.listRecords`)) return json({ records })
    return null
  }
}
const accessCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith(ACCESS_URL)).length
const BSKY = 'alice.bsky.social'
const LINK_RECORD = {
  uri: `at://${DID}/video.divine.identity.link/nostr-npub`,
  value: { $type: 'video.divine.identity.link', version: 1, target: { protocol: 'nostr', id: NPUB } },
}


describe.each(ROUTES)('%s, gate on', (_route, check) => {
  it.each(ACCOUNTS)('%s: a marked record without access gives signin_needs_confirmation', async (platform, identity) => {
    const { env, store } = makeEnv(); markedRecord(store, platform, identity); access('no')
    const answer = await check(env, platform, identity, 'oauth')
    expect(answer).toMatchObject({ verified: false, code: 'signin_needs_confirmation', error: NEEDS })
  })

  it.each(ACCOUNTS)('%s: an unmarked record counts with no fetch', async (platform, identity) => {
    const { env, store } = makeEnv(); markedRecord(store, platform, identity, { marked: false })
    const answer = await check(env, platform, identity, 'oauth')
    expect(answer.verified).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(ACCOUNTS)('%s: a marked record with access unavailable counts', async (platform, identity) => {
    const { env, store } = makeEnv(); markedRecord(store, platform, identity); access('down')
    const answer = await check(env, platform, identity, 'oauth')
    expect(answer.verified).toBe(true)
    expect(answer.method).toBe('oauth')
  })

  it.each(ACCOUNTS)('%s: a marked record with access counts', async (platform, identity) => {
    const { env, store } = makeEnv(); markedRecord(store, platform, identity); access('yes')
    expect((await check(env, platform, identity, 'oauth')).verified).toBe(true)
  })
})

describe('gate on, edge cases', () => {
  it('a marked record past its lifetime gives signin_expired, without an access fetch', async () => {
    const { env, store } = makeEnv(); markedRecord(store, 'twitter', 'jack', { ageDays: 31 }); access('no')
    const answer = await single(env, 'twitter', 'jack', 'oauth')
    expect(answer.code).toBe('signin_expired')
    expect(answer.error).toBe('No current sign-in verifies this account.')
    expect(accessCalls()).toBe(0)
  })

  it('a marked Bluesky record without access still verifies by its identity-link record', async () => {
    const { env, store } = makeEnv(); markedRecord(store, 'bluesky', BSKY); access('no', blueskyRoutes([LINK_RECORD]))
    const answer = await single(env, 'bluesky', BSKY, 'oauth')
    expect(answer.verified).toBe(true)
    expect(answer.method).toBe('identity_link')
  })

  it('a marked Bluesky record without access and no identity-link record gives signin_needs_confirmation', async () => {
    const { env, store } = makeEnv(); markedRecord(store, 'bluesky', BSKY); access('no', blueskyRoutes([]))
    const answer = await single(env, 'bluesky', BSKY, 'oauth')
    expect(answer).toMatchObject({ verified: false, code: 'signin_needs_confirmation', error: NEEDS })
  })

  it('the lapse code is never stored in the result cache', async () => {
    const { env, store } = makeEnv(); markedRecord(store, 'bluesky', BSKY); access('no', blueskyRoutes([]))
    await single(env, 'bluesky', BSKY, 'oauth')
    const cached = store.get(cacheKey('bluesky', BSKY, 'oauth', PUBKEY))
    expect(cached).toBeDefined()
    expect(cached).not.toContain('signin_needs_confirmation')
    expect(cached).not.toContain('signin_expired')
  })

  it('a marked Bluesky record without access and a cached Bluesky failure gives signin_needs_confirmation, without asking Bluesky', async () => {
    const { env, store } = makeEnv(); markedRecord(store, 'bluesky', BSKY); access('no')
    store.set(cacheKey('bluesky', BSKY, 'oauth', PUBKEY), JSON.stringify({ verified: false, error: 'Bluesky post not found', checked_at: 1, type: 'failed' }))
    const answer = await single(env, 'bluesky', BSKY, 'oauth')
    expect(answer.code).toBe('signin_needs_confirmation')
    expect(fetchMock.mock.calls.every(([u]) => String(u).startsWith(ACCESS_URL))).toBe(true)
  })

  it('a marked record without access does not stop a proof post from verifying', async () => {
    const { env, store } = makeEnv(); markedRecord(store, 'twitter', 'jack'); access('no')
    const proof = 'https://x.com/jack/status/1234567890123456789'
    const claim = storageForm({ platform: 'twitter', identity: 'jack', proof, pubkey: PUBKEY })!
    store.set(cacheKey('twitter', claim.identity, claim.proof, PUBKEY), JSON.stringify({ verified: true, method: 'proof_post', checked_at: 1, type: 'verified' }))
    const answer = await single(env, 'twitter', 'jack', proof)
    expect(answer.verified).toBe(true)
  })

  it.each(['off', 'shadow', undefined] as const)('gate %j: a marked record counts with no fetch at all', async (gate) => {
    const { env, store } = makeEnv({ CONFIRMATION_GATE: gate }); markedRecord(store, 'twitter', 'jack')
    const answer = await single(env, 'twitter', 'jack', 'oauth')
    expect(answer.verified).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('logs the refused check with platform and mode, and nothing that identifies anyone', async () => {
    const { env, store } = makeEnv(); markedRecord(store, 'twitter', 'jack'); access('no')
    await single(env, 'twitter', 'jack', 'oauth')
    const info = vi.mocked(console.info).mock.calls.map((c) => c.join(' '))
    expect(info).toContain('twitter confirmation check for a saved link (on): no')
    const all = [console.info, console.warn, console.error].flatMap((f) => vi.mocked(f).mock.calls.map((c) => c.join(' ')))
    for (const line of all) {
      expect(line).not.toContain(PUBKEY)
      expect(line).not.toContain('jack')
    }
  })

  it('fetches and caches Confirmation access once when a batch checks several marked links for one pubkey', async () => {
    const { env, store, kv } = makeEnv()
    for (const [platform, identity] of ACCOUNTS) markedRecord(store, platform, identity)
    access('no')

    const res = await worker.fetch(new Request('https://verifier.divine.video/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claims: ACCOUNTS.map(([platform, identity]) => ({ platform, identity, proof: 'oauth', pubkey: PUBKEY })),
      }),
    }), env)
    const { results } = await res.json() as { results: Answer[] }

    expect(results).toHaveLength(3)
    for (const result of results) {
      expect(result).toMatchObject({ verified: false, code: 'signin_needs_confirmation', error: NEEDS })
    }
    expect(accessCalls()).toBe(1)
    const accessWrites = kv.put.mock.calls.filter(([key]) => key === confirmationAccessKey(PUBKEY))
    expect(accessWrites).toHaveLength(1)
  })

  it('does not hold a sibling platform check behind a slow Confirmation check for a sign-in link', async () => {
    const { env, store } = makeEnv()
    markedRecord(store, 'twitter', 'jack')

    let releaseAccess!: () => void
    const heldAccess = new Promise<void>((resolve) => { releaseAccess = resolve })
    let githubFetched = false
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `${ACCESS_URL}/${PUBKEY}`) {
        await heldAccess
        return json({ isActive: false })
      }
      if (url.includes('proofsiblingx')) {
        githubFetched = true
        return new Response('', { status: 404 })
      }
      return new Response('', { status: 404 })
    })

    const pending = worker.fetch(new Request('https://verifier.divine.video/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claims: [
          { platform: 'twitter', identity: 'jack', proof: 'oauth', pubkey: PUBKEY },
          { platform: 'github', identity: 'octocat', proof: 'proofsiblingx', pubkey: PUBKEY },
        ],
      }),
    }), env)

    await vi.waitFor(() => expect(githubFetched).toBe(true))
    releaseAccess()
    const { results } = await (await pending).json() as { results: Answer[] }
    expect(results[0]).toMatchObject({ verified: false, code: 'signin_needs_confirmation' })
    expect(results[1]).toMatchObject({ verified: false })
  })

  it('keeps a slow Confirmation check plus Bluesky fallback inside the 8-second batch budget', async () => {
    vi.useFakeTimers()
    try {
      const { env, store } = makeEnv()
      markedRecord(store, 'bluesky', BSKY)
      const routes = blueskyRoutes([])
      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input)
        if (url === `${ACCESS_URL}/${PUBKEY}`) {
          return new Promise((resolve) => setTimeout(() => resolve(json({ isActive: false })), 2_500))
        }
        return new Promise((resolve) => setTimeout(() => resolve(routes(url) ?? new Response('', { status: 404 })), 4_900))
      })

      const pending = single(env, 'bluesky', BSKY, 'oauth')
      await vi.advanceTimersByTimeAsync(8_000)
      const answer = await pending

      expect(answer).toMatchObject({ verified: false, code: 'temporarily_unavailable' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('GET /auth/:platform/status, gate on', () => {
  async function status(env: Bindings): Promise<{ verified: boolean }> {
    const res = await worker.fetch(new Request(`https://verifier.divine.video/auth/twitter/status?pubkey=${PUBKEY}&identity=jack`), env)
    return await res.json() as { verified: boolean }
  }

  it('a marked record without access is not verified', async () => {
    const { env, store } = makeEnv(); markedRecord(store, 'twitter', 'jack'); access('no')
    expect(await status(env)).toMatchObject({ verified: false })
  })

  it('a marked record with access unavailable is verified', async () => {
    const { env, store } = makeEnv(); markedRecord(store, 'twitter', 'jack'); access('down')
    expect(await status(env)).toMatchObject({ verified: true })
  })
})
