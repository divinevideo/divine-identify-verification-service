import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import { hexToNpub } from '../utils/npub'

const PUBKEY = '9'.repeat(64)
const TWEET = '1234567890'

function createMockKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string, type?: string) => {
      const value = store.get(key) ?? null
      return value !== null && type === 'json' ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
  } as unknown as KVNamespace
}

// Twitter's oEmbed answer for a post by the given author containing the given text.
function tweetBy(author: string, text: string) {
  return new Response(JSON.stringify({
    author_url: `https://twitter.com/${author}`,
    html: `<blockquote><p>${text}</p></blockquote>`,
  }), { status: 200 })
}

async function single(env: unknown, identity: string, proof: string, platform = 'twitter') {
  const response = await worker.fetch(new Request('https://verifier.divine.video/verify/single', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, identity, proof, pubkey: PUBKEY }),
  }), env as never)
  return await response.json() as Record<string, unknown>
}

describe('claims pasted in other shapes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('verifies a handle with @ and a full post link, and returns the clean values', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    vi.stubGlobal('fetch', vi.fn(async () => tweetBy('alice', hexToNpub(PUBKEY))))
    const body = await single(env, '@alice', `https://x.com/alice/status/${TWEET}?s=20`)
    expect(body).toMatchObject({
      identity: '@alice',
      verified: true,
      canonical_identity: 'alice',
      canonical_proof: TWEET,
    })
  })

  it('verifies a Mastodon handle typed as @user@server, and returns the account as instance/@user', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({
      account: { acct: 'alice', username: 'alice' },
      content: `<p>${hexToNpub(PUBKEY)}</p>`,
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const body = await single(env, '@alice@mastodon.social', 'https://mastodon.social/@alice/109876543210', 'mastodon')
    expect(body).toMatchObject({
      identity: '@alice@mastodon.social',
      verified: true,
      canonical_identity: 'mastodon.social/@alice',
      canonical_proof: '109876543210',
    })
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://mastodon.social/api/v1/statuses/109876543210')
  })

  it('checks the tidy form with the platform', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    const fetchMock = vi.fn(async (_url: string) => tweetBy('alice', hexToNpub(PUBKEY)))
    vi.stubGlobal('fetch', fetchMock)
    await single(env, '@alice', `https://x.com/alice/status/${TWEET}`)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://x.com/alice/status/${TWEET}`)}&omit_script=true`,
    )
  })

  it('shares one cache entry between the pasted and the clean form', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    vi.stubGlobal('fetch', vi.fn(async () => tweetBy('alice', hexToNpub(PUBKEY))))
    await single(env, 'alice', TWEET)
    const again = await single(env, '@alice', `https://twitter.com/alice/status/${TWEET}`)
    expect(again).toMatchObject({ identity: '@alice', verified: true, cached: true, canonical_identity: 'alice', canonical_proof: TWEET })
  })

  it('returns no clean values when the claim was already clean', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    vi.stubGlobal('fetch', vi.fn(async () => tweetBy('alice', hexToNpub(PUBKEY))))
    const body = await single(env, 'alice', TWEET)
    expect(body.verified).toBe(true)
    expect(body).not.toHaveProperty('canonical_identity')
    expect(body).not.toHaveProperty('canonical_proof')
  })

  it('returns no clean values for a clean claim answered from an entry a pasted claim wrote', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    vi.stubGlobal('fetch', vi.fn(async () => tweetBy('alice', hexToNpub(PUBKEY))))
    await single(env, '@alice', `https://x.com/alice/status/${TWEET}`)
    const body = await single(env, 'alice', TWEET)
    expect(body).toMatchObject({ verified: true, cached: true })
    expect(body).not.toHaveProperty('canonical_identity')
    expect(body).not.toHaveProperty('canonical_proof')
  })

  it('returns no clean values when the check fails', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    vi.stubGlobal('fetch', vi.fn(async () => tweetBy('alice', 'no key here')))
    const body = await single(env, '@alice', `https://x.com/alice/status/${TWEET}`)
    expect(body).toMatchObject({ identity: '@alice', verified: false })
    expect(body).not.toHaveProperty('canonical_identity')
    expect(body).not.toHaveProperty('canonical_proof')
  })

  it('finds a sign-in record stored under the handle when the claim has an @', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await env.CACHE_KV.put(`oauth_verified:twitter:alice:${PUBKEY}`, JSON.stringify({
      platform: 'twitter', identity: 'alice', pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: Math.floor(Date.now() / 1000),
    }))
    const body = await single(env, '@alice', TWEET)
    expect(body).toMatchObject({ identity: '@alice', verified: true, method: 'oauth', canonical_identity: 'alice' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns both clean values for a sign-in claim that carries a pasted post link', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await env.CACHE_KV.put(`oauth_verified:twitter:alice:${PUBKEY}`, JSON.stringify({
      platform: 'twitter', identity: 'alice', pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: Math.floor(Date.now() / 1000),
    }))
    const body = await single(env, '@alice', `https://x.com/alice/status/${TWEET}`)
    expect(body).toMatchObject({
      identity: '@alice', verified: true, method: 'oauth', canonical_identity: 'alice', canonical_proof: TWEET,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('checks a Bluesky sign-in against the handle without its @', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    const did = 'did:plc:alice123example'
    // Bluesky resolves the handle itself; a handle with an @ doesn't resolve.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const handle = new URL(url).searchParams.get('handle')
      return handle === 'alice.bsky.social'
        ? new Response(JSON.stringify({ did }), { status: 200 })
        : new Response(JSON.stringify({ error: 'InvalidRequest' }), { status: 400 })
    }))
    await env.CACHE_KV.put(`oauth_verified:bluesky:alice.bsky.social:${PUBKEY}`, JSON.stringify({
      platform: 'bluesky', identity: 'alice.bsky.social', pubkey: PUBKEY, verified: true, method: 'oauth',
      checked_at: Math.floor(Date.now() / 1000), account_id: did, handle: 'alice.bsky.social',
    }))
    const body = await single(env, '@alice.bsky.social', '', 'bluesky')
    expect(body).toMatchObject({
      identity: '@alice.bsky.social', verified: true, method: 'oauth', canonical_identity: 'alice.bsky.social',
    })
  })

  it('returns no clean values for a failed answer served from the cache', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    vi.stubGlobal('fetch', vi.fn(async () => tweetBy('alice', 'no key here')))
    await single(env, '@alice', `https://x.com/alice/status/${TWEET}`)
    const body = await single(env, '@alice', `https://x.com/alice/status/${TWEET}`)
    expect(body).toMatchObject({ identity: '@alice', verified: false, cached: true })
    expect(body).not.toHaveProperty('canonical_identity')
    expect(body).not.toHaveProperty('canonical_proof')
  })
})
