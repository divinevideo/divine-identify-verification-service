import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { YouTubeVerifier } from './youtube'
import { PlatformUnavailableError } from './base'
import { fakeResponse } from '../test-support/fake-response'

const CHANNEL_A = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const CHANNEL_B = 'UCbbbbbbbbbbbbbbbbbbbbbb'

describe('YouTubeVerifier', () => {
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
  const apiKey = 'test-api-key'
  const verifier = new YouTubeVerifier(apiKey)

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns verified when npub found in video description', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{
          snippet: {
            channelId: CHANNEL_A,
            description: `My Nostr pubkey: ${npub}`,
            channelTitle: 'Test Channel',
          },
        }],
      }),
    })))

    const result = await verifier.verify(CHANNEL_A, 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(true)
  })

  it('returns not verified when npub not in description', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{
          snippet: {
            channelId: CHANNEL_A,
            description: 'Just a regular video description',
            channelTitle: 'Test Channel',
          },
        }],
      }),
    })))

    const result = await verifier.verify(CHANNEL_A, 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('npub not found')
  })

  it('returns error when channel does not match identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{
          snippet: {
            channelId: CHANNEL_B,
            description: npub,
            channelTitle: 'Other Channel',
          },
        }],
      }),
    })))

    const result = await verifier.verify(CHANNEL_A, 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('does not match')
  })

  it('returns error for video not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    })))

    const result = await verifier.verify(CHANNEL_A, 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('returns error for invalid video ID format', async () => {
    const result = await verifier.verify(CHANNEL_A, 'bad', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Invalid YouTube video ID')
  })

  it('returns error when API key not configured', async () => {
    const noKeyVerifier = new YouTubeVerifier()
    const result = await noKeyVerifier.verify(CHANNEL_A, 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('not configured')
  })

  it('returns error on API failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    }))

    const result = await verifier.verify(CHANNEL_A, 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('YouTube API error')
  })

  it('throws on fetch failure, so the service reports it as temporary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))

    await expect(verifier.verify(CHANNEL_A, 'dQw4w9WgXcQ', npub)).rejects.toThrow("couldn't be reached")
  })

  describe('handles', () => {
    const videoOf = (channelId: string, description = `Verify: ${npub}`) => ({
      items: [{ snippet: { channelId, description, channelTitle: 'Test Channel' } }],
    })
    type Answer = Response | Error

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

    // Routes the stubbed fetch by endpoint and records every call's URL.
    function stubYouTube(answers: { video?: unknown; channels?: Answer }) {
      const calls: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
        const url = String(input)
        calls.push(url)
        const answer: Answer | undefined = url.includes('/youtube/v3/channels')
          ? answers.channels
          : new Response(JSON.stringify(answers.video ?? { items: [] }), { status: 200 })
        if (answer instanceof Error) throw answer
        return answer ?? new Response('{}', { status: 200 })
      }))
      return {
        calls,
        videos: () => calls.filter(u => u.includes('/youtube/v3/videos')),
        channels: () => calls.filter(u => u.includes('/youtube/v3/channels')),
      }
    }
    const channelsAnswer = (body: unknown, status = 200) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

    let kv: ReturnType<typeof fakeKv>
    let handleVerifier: YouTubeVerifier
    beforeEach(() => {
      kv = fakeKv()
      handleVerifier = new YouTubeVerifier(apiKey, kv as unknown as KVNamespace)
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it.each(['@alice', 'alice', 'UCLA', '@café', '@한국어채널'])(
      'verifies a handle that resolves to the video\'s channel: %s',
      async (identity) => {
        stubYouTube({ video: videoOf(CHANNEL_A), channels: channelsAnswer({ items: [{ id: CHANNEL_A }] }) })
        const result = await handleVerifier.verify(identity, 'dQw4w9WgXcQ', npub)
        expect(result.verified).toBe(true)
        expect(result).not.toHaveProperty('canonicalIdentity')
      },
    )

    it('refuses a handle that resolves to a different channel', async () => {
      stubYouTube({ video: videoOf(CHANNEL_A), channels: channelsAnswer({ items: [{ id: CHANNEL_B }] }) })
      const result = await handleVerifier.verify('@alice', 'dQw4w9WgXcQ', npub)
      expect(result).toEqual({ verified: false, error: 'Video channel does not match claimed identity' })
    })

    it("refuses a handle YouTube doesn't know", async () => {
      stubYouTube({ video: videoOf(CHANNEL_A), channels: channelsAnswer({ items: [] }) })
      const result = await handleVerifier.verify('@alice', 'dQw4w9WgXcQ', npub)
      expect(result).toEqual({ verified: false, error: 'YouTube handle not found' })
    })

    it.each([
      ['a timeout', new DOMException('timed out', 'TimeoutError')],
      ['a 500', channelsAnswer({}, 500)],
      ['a quota 403', channelsAnswer({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403)],
      ['an unreadable body', channelsAnswer('not json')],
    ])("reports a handle lookup YouTube didn't answer as couldn't check: %s", async (_name, channels) => {
      stubYouTube({ video: videoOf(CHANNEL_A), channels })
      await expect(handleVerifier.verify('@alice', 'dQw4w9WgXcQ', npub)).rejects.toBeInstanceOf(PlatformUnavailableError)
      expect([...kv.store.keys()].some(k => k.startsWith('yt_handle_channel:'))).toBe(false)
    })

    it.each([
      'https://www.youtube.com/c/alice',
      'https://www.youtube.com/user/alice',
      'c/alice',
      'al ice',
      '@',
    ])('refuses a malformed account before asking YouTube: %s', async (identity) => {
      const youtube = stubYouTube({ video: videoOf(CHANNEL_A) })
      const result = await handleVerifier.verify(identity, 'dQw4w9WgXcQ', npub)
      expect(result).toEqual({
        verified: false,
        error: "Invalid YouTube channel. Use the channel's @handle or its channel ID (UC followed by 22 characters).",
      })
      expect(youtube.calls).toHaveLength(0)
    })

    it('checks the npub before resolving the handle', async () => {
      const youtube = stubYouTube({ video: videoOf(CHANNEL_A, 'No key here'), channels: channelsAnswer({ items: [{ id: CHANNEL_A }] }) })
      const result = await handleVerifier.verify('@alice', 'dQw4w9WgXcQ', npub)
      expect(result.error).toContain('npub not found')
      expect(youtube.calls).toHaveLength(1)
      expect(youtube.calls[0]).toContain('/youtube/v3/videos')
    })

    it('refuses a handle claim when the video has no channel', async () => {
      const youtube = stubYouTube({ video: videoOf(''), channels: channelsAnswer({ items: [{ id: CHANNEL_A }] }) })
      const result = await handleVerifier.verify('@alice', 'dQw4w9WgXcQ', npub)
      expect(result).toEqual({ verified: false, error: 'Unable to determine video channel' })
      expect(youtube.calls).toHaveLength(1)
      expect(youtube.videos()).toHaveLength(1)
    })

    it('compares channel ids exactly', async () => {
      const youtube = stubYouTube({ video: videoOf('UCAAAAAAAAAAAAAAAAAAAAAA') })
      const result = await handleVerifier.verify(CHANNEL_A, 'dQw4w9WgXcQ', npub)
      expect(result).toEqual({ verified: false, error: 'Video channel does not match claimed identity' })
      expect(youtube.channels()).toHaveLength(0)
    })

    it('resolves a handle once within the cache time', async () => {
      const youtube = stubYouTube({ video: videoOf(CHANNEL_A), channels: channelsAnswer({ items: [{ id: CHANNEL_A }] }) })
      await handleVerifier.verify('@alice', 'dQw4w9WgXcQ', npub)
      await handleVerifier.verify('@alice', 'dQw4w9WgXcQ', npub)
      await handleVerifier.verify('@Alice', 'dQw4w9WgXcQ', npub)
      expect(youtube.channels()).toHaveLength(1)
    })

    it('resolves a 26-character UC string as a handle', async () => {
      const youtube = stubYouTube({ video: videoOf(CHANNEL_A), channels: channelsAnswer({ items: [{ id: CHANNEL_A }] }) })
      await handleVerifier.verify('UCaaaaaaaaaaaaaaaaaaaaaaaa', 'dQw4w9WgXcQ', npub)
      expect(youtube.channels()[0]).toContain('forHandle=%40UCaaaaaaaaaaaaaaaaaaaaaaaa')
    })
  })
})
