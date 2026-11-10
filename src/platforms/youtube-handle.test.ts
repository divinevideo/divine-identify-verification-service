import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lookUpYouTubeHandle } from './youtube-handle'

const CHANNEL_A = 'UCaaaaaaaaaaaaaaaaaaaaaa'

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
  }
}

const json = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

describe('lookUpYouTubeHandle', () => {
  let kv: ReturnType<typeof fakeKv>
  let fetchMock: ReturnType<typeof vi.fn>
  let ENV: { CACHE_KV: KVNamespace; YOUTUBE_API_KEY: string }

  beforeEach(() => {
    kv = fakeKv()
    ENV = { CACHE_KV: kv as unknown as KVNamespace, YOUTUBE_API_KEY: 'synthetic-key' }
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns the channel a handle belongs to and remembers it for a day', async () => {
    fetchMock.mockResolvedValue(json({ items: [{ id: CHANNEL_A }] }))
    expect(await lookUpYouTubeHandle(ENV, '@alice')).toEqual({ channelId: CHANNEL_A })
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /^https:\/\/www\.googleapis\.com\/youtube\/v3\/channels\?part=id&forHandle=%40alice&key=synthetic-key/,
    )
    expect(kv.put).toHaveBeenCalledWith('yt_handle_channel:alice', CHANNEL_A, { expirationTtl: 86400 })
  })

  it('sends a handle given without @ with one', async () => {
    fetchMock.mockResolvedValue(json({ items: [{ id: CHANNEL_A }] }))
    await lookUpYouTubeHandle(ENV, 'alice')
    expect(String(fetchMock.mock.calls[0][0])).toContain('forHandle=%40alice')
  })

  it.each([{ items: [] }, { kind: 'youtube#channelListResponse' }])(
    'answers not found for an empty list and remembers that for five minutes (%j)',
    async (body) => {
      fetchMock.mockResolvedValue(json(body))
      expect(await lookUpYouTubeHandle(ENV, '@alice')).toEqual({ notFound: true })
      expect(kv.put).toHaveBeenCalledWith('yt_handle_channel:alice', 'not-found', { expirationTtl: 300 })
    },
  )

  it('shares one remembered answer across letter case', async () => {
    fetchMock.mockResolvedValue(json({ items: [{ id: CHANNEL_A }] }))
    await lookUpYouTubeHandle(ENV, '@Alice')
    expect(await lookUpYouTubeHandle(ENV, '@alice')).toEqual({ channelId: CHANNEL_A })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps handles that differ beyond ASCII case in separate remembered answers', async () => {
    fetchMock.mockImplementation(async () => json({ items: [{ id: CHANNEL_A }] }))
    await lookUpYouTubeHandle(ENV, '@\u212Aate') // KELVIN SIGN, not the letter K
    await lookUpYouTubeHandle(ENV, '@kate')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('answers from the cache without asking YouTube', async () => {
    kv.store.set('yt_handle_channel:alice', CHANNEL_A)
    expect(await lookUpYouTubeHandle(ENV, '@alice')).toEqual({ channelId: CHANNEL_A })
    kv.store.set('yt_handle_channel:alice', 'not-found')
    expect(await lookUpYouTubeHandle(ENV, '@alice')).toEqual({ notFound: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("ignores a remembered value that isn't a channel id", async () => {
    kv.store.set('yt_handle_channel:alice', 'garbage')
    fetchMock.mockResolvedValue(json({ items: [{ id: CHANNEL_A }] }))
    expect(await lookUpYouTubeHandle(ENV, '@alice')).toEqual({ channelId: CHANNEL_A })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("asks YouTube when the cache can't be read", async () => {
    kv.get.mockRejectedValue(new Error('kv down'))
    fetchMock.mockResolvedValue(json({ items: [{ id: CHANNEL_A }] }))
    expect(await lookUpYouTubeHandle(ENV, '@alice')).toEqual({ channelId: CHANNEL_A })
  })

  it.each([
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['a server error', () => Promise.resolve(json({}, 500))],
    ['quota exhausted', () => Promise.resolve(json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403))],
    ['a body that is not json', () => Promise.resolve(json('not json'))],
    ['an id that is not a channel id', () => Promise.resolve(json({ items: [{ id: 'UCshort' }] }))],
  ])('answers null and remembers nothing on %s', async (_name, respond) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockImplementation(respond)
    expect(await lookUpYouTubeHandle(ENV, '@alice')).toBeNull()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it("keeps the key out of the logs when YouTube can't be reached", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValue(new TypeError('failed: https://www.googleapis.com/?key=synthetic-key'))
    expect(await lookUpYouTubeHandle(ENV, '@alice')).toBeNull()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-key')
  })

  it("still answers when the answer can't be remembered", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    kv.put.mockRejectedValue(new Error('kv down'))
    fetchMock.mockResolvedValue(json({ items: [{ id: CHANNEL_A }] }))
    expect(await lookUpYouTubeHandle(ENV, '@alice')).toEqual({ channelId: CHANNEL_A })
    expect(warn).toHaveBeenCalled()
  })

  it('asks nothing without an API key', async () => {
    expect(await lookUpYouTubeHandle({ CACHE_KV: kv as unknown as KVNamespace }, '@alice')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['@café', '@Café', '@中文频道', '@한국어채널'])('sends a non-English handle percent-encoded (%s)', async (handle) => {
    fetchMock.mockResolvedValue(json({ items: [{ id: CHANNEL_A }] }))
    await lookUpYouTubeHandle(ENV, handle)
    expect(String(fetchMock.mock.calls[0][0])).toContain(`forHandle=${encodeURIComponent(handle)}`)
    expect(kv.put).toHaveBeenCalledWith(`yt_handle_channel:${handle.slice(1).replace(/[A-Z]/g, (c) => c.toLowerCase())}`, CHANNEL_A, {
      expirationTtl: 86400,
    })
  })
})
