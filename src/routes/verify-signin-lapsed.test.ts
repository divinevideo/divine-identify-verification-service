// ABOUTME: Tests that a sign-in link that stops counting answers with a code instead
// ABOUTME: of a proof-post failure: signin_expired (no counted record) or signin_account_changed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import worker from '../index'
import type { Bindings } from '../types'
import { oauthVerificationKey } from '../oauth/state'
import { cacheKey } from '../utils/cache'
import { hexToNpub } from '../utils/npub'

const PUBKEY = 'ab'.repeat(32)
const NPUB = hexToNpub(PUBKEY)
const DID = 'did:plc:abcdefghijklmnopqrstuvwx'
const PDS = 'https://example-pds.test'

type Answer = { verified: boolean; error?: string; code?: string; method?: string }

function makeEnv(vars: Partial<Bindings> = {}) {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
  } as unknown as KVNamespace
  const env = { CACHE_KV: kv, RATE_LIMIT_KV: kv, SIGNIN_CONFIRMATION: 'required', YOUTUBE_API_KEY: 'test-key', ...vars } as Bindings
  return { env, store }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  // Any platform request a test doesn't expect answers 404: nothing found.
  fetchMock = vi.fn(async () => new Response('', { status: 404 }))
  vi.stubGlobal('fetch', fetchMock)
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
const ACCOUNTS = [['twitter', 'jack'], ['youtube', 'somechannel'], ['tiktok', 'someone']] as const

function confirmedRecord(store: Map<string, string>, platform: string, identity: string) {
  store.set(oauthVerificationKey(platform as 'twitter', identity, PUBKEY), JSON.stringify({
    platform, identity, pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: 1, confirmed: true,
  }))
}

describe('a sign-in link with no counted sign-in answers signin_expired and the neutral message', () => {
  describe.each(ROUTES)('%s', (_route, check) => {
    it.each(ACCOUNTS)('%s: no record gives signin_expired without asking the platform', async (platform, identity) => {
      const { env } = makeEnv()
      const answer = await check(env, platform, identity, 'oauth')
      expect(answer.verified).toBe(false)
      expect(answer.code).toBe('signin_expired')
      expect(answer.error).toBe('No current sign-in verifies this account.')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each(ACCOUNTS)('%s: a record that does not count (unconfirmed, once required) gives signin_expired', async (platform, identity) => {
      const { env, store } = makeEnv()
      store.set(oauthVerificationKey(platform as 'twitter', identity, PUBKEY), JSON.stringify({
        platform, identity, pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: 1,
      }))
      const answer = await check(env, platform, identity, 'oauth')
      expect(answer.code).toBe('signin_expired')
    })

    it.each(ACCOUNTS)('%s: a confirmed record still verifies', async (platform, identity) => {
      const { env, store } = makeEnv()
      confirmedRecord(store, platform, identity)
      const answer = await check(env, platform, identity, 'oauth')
      expect(answer.verified).toBe(true)
      expect(answer.method).toBe('oauth')
      expect(answer.code).toBeUndefined()
    })
  })

  it('a fresh sign-in is not hidden by an earlier lapsed answer', async () => {
    const { env, store } = makeEnv()
    expect((await single(env, 'twitter', 'jack', 'oauth')).code).toBe('signin_expired')
    confirmedRecord(store, 'twitter', 'jack')
    expect((await single(env, 'twitter', 'jack', 'oauth')).verified).toBe(true)
  })

  it('an earlier cached proof-post failure for the sign-in link is not shown instead', async () => {
    const { env, store } = makeEnv()
    store.set(cacheKey('twitter', 'jack', 'oauth', PUBKEY), JSON.stringify({
      verified: false, error: 'Tweet not found', checked_at: 1, type: 'failed',
    }))
    const answer = await single(env, 'twitter', 'jack', 'oauth')
    expect(answer.code).toBe('signin_expired')
  })

  it('a proof post on a sign-in platform keeps its own failure', async () => {
    const { env } = makeEnv()
    const answer = await single(env, 'twitter', 'jack', '1234567890123456789')
    expect(answer.verified).toBe(false)
    expect(answer.code).not.toBe('signin_expired')
  })

  it('a sign-in value with spaces around it is still a sign-in link', async () => {
    const { env } = makeEnv()
    const answer = await single(env, 'twitter', 'jack', ' oauth ')
    expect(answer.code).toBe('signin_expired')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the sign-in value only counts as written: "OAuth" is a proof like any other', async () => {
    const { env } = makeEnv()
    const answer = await single(env, 'tiktok', 'someone', 'OAuth')
    expect(answer.code).not.toBe('signin_expired')
  })

  it('a platform without sign-in is not affected', async () => {
    const { env } = makeEnv()
    const answer = await single(env, 'github', 'octocat', 'oauth')
    expect(answer.code).not.toBe('signin_expired')
  })
})

describe('Bluesky sign-in links', () => {
  function blueskyFetch(records: unknown[]) {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('https://bsky.social/xrpc/com.atproto.identity.resolveHandle')) return json({ did: DID })
      if (url === `https://plc.directory/${DID}`) return json({ service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] })
      if (url.startsWith(`${PDS}/xrpc/com.atproto.repo.listRecords`)) return json({ records })
      return new Response('', { status: 404 })
    })
  }

  it.each(ROUTES)('%s: no record and no identity-link record gives signin_expired', async (_route, check) => {
    blueskyFetch([])
    const { env } = makeEnv()
    const answer = await check(env, 'bluesky', 'alice.bsky.social', 'oauth')
    expect(answer.verified).toBe(false)
    expect(answer.code).toBe('signin_expired')
  })

  it('an identity-link record still verifies a lapsed sign-in link', async () => {
    blueskyFetch([{
      uri: `at://${DID}/video.divine.identity.link/nostr-npub`,
      value: { $type: 'video.divine.identity.link', version: 1, target: { protocol: 'nostr', id: NPUB } },
    }])
    const { env } = makeEnv()
    const answer = await single(env, 'bluesky', 'alice.bsky.social', 'oauth')
    expect(answer.verified).toBe(true)
    expect(answer.method).toBe('identity_link')
  })

  it('a Bluesky outage stays "try again"', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('network down') })
    const { env } = makeEnv()
    const answer = await single(env, 'bluesky', 'alice.bsky.social', 'oauth')
    expect(answer.code).toBe('temporarily_unavailable')
  })

  it('a cached identity-link verification of the sign-in link still verifies', async () => {
    const { env, store } = makeEnv()
    store.set(cacheKey('bluesky', 'alice.bsky.social', 'oauth', PUBKEY), JSON.stringify({
      verified: true, method: 'identity_link', checked_at: 1, type: 'verified',
    }))
    const answer = await single(env, 'bluesky', 'alice.bsky.social', 'oauth')
    expect(answer.verified).toBe(true)
    expect(answer.method).toBe('identity_link')
    expect(answer.code).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a cached Bluesky outage for the sign-in link stays "try again"', async () => {
    const { env, store } = makeEnv()
    store.set(cacheKey('bluesky', 'alice.bsky.social', 'oauth', PUBKEY), JSON.stringify({
      verified: false, error: "Bluesky couldn't be checked right now.", code: 'temporarily_unavailable', checked_at: 1, type: 'platform_error',
    }))
    const answer = await single(env, 'bluesky', 'alice.bsky.social', 'oauth')
    expect(answer.code).toBe('temporarily_unavailable')
  })

  it('a cached Bluesky failure for the sign-in link answers signin_expired', async () => {
    const { env, store } = makeEnv()
    store.set(cacheKey('bluesky', 'alice.bsky.social', 'oauth', PUBKEY), JSON.stringify({
      verified: false, error: 'Bluesky post not found', checked_at: 1, type: 'failed',
    }))
    const answer = await single(env, 'bluesky', 'alice.bsky.social', 'oauth')
    expect(answer.code).toBe('signin_expired')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a linked account that no longer matches answers signin_account_changed', async () => {
    const { env, store } = makeEnv()
    store.set(oauthVerificationKey('bluesky', 'alice.bsky.social', PUBKEY), JSON.stringify({
      platform: 'bluesky', identity: 'alice.bsky.social', pubkey: PUBKEY, verified: true, method: 'oauth',
      checked_at: 1, confirmed: true, account_id: 'did:plc:old',
    }))
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('com.atproto.identity.resolveHandle')) return json({ did: 'did:plc:new' })
      return new Response('', { status: 404 })
    })
    const answer = await single(env, 'bluesky', 'alice.bsky.social', 'oauth')
    expect(answer.verified).toBe(false)
    expect(answer.code).toBe('signin_account_changed')
    expect(answer.error).toBe('This handle no longer points to the account that signed in, so the link no longer counts.')
  })

  it('a linked account whose handle no longer exists answers signin_account_changed', async () => {
    const { env, store } = makeEnv()
    store.set(oauthVerificationKey('bluesky', 'alice.bsky.social', PUBKEY), JSON.stringify({
      platform: 'bluesky', identity: 'alice.bsky.social', pubkey: PUBKEY, verified: true, method: 'oauth',
      checked_at: 1, confirmed: true, account_id: 'did:plc:old',
    }))
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('com.atproto.identity.resolveHandle')) return json({ error: 'InvalidRequest', message: 'Unable to resolve handle' }, 400)
      return new Response('', { status: 404 })
    })
    const answer = await single(env, 'bluesky', 'alice.bsky.social', 'oauth')
    expect(answer.verified).toBe(false)
    expect(answer.code).toBe('signin_account_changed')
    expect(answer.error).toBe('This handle no longer points to the account that signed in, so the link no longer counts.')
  })
})
