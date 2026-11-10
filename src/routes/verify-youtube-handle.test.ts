// ABOUTME: Route-level checks of YouTube proof posts that name the channel by @handle,
// ABOUTME: including how the handle lookup and the check's own result are remembered.
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import type { Bindings } from '../types'
import { hexToNpub } from '../utils/npub'

const PUBKEY = 'ab'.repeat(32)
const NPUB = hexToNpub(PUBKEY)
const CHANNEL_A = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const CHANNEL_B = 'UCbbbbbbbbbbbbbbbbbbbbbb'
const VIDEO = 'dQw4w9WgXcQ'
const MISMATCH = 'Video channel does not match claimed identity'
const FAILED_TTL = 15 * 60
const UNAVAILABLE_TTL = 5 * 60

function createEnv() {
  const store = new Map<string, string>()
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
  }
  const rateLimit = {
    get: vi.fn(async () => null),
    put: vi.fn(async () => {}),
  }
  const env = {
    CACHE_KV: kv,
    RATE_LIMIT_KV: rateLimit,
    YOUTUBE_API_KEY: 'synthetic-key',
  } as unknown as Bindings
  return { env, kv, store }
}

// The video is on CHANNEL_A and carries the npub; the channels endpoint answers per handle.
function stubYouTube(channels: (url: string) => Response) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/youtube/v3/channels')) return channels(url)
    return new Response(JSON.stringify({
      items: [{ snippet: { channelId: CHANNEL_A, description: `Verify: ${NPUB}`, channelTitle: 'Test Channel' } }],
    }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const answerWith = (channelId: string) => () =>
  new Response(JSON.stringify({ items: [{ id: channelId }] }), { status: 200 })

async function verify(env: Bindings, identity: string) {
  const response = await worker.fetch(new Request('https://example.com/verify/single', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'youtube', identity, proof: VIDEO, pubkey: PUBKEY }),
  }), env)
  expect(response.status).toBe(200)
  return response.json() as Promise<Record<string, unknown>>
}

const resultPuts = (kv: { put: ReturnType<typeof vi.fn> }) =>
  kv.put.mock.calls.filter(call => String(call[0]).startsWith('v|youtube|'))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('YouTube handle claims', () => {
  it.each(['@bob', 'https://www.youtube.com/@bob'])(
    'refuses a handle that resolves to another channel, and remembers that as a failed check: %s',
    async identity => {
      const { env, kv } = createEnv()
      const fetchMock = stubYouTube(answerWith(CHANNEL_B))
      const first = await verify(env, identity)
      expect(first).toMatchObject({ verified: false, error: MISMATCH, cached: false })
      const puts = resultPuts(kv)
      expect(puts).toHaveLength(1)
      expect((puts[0][2] as { expirationTtl: number }).expirationTtl).toBe(FAILED_TTL)

      fetchMock.mockClear()
      const second = await verify(env, identity)
      expect(second).toMatchObject({ verified: false, cached: true })
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('verifies a handle that resolves to the video\'s channel, fresh and from the cache', async () => {
    const { env } = createEnv()
    stubYouTube(answerWith(CHANNEL_A))
    const bare = await verify(env, '@alice')
    expect(bare).toMatchObject({ verified: true })
    expect(bare).not.toHaveProperty('canonical_identity')

    const link = await verify(env, 'https://www.youtube.com/@alice')
    expect(link).toMatchObject({ verified: true, canonical_identity: '@alice' })

    const again = await verify(env, '@alice')
    expect(again).toMatchObject({ cached: true, verified: true })
  })

  it('remembers the handle lookup in the shared cache', async () => {
    const { env, store } = createEnv()
    stubYouTube(answerWith(CHANNEL_A))
    await verify(env, '@alice')
    expect(store.get('yt_handle_channel:alice')).toBe(CHANNEL_A)
  })

  it('answers couldn\'t check when the handle lookup fails', async () => {
    const { env, kv, store } = createEnv()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubYouTube(() => new Response(null, { status: 503 }))
    const body = await verify(env, '@alice')
    expect(body).toMatchObject({ verified: false, code: 'temporarily_unavailable' })
    const puts = resultPuts(kv)
    expect(puts).toHaveLength(1)
    expect((puts[0][2] as { expirationTtl: number }).expirationTtl).toBe(UNAVAILABLE_TTL)
    expect([...store.keys()].some(key => key.startsWith('yt_handle_channel:'))).toBe(false)
  })

  it.each(['https://www.youtube.com/c/alice', 'https://www.youtube.com/user/alice'])(
    'refuses legacy channel links without asking YouTube: %s',
    async identity => {
      const { env } = createEnv()
      const fetchMock = stubYouTube(answerWith(CHANNEL_A))
      const body = await verify(env, identity)
      expect(body).toMatchObject({ verified: false })
      expect(body.error).toMatch(/Invalid YouTube channel/)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('checks handle claims the same way in a batch', async () => {
    const { env } = createEnv()
    stubYouTube(url => {
      if (url.includes('forHandle=%40bob')) return answerWith(CHANNEL_B)()
      if (url.includes('forHandle=%40alice')) return answerWith(CHANNEL_A)()
      return new Response(null, { status: 404 })
    })
    const response = await worker.fetch(new Request('https://example.com/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claims: [
          { platform: 'youtube', identity: '@bob', proof: VIDEO, pubkey: PUBKEY },
          { platform: 'youtube', identity: '@alice', proof: VIDEO, pubkey: PUBKEY },
        ],
      }),
    }), env)
    expect(response.status).toBe(200)
    const body = await response.json() as { results: Array<Record<string, unknown>> }
    expect(body.results[0]).toMatchObject({ verified: false, error: MISMATCH })
    expect(body.results[1]).toMatchObject({ verified: true })
  })
})
