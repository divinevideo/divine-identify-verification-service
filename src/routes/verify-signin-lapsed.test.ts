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
const ACCOUNTS = [['twitter', 'jack'], ['youtube', '@somechannel'], ['tiktok', 'someone']] as const

function confirmedRecord(store: Map<string, string>, platform: string, identity: string, ageDays = 0) {
  store.set(oauthVerificationKey(platform as 'twitter', identity, PUBKEY), JSON.stringify({
    platform, identity, pubkey: PUBKEY, verified: true, method: 'oauth',
    checked_at: Math.floor(Date.now() / 1000) - ageDays * 24 * 60 * 60, confirmed: true,
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
      // Saved just now, so only the unconfirmed rule can end it: a stale checked_at
      // would let the age check pass this test without the rule.
      store.set(oauthVerificationKey(platform as 'twitter', identity, PUBKEY), JSON.stringify({
        platform, identity, pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: Math.floor(Date.now() / 1000),
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

    it('youtube: a handle sent without its @ counts the confirmed record saved by @handle', async () => {
      const { env, store } = makeEnv()
      confirmedRecord(store, 'youtube', '@somechannel')
      const answer = await check(env, 'youtube', 'somechannel', 'oauth')
      expect(answer.verified).toBe(true)
      expect(answer.method).toBe('oauth')
    })

    it.each(ACCOUNTS)('%s: a confirmed record on a platform whose links are switched off gives signin_expired without asking the platform', async (platform, identity) => {
      const { env, store } = makeEnv({ SIGNIN_LINKS_OFF: platform })
      confirmedRecord(store, platform, identity)
      const answer = await check(env, platform, identity, 'oauth')
      expect(answer.verified).toBe(false)
      expect(answer.code).toBe('signin_expired')
      expect(answer.error).toBe('No current sign-in verifies this account.')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each(ACCOUNTS)('%s: a confirmed record past its lifetime gives signin_expired without asking the platform', async (platform, identity) => {
      const { env, store } = makeEnv()
      confirmedRecord(store, platform, identity, 31)
      const answer = await check(env, platform, identity, 'oauth')
      expect(answer.verified).toBe(false)
      expect(answer.code).toBe('signin_expired')
      expect(fetchMock).not.toHaveBeenCalled()
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

  it('an identity-link record still verifies a Bluesky link while Bluesky sign-in links are switched off', async () => {
    blueskyFetch([{
      uri: `at://${DID}/video.divine.identity.link/nostr-npub`,
      value: { $type: 'video.divine.identity.link', version: 1, target: { protocol: 'nostr', id: NPUB } },
    }])
    const { env, store } = makeEnv({ SIGNIN_LINKS_OFF: 'bluesky' })
    confirmedRecord(store, 'bluesky', 'alice.bsky.social')
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
      checked_at: Math.floor(Date.now() / 1000), confirmed: true, account_id: 'did:plc:old',
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
      checked_at: Math.floor(Date.now() / 1000), confirmed: true, account_id: 'did:plc:old',
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

  it('a lapsed sign-in link no longer fetches a post named oauth', async () => {
    blueskyFetch([])
    const { env } = makeEnv()
    const answer = await single(env, 'bluesky', 'alice.bsky.social', 'oauth')
    expect(answer.code).toBe('signin_expired')
    expect(fetchMock.mock.calls.map(([input]) => String(input)).some(u => u.includes('app.bsky.feed.getPostThread'))).toBe(false)
  })

  describe('a signed-in handle that now points to another account', () => {
    const OLD_DID = 'did:plc:oldaccountaaaaaaaaaaaaaa'
    const PROOF = '3lbcdefghijk2'
    const CHANGED = 'This handle no longer points to the account that signed in, so the link no longer counts.'
    const LINK_RECORD = {
      uri: `at://${DID}/video.divine.identity.link/nostr-npub`,
      value: { $type: 'video.divine.identity.link', version: 1, target: { protocol: 'nostr', id: NPUB } },
    }
    const postBy = (text: string) => json({ thread: { post: { author: { handle: 'alice.bsky.social', did: DID }, record: { text } } } })

    // A sign-in record saved for an account the handle no longer points to: the
    // handle resolves to DID, not OLD_DID.
    function movedRecord(store: Map<string, string>) {
      store.set(oauthVerificationKey('bluesky', 'alice.bsky.social', PUBKEY), JSON.stringify({
        platform: 'bluesky', identity: 'alice.bsky.social', pubkey: PUBKEY, verified: true, method: 'oauth',
        checked_at: Math.floor(Date.now() / 1000), confirmed: true, account_id: OLD_DID,
      }))
    }

    function movedFetch(records: unknown[] | 'throw', post?: () => Response) {
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('https://bsky.social/xrpc/com.atproto.identity.resolveHandle')) return json({ did: DID })
        if (url === `https://plc.directory/${DID}`) return json({ service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] })
        if (url.startsWith(`${PDS}/xrpc/com.atproto.repo.listRecords`)) {
          if (records === 'throw') throw new TypeError('network down')
          return json({ records })
        }
        if (url.startsWith('https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread') && post) return post()
        return new Response('', { status: 404 })
      })
    }

    const urls = () => fetchMock.mock.calls.map(([input]) => String(input))
    const fetchedPost = () => urls().some(u => u.includes('app.bsky.feed.getPostThread'))

    describe.each(ROUTES)('%s', (_route, check) => {
      it('a moved handle verifies by a proof post on the account it points to now', async () => {
        movedFetch([], () => postBy(`proof ${NPUB}`))
        const { env, store } = makeEnv()
        movedRecord(store)
        const answer = await check(env, 'bluesky', 'alice.bsky.social', PROOF)
        expect(answer).toMatchObject({ verified: true, method: 'proof_post' })
        expect(answer.code).toBeUndefined()
      })

      it('a moved handle verifies by the identity-link record on the account it points to now', async () => {
        movedFetch([LINK_RECORD])
        const { env, store } = makeEnv()
        movedRecord(store)
        const answer = await check(env, 'bluesky', 'alice.bsky.social', 'oauth')
        expect(answer).toMatchObject({ verified: true, method: 'identity_link' })
        expect(urls().some(u => u.startsWith(`${PDS}/xrpc/com.atproto.repo.listRecords`) && u.includes(encodeURIComponent(DID)))).toBe(true)
        expect(fetchedPost()).toBe(false)
      })

      it('a moved sign-in link without an identity-link record answers signin_account_changed and fetches no post', async () => {
        movedFetch([], () => postBy(`proof ${NPUB}`))
        const { env, store } = makeEnv()
        movedRecord(store)
        const answer = await check(env, 'bluesky', 'alice.bsky.social', 'oauth')
        expect(answer).toMatchObject({ verified: false, code: 'signin_account_changed', error: CHANGED })
        expect(fetchedPost()).toBe(false)
      })

      it('a moved handle whose proof post does not verify answers signin_account_changed', async () => {
        movedFetch([], () => postBy('a post without the npub'))
        const { env, store } = makeEnv()
        movedRecord(store)
        const answer = await check(env, 'bluesky', 'alice.bsky.social', PROOF)
        expect(answer).toMatchObject({ verified: false, code: 'signin_account_changed', error: CHANGED })
        expect(fetchedPost()).toBe(true)
      })
    })

    // A sign-in whose handle still points to its account, but the account's host says it is not active.
    describe('an inactive account', () => {
      const INACTIVE = 'The account that signed in is no longer active on Bluesky, so the link no longer counts.'

      function inactiveRecord(store: Map<string, string>) {
        store.set(oauthVerificationKey('bluesky', 'alice.bsky.social', PUBKEY), JSON.stringify({
          platform: 'bluesky', identity: 'alice.bsky.social', pubkey: PUBKEY, verified: true, method: 'oauth',
          checked_at: Math.floor(Date.now() / 1000), confirmed: true, account_id: DID,
        }))
      }

      // The handle resolves to the signed-in account, whose PDS reports it deactivated
      // yet would still serve an identity-link record and a proof post.
      function inactiveFetch() {
        fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
          const url = String(input)
          if (url.startsWith('https://bsky.social/xrpc/com.atproto.identity.resolveHandle')) return json({ did: DID })
          if (url === `https://plc.directory/${DID}`) return json({ id: DID, service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] })
          if (url.startsWith(`${PDS}/xrpc/com.atproto.sync.getRepoStatus`)) return json({ did: DID, active: false, status: 'deactivated' })
          if (url.startsWith(`${PDS}/xrpc/com.atproto.repo.listRecords`)) return json({ records: [LINK_RECORD] })
          if (url.startsWith('https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread')) return postBy(`proof ${NPUB}`)
          return new Response('', { status: 404 })
        })
      }

      describe.each(ROUTES)('%s', (_route, check) => {
        it('answers signin_account_changed without checking a proof post or identity-link record', async () => {
          inactiveFetch()
          const { env, store } = makeEnv()
          inactiveRecord(store)
          const rateLimit = new Map<string, string>()
          env.RATE_LIMIT_KV = {
            get: async (key: string) => rateLimit.get(key) ?? null,
            put: async (key: string, value: string) => { rateLimit.set(key, value) },
            delete: async (key: string) => { rateLimit.delete(key) },
            list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
          } as unknown as KVNamespace
          const answer = await check(env, 'bluesky', 'alice.bsky.social', 'oauth')
          expect(answer).toMatchObject({ verified: false, code: 'signin_account_changed', error: INACTIVE })
          expect(urls().some(u => u.includes('com.atproto.repo.listRecords'))).toBe(false)
          expect(fetchedPost()).toBe(false)
          // No per-person or per-platform unit is reserved; only the address-level limit may write.
          expect([...rateLimit.keys()].filter(k => k.includes(PUBKEY))).toEqual([])
        })
      })

      it('answers signin_account_changed even when a verification is cached under the claim', async () => {
        inactiveFetch()
        const { env, store } = makeEnv()
        inactiveRecord(store)
        store.set(cacheKey('bluesky', 'alice.bsky.social', PROOF, PUBKEY), JSON.stringify({
          verified: true, method: 'proof_post', checked_at: 1, type: 'verified',
        }))
        const answer = await single(env, 'bluesky', 'alice.bsky.social', PROOF)
        expect(answer).toMatchObject({ verified: false, code: 'signin_account_changed', error: INACTIVE })
        expect(fetchedPost()).toBe(false)
      })
    })

    it('a moved handle is looked up once: the check uses the account the lookup found', async () => {
      movedFetch([LINK_RECORD])
      const { env, store } = makeEnv()
      movedRecord(store)
      const answer = await single(env, 'bluesky', 'alice.bsky.social', 'oauth')
      expect(answer).toMatchObject({ verified: true, method: 'identity_link' })
      expect(urls().filter(u => u.includes('com.atproto.identity.resolveHandle'))).toHaveLength(1)
    })

    // Divine's apps stop waiting at 10 seconds and keep no answer for any claim
    // in the call, so the check after a mismatch gets only what is left of the
    // batch's 8 seconds (src/platforms/base.ts).
    describe('the time a batch waits', () => {
      afterEach(() => { vi.useRealTimers() })

      // The handle lookup answers after `ms`; every host the check after it asks never answers.
      function slowLookup(ms: number) {
        fetchMock.mockImplementation((input: RequestInfo | URL) => {
          if (String(input).startsWith('https://bsky.social/xrpc/com.atproto.identity.resolveHandle')) {
            return new Promise<Response>(resolve => setTimeout(() => resolve(json({ did: DID })), ms))
          }
          return new Promise<Response>(() => {})
        })
      }

      function separateRateLimits(env: Bindings) {
        const rateLimit = new Map<string, string>()
        env.RATE_LIMIT_KV = {
          get: async (key: string) => rateLimit.get(key) ?? null,
          put: async (key: string, value: string) => { rateLimit.set(key, value) },
          delete: async (key: string) => { rateLimit.delete(key) },
          list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
        } as unknown as KVNamespace
        return () => [...rateLimit.keys()].filter(k => k.includes(PUBKEY))
      }

      it('a slow handle lookup and a host that never answers still answer within the 8 seconds', async () => {
        vi.useFakeTimers()
        slowLookup(2_800)
        const { env, store } = makeEnv()
        movedRecord(store)
        let settled = false
        const answer = batch(env, 'bluesky', 'alice.bsky.social', PROOF).finally(() => { settled = true })
        await vi.advanceTimersByTimeAsync(8_000)
        expect(settled).toBe(true)
        expect(await answer).toMatchObject({ verified: false, code: 'signin_account_changed', error: CHANGED })
      })

      it('with under a second of the batch left, answers signin_account_changed at once, without a unit or a check', async () => {
        vi.useFakeTimers()
        // The slow lookup stands in for whatever used the time before it (a
        // Confirmation check, the handle lookup, the account status lookup).
        slowLookup(7_200)
        const { env, store } = makeEnv()
        movedRecord(store)
        const spent = separateRateLimits(env)
        let settled = false
        const answer = batch(env, 'bluesky', 'alice.bsky.social', PROOF).finally(() => { settled = true })
        await vi.advanceTimersByTimeAsync(7_200)
        expect(settled).toBe(true)
        expect(await answer).toMatchObject({ verified: false, code: 'signin_account_changed', error: CHANGED })
        expect(spent()).toEqual([])
        expect(urls().some(u => u === `https://plc.directory/${DID}` || u.includes('com.atproto.repo.listRecords') || u.includes('getPostThread'))).toBe(false)
      })

      it('re-checks the time left after waiting for the reservations before it, and spends no unit with under a second left', async () => {
        vi.useFakeTimers()
        fetchMock.mockImplementation((input: RequestInfo | URL) => {
          if (String(input).startsWith('https://bsky.social/xrpc/com.atproto.identity.resolveHandle')) {
            return new Promise<Response>(resolve => setTimeout(() => resolve(json({ did: DID })), 100))
          }
          return new Promise<Response>(() => {})
        })
        const { env, store } = makeEnv()
        movedRecord(store)
        // The batch's own reservation (for the GitHub claim beside it) takes 7.5 s
        // to write, and the moved handle's reservation waits for it.
        const rateLimit = new Map<string, string>()
        const checkUnitWrites: string[] = []
        env.RATE_LIMIT_KV = {
          get: async (key: string) => rateLimit.get(key) ?? null,
          put: async (key: string, value: string) => {
            if (/^rl:(ipchk|pk|plat):/.test(key)) {
              checkUnitWrites.push(key)
              await new Promise(resolve => setTimeout(resolve, 7_500))
            }
            rateLimit.set(key, value)
          },
          delete: async (key: string) => { rateLimit.delete(key) },
          list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
        } as unknown as KVNamespace
        const res = worker.fetch(new Request('https://verifier.divine.video/verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claims: [
            { platform: 'bluesky', identity: 'alice.bsky.social', proof: PROOF, pubkey: PUBKEY },
            { platform: 'github', identity: 'alice', proof: 'abcdef0123456789abcdef0123456789', pubkey: PUBKEY },
          ] }),
        }), env)
        await vi.advanceTimersByTimeAsync(16_000)
        const { results } = await (await res).json() as { results: Answer[] }
        expect(results[0]).toMatchObject({ verified: false, code: 'signin_account_changed', error: CHANGED })
        expect(checkUnitWrites.filter(k => k.startsWith('rl:plat:bluesky:'))).toEqual([])
        expect(urls().some(u => u === `https://plc.directory/${DID}` || u.includes('com.atproto.repo.listRecords'))).toBe(false)
      })
    })

    it('an outage on the proof check after a mismatch answers signin_account_changed', async () => {
      movedFetch('throw', () => new Response('', { status: 503 }))
      const { env, store } = makeEnv()
      movedRecord(store)
      const answer = await single(env, 'bluesky', 'alice.bsky.social', PROOF)
      expect(answer).toMatchObject({ verified: false, code: 'signin_account_changed', error: CHANGED })
      expect(JSON.parse(store.get(cacheKey('bluesky', 'alice.bsky.social', PROOF, PUBKEY))!).type).toBe('platform_error')
    })

    it('a cached proof-post verification still verifies after a mismatch, without asking Bluesky again', async () => {
      movedFetch([], () => postBy(`proof ${NPUB}`))
      const { env, store } = makeEnv()
      movedRecord(store)
      store.set(cacheKey('bluesky', 'alice.bsky.social', PROOF, PUBKEY), JSON.stringify({
        verified: true, method: 'proof_post', checked_at: 1, type: 'verified',
      }))
      const answer = await single(env, 'bluesky', 'alice.bsky.social', PROOF)
      expect(answer).toMatchObject({ verified: true, method: 'proof_post', cached: true })
      expect(fetchedPost()).toBe(false)
      expect(urls().some(u => u.includes('com.atproto.repo.listRecords'))).toBe(false)
    })

    it('a cached failure after a mismatch answers signin_account_changed, not the cached error', async () => {
      movedFetch([], () => postBy(`proof ${NPUB}`))
      const { env, store } = makeEnv()
      movedRecord(store)
      store.set(cacheKey('bluesky', 'alice.bsky.social', PROOF, PUBKEY), JSON.stringify({
        verified: false, error: 'npub not found in Bluesky post', checked_at: 1, type: 'failed',
      }))
      const answer = await single(env, 'bluesky', 'alice.bsky.social', PROOF)
      expect(answer).toMatchObject({ verified: false, code: 'signin_account_changed', error: CHANGED })
      expect(fetchedPost()).toBe(false)
    })
  })
})
