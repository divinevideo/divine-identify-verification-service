// ABOUTME: A platform that takes a request and then goes quiet, before its answer starts or partway
// ABOUTME: through it, is "couldn't check right now" once the time limit passes, not a rejection.
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import type { Bindings } from '../types'

const PUBKEY = 'ab'.repeat(32)
const UNAVAILABLE_TTL = 5 * 60

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

function createEnv(extra: Record<string, string> = {}) {
  const store = new Map<string, string>()
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
  }
  const env = {
    CACHE_KV: kv,
    RATE_LIMIT_KV: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
    YOUTUBE_API_KEY: 'synthetic-key',
    DISCORD_BOT_TOKEN: 'synthetic-bot-token',
    DISCORD_VERIFY_CHANNEL_ID: '1234567890123456',
    ...extra,
  } as unknown as Bindings
  return { env, kv }
}

// The clock for the time limit on a platform request. Real waiting would make
// these tests slow, so a request's limit passes only when the test says so, and
// a request made after that is already past its limit.
function timeLimit() {
  const live: AbortController[] = []
  let passed = false
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController()
    if (passed) controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    else live.push(controller)
    return controller.signal
  })
  return {
    pass() {
      passed = true
      for (const controller of live) controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    },
  }
}

// Fails the way a real request does when its signal aborts, including a signal that already has.
function whenAborted(signal: AbortSignal | null | undefined, fail: (reason: unknown) => void) {
  if (!signal) return
  if (signal.aborted) fail(signal.reason)
  else signal.addEventListener('abort', () => fail(signal.reason), { once: true })
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

function stubFetch(handler: Fetch) {
  const fetchStub = vi.fn(handler)
  vi.stubGlobal('fetch', fetchStub)
  return fetchStub
}

// The platform accepts the request and never starts to answer.
const neverAnswers: Fetch = (_url, init) => new Promise((_resolve, reject) => whenAborted(init?.signal, reject))

// The platform starts a 200 answer and then stops sending it.
const stopsMidAnswer: Fetch = async (_url, init) => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('{"'))
    whenAborted(init?.signal, (reason) => controller.error(reason))
  },
}), { status: 200 })

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

// Starts a check, waits until its first request is out, lets the limit pass, and returns the answer.
async function checkUntilLimit(env: Bindings, platform: Platform, handler: Fetch, clock = timeLimit()) {
  const fetchStub = stubFetch(handler)
  const answer = verify(env, platform, CLAIMS[platform])
  await vi.waitFor(() => expect(fetchStub).toHaveBeenCalled())
  clock.pass()
  return answer
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a platform that goes quiet', () => {
  for (const platform of PLATFORMS) {
    describe(platform, () => {
      it.each([
        ['never starts to answer', neverAnswers],
        ['stops partway through its answer', stopsMidAnswer],
      ] as const)('that %s is "couldn\'t check right now", remembered for 5 minutes', async (_when, handler) => {
        const { env, kv } = createEnv()
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const logError = vi.spyOn(console, 'error').mockImplementation(() => {})

        const body = await checkUntilLimit(env, platform, handler)

        expect(body).toMatchObject({ verified: false, code: 'temporarily_unavailable', cached: false })
        expect(body.error).toMatch(/couldn't be checked right now/)
        expect(rememberedFor(kv)).toBe(UNAVAILABLE_TTL)
        // An outage, not a possible bug.
        expect(logError).not.toHaveBeenCalled()
      })
    })
  }

  it('does not hold up the other claims in a batch', async () => {
    const { env } = createEnv()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clock = timeLimit()
    const fetchStub = stubFetch((url, init) => (url.includes('publish.twitter.com') ? neverAnswers(url, init) : Promise.resolve(new Response(null, { status: 404 }))))

    const batch = worker.fetch(new Request('https://example.com/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claims: [
          { platform: 'twitter', ...CLAIMS.twitter, pubkey: PUBKEY },
          { platform: 'telegram', ...CLAIMS.telegram, pubkey: PUBKEY },
        ],
      }),
    }), env)
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2))
    clock.pass()

    const { results } = await (await batch).json() as { results: Array<Record<string, unknown>> }
    expect(results[0]).toMatchObject({ platform: 'twitter', code: 'temporarily_unavailable' })
    expect(results[1]).toMatchObject({ platform: 'telegram', verified: false, error: 'Telegram message not found' })
  })

  describe('github with a token', () => {
    // The gist API is asked first and the public copy second, so an API that
    // goes quiet is the API not answering: the check carries on with the copy.
    it.each([
      ['never starts to answer', neverAnswers],
      ['stops partway through its answer', stopsMidAnswer],
    ] as const)('an API that %s is passed over for the public copy', async (_when, apiHandler) => {
      const { env } = createEnv({ GITHUB_TOKEN: 'synthetic-token' })
      const clock = timeLimit()
      const fetchStub = stubFetch((url, init) => (
        url.startsWith('https://api.github.com/') ? apiHandler(url, init) : Promise.resolve(new Response(null, { status: 404 }))
      ))

      const answer = verify(env, 'github', CLAIMS.github)
      await vi.waitFor(() => expect(fetchStub).toHaveBeenCalled())
      clock.pass()
      const body = await answer

      expect(body.code).not.toBe('temporarily_unavailable')
      expect(body.error).toMatch(/Gist not found/)
      expect(fetchStub.mock.calls.map(([url]) => new URL(url).hostname)).toEqual(['api.github.com', 'gist.githubusercontent.com'])
    })
  })
})
