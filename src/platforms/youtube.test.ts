import { describe, it, expect, vi, beforeEach } from 'vitest'
import { YouTubeVerifier } from './youtube'

describe('YouTubeVerifier', () => {
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
  const apiKey = 'test-api-key'
  const verifier = new YouTubeVerifier(apiKey)

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns verified when npub found in video description', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{
          snippet: {
            channelId: 'UCxxxxxxxxxxxxxxxxxxxxxxxx',
            description: `My Nostr pubkey: ${npub}`,
            channelTitle: 'Test Channel',
          },
        }],
      }),
    }))

    const result = await verifier.verify('UCxxxxxxxxxxxxxxxxxxxxxxxx', 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(true)
  })

  it('returns not verified when npub not in description', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{
          snippet: {
            channelId: 'UCxxxxxxxxxxxxxxxxxxxxxxxx',
            description: 'Just a regular video description',
            channelTitle: 'Test Channel',
          },
        }],
      }),
    }))

    const result = await verifier.verify('UCxxxxxxxxxxxxxxxxxxxxxxxx', 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('npub not found')
  })

  it('returns error when channel does not match identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{
          snippet: {
            channelId: 'UCdifferentchannel',
            description: npub,
            channelTitle: 'Other Channel',
          },
        }],
      }),
    }))

    const result = await verifier.verify('UCxxxxxxxxxxxxxxxxxxxxxxxx', 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('does not match')
  })

  it('returns error for video not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    }))

    const result = await verifier.verify('UCxxxxxxxxxxxxxxxxxxxxxxxx', 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('returns error for invalid video ID format', async () => {
    const result = await verifier.verify('UCxxxxxxxxxxxxxxxxxxxxxxxx', 'bad', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Invalid YouTube video ID')
  })

  it('returns error when API key not configured', async () => {
    const noKeyVerifier = new YouTubeVerifier()
    const result = await noKeyVerifier.verify('UCxxxxxxxxxxxxxxxxxxxxxxxx', 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('not configured')
  })

  it('returns error on API failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    }))

    const result = await verifier.verify('UCxxxxxxxxxxxxxxxxxxxxxxxx', 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('YouTube API error')
  })

  it('returns error on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))

    const result = await verifier.verify('UCxxxxxxxxxxxxxxxxxxxxxxxx', 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Failed to fetch')
  })

  it('works with handle-based identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{
          snippet: {
            channelId: 'UCxxxxxxxxxxxxxxxxxxxxxxxx',
            description: `Verify: ${npub}`,
            channelTitle: 'Test Channel',
          },
        }],
      }),
    }))

    const result = await verifier.verify('@testuser', 'dQw4w9WgXcQ', npub)
    expect(result.verified).toBe(true)
  })
})
