// ABOUTME: A platform that doesn't answer (rate limited, down, unreachable) is
// ABOUTME: reported as "couldn't check right now" and remembered briefly, not as a rejection.
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import type { Bindings } from '../types'
import { hexToNpub } from '../utils/npub'
import { TwitterVerifier } from '../platforms/twitter'

const PUBKEY = 'ab'.repeat(32)
const UNAVAILABLE_TTL = 5 * 60
const FAILED_TTL = 15 * 60

const CLAIMS = {
  twitter: { identity: 'synthetic', proof: '1234567890123456789' },
  github: { identity: 'synthetic-user', proof: 'abc123' },
  bluesky: { identity: 'synthetic.bsky.social', proof: 'abc123rkey' },
  mastodon: { identity: 'mastodon.social/@synthetic', proof: '109876543210' },
  telegram: { identity: 'syntheticchannel', proof: '123' },
  discord: { identity: 'synthetic', proof: '99887766554433221' },
  youtube: { identity: 'UCxxxxxxxxxxxxxxxxxxxxxxxx', proof: 'dQw4w9WgXcQ' },
  tiktok: { identity: 'synthetic', proof: '7123456789012345678' },
} as const

type Platform = keyof typeof CLAIMS
const PLATFORMS = Object.keys(CLAIMS) as Platform[]

function createEnv(rateLimited: string | null = null, extra: Record<string, string> = {}) {
  const store = new Map<string, string>()
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
  }
  const rateLimit = {
    get: vi.fn(async (key: string) => (rateLimited && key.startsWith(rateLimited) ? '1000' : null)),
    put: vi.fn(async () => {}),
  }
  const env = {
    CACHE_KV: kv,
    RATE_LIMIT_KV: rateLimit,
    YOUTUBE_API_KEY: 'synthetic-key',
    DISCORD_BOT_TOKEN: 'synthetic-bot-token',
    DISCORD_VERIFY_CHANNEL_ID: '1234567890123456',
    ...extra,
  } as unknown as Bindings
  return { env, kv }
}

function platformAnswers(status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })))
}

function platformUnreachable() {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
}

async function verify(env: Bindings, platform: string, claim: { identity: string; proof: string }) {
  const response = await worker.fetch(new Request('https://example.com/verify/single', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, ...claim, pubkey: PUBKEY }),
  }), env)
  expect(response.status).toBe(200)
  return response.json() as Promise<Record<string, unknown>>
}

function rememberedFor(kv: { put: ReturnType<typeof vi.fn> }) {
  expect(kv.put).toHaveBeenCalledTimes(1)
  return (kv.put.mock.calls[0][2] as { expirationTtl: number }).expirationTtl
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a platform that does not answer', () => {
  for (const platform of PLATFORMS) {
    describe(platform, () => {
      it.each([429, 503])('answering %i is "couldn\'t check right now", remembered for 5 minutes', async status => {
        const { env, kv } = createEnv()
        platformAnswers(status)
        const body = await verify(env, platform, CLAIMS[platform])
        expect(body).toMatchObject({ verified: false, code: 'temporarily_unavailable', cached: false })
        expect(body.error).toMatch(/couldn't be checked right now/)
        expect(rememberedFor(kv)).toBe(UNAVAILABLE_TTL)
      })

      it('being unreachable is "couldn\'t check right now", remembered for 5 minutes', async () => {
        const { env, kv } = createEnv()
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
        platformUnreachable()
        const body = await verify(env, platform, CLAIMS[platform])
        expect(body).toMatchObject({ verified: false, code: 'temporarily_unavailable', cached: false })
        expect(body.error).toMatch(/couldn't be checked right now/)
        expect(rememberedFor(kv)).toBe(UNAVAILABLE_TTL)
        // An outage, not a possible bug. TODO(#103): Bluesky's handle lookup
        // (src/atproto.ts) fails first here and isn't typed yet; its post
        // lookup is checked below.
        if (platform !== 'bluesky') expect(logError).not.toHaveBeenCalled()
      })

      it('answering 404 is still a rejection, remembered for 15 minutes', async () => {
        const { env, kv } = createEnv()
        platformAnswers(404)
        const body = await verify(env, platform, CLAIMS[platform])
        expect(body.verified).toBe(false)
        expect(body.code).not.toBe('temporarily_unavailable')
        expect(rememberedFor(kv)).toBe(FAILED_TTL)
      })
    })
  }

  describe('which answers count as "didn\'t answer"', () => {
    // 520 to 530 are Cloudflare's "origin down" answers, common for self-hosted servers.
    it.each([408, 425, 429, 500, 502, 503, 504, 520, 522, 530])('%i is "couldn\'t check right now"', async status => {
      const { env, kv } = createEnv()
      platformAnswers(status)
      const body = await verify(env, 'twitter', CLAIMS.twitter)
      expect(body.code).toBe('temporarily_unavailable')
      expect(rememberedFor(kv)).toBe(UNAVAILABLE_TTL)
    })

    // 501 and 505 say "this server doesn't do that": permanent, so trying again won't help.
    it.each([401, 403, 501, 505])('%i is still an answer, remembered for 15 minutes', async status => {
      const { env, kv } = createEnv()
      platformAnswers(status)
      const body = await verify(env, 'twitter', CLAIMS.twitter)
      expect(body.verified).toBe(false)
      expect(body.code).not.toBe('temporarily_unavailable')
      expect(rememberedFor(kv)).toBe(FAILED_TTL)
    })
  })

  it('Bluesky: a post lookup that can\'t be reached is "couldn\'t check right now"', async () => {
    const { env, kv } = createEnv()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The handle lookup answers (no identity-link record), then the post lookup fails.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('getPostThread')) throw new TypeError('fetch failed')
      return new Response(null, { status: 404 })
    }))
    const body = await verify(env, 'bluesky', CLAIMS.bluesky)
    expect(body.code).toBe('temporarily_unavailable')
    expect(rememberedFor(kv)).toBe(UNAVAILABLE_TTL)
    expect(logError).not.toHaveBeenCalled()
  })

  // 401 and 403 are our credential being refused, not a verdict on the gist.
  it.each([401, 403, 408, 425])('GitHub: an API that answers %i falls back to the gist itself', async status => {
    const { env } = createEnv(null, { GITHUB_TOKEN: 'synthetic-token' })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('https://api.github.com/')
      ? new Response(null, { status })
      : new Response(`proof ${hexToNpub(PUBKEY)}`, { status: 200 })))
    const body = await verify(env, 'github', CLAIMS.github)
    expect(body.verified).toBe(true)
  })

  describe('TikTok share links', () => {
    const shareLink = { identity: 'synthetic', proof: 'https://vm.tiktok.com/ZMabc123/' }

    it('a share link that can\'t be followed right now is not called invalid', async () => {
      const { env, kv } = createEnv()
      platformAnswers(503)
      const body = await verify(env, 'tiktok', shareLink)
      expect(body).toMatchObject({ verified: false, code: 'temporarily_unavailable' })
      expect(rememberedFor(kv)).toBe(UNAVAILABLE_TTL)
    })

    it('a share link whose host is unreachable is not called invalid', async () => {
      const { env, kv } = createEnv()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
      platformUnreachable()
      const body = await verify(env, 'tiktok', shareLink)
      expect(body).toMatchObject({ verified: false, code: 'temporarily_unavailable' })
      expect(rememberedFor(kv)).toBe(UNAVAILABLE_TTL)
      expect(logError).not.toHaveBeenCalled()
    })
  })

  it('a remembered answer still says "couldn\'t check right now"', async () => {
    const { env } = createEnv()
    platformAnswers(429)
    await verify(env, 'twitter', CLAIMS.twitter)
    const again = await verify(env, 'twitter', CLAIMS.twitter)
    expect(again).toMatchObject({ verified: false, code: 'temporarily_unavailable', cached: true })
    expect(again.error).toMatch(/couldn't be checked right now/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('what gets logged', () => {
  it('logs a platform that didn\'t answer as a warning', async () => {
    const { env } = createEnv()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    platformAnswers(503)
    await verify(env, 'twitter', CLAIMS.twitter)
    expect(warn).toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('logs a platform that couldn\'t be reached as a warning', async () => {
    const { env } = createEnv()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    platformUnreachable()
    await verify(env, 'twitter', CLAIMS.twitter)
    expect(warn).toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('doesn\'t copy a network failure\'s own message into the logs', async () => {
    const { env } = createEnv()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A fetch error message could carry the request URL, and YouTube's key is in its query.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed: https://www.googleapis.com/?key=synthetic-key') }))
    await verify(env, 'youtube', CLAIMS.youtube)
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-key')
  })

  it('logs anything else a check throws as an error, with the error itself', async () => {
    const { env } = createEnv()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Stands in for a bug in a check, as opposed to a platform outage.
    const bug = new TypeError('synthetic bug')
    vi.spyOn(TwitterVerifier.prototype, 'verify').mockRejectedValue(bug)
    const body = await verify(env, 'twitter', CLAIMS.twitter)
    expect(body.code).toBe('temporarily_unavailable')
    expect(error).toHaveBeenCalledWith(expect.any(String), bug)
  })
})

describe('the verifier\'s own rate limits', () => {
  it.each([
    ['per person', 'rl:pk'],
    ['per platform', 'rl:plat'],
  ])('hitting the %s limit is "couldn\'t check right now", not a rejection', async (_label, prefix) => {
    const { env } = createEnv(prefix)
    platformUnreachable()
    const body = await verify(env, 'twitter', CLAIMS.twitter)
    expect(body).toMatchObject({ verified: false, code: 'temporarily_unavailable', cached: false })
    // TODO(#115): Divine apps built before divine-mobile#9999 recognise a
    // rate-limited answer by this prefix and keep the person's known-good
    // badges; newer builds read `code`. Remove with the text only once those
    // older versions are no longer in use.
    expect(body.error).toMatch(/^Rate limit exceeded/)
    expect(fetch).not.toHaveBeenCalled()
  })
})
