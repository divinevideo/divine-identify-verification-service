import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TikTokVerifier } from './tiktok'

describe('TikTokVerifier', () => {
  const verifier = new TikTokVerifier()
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns verified when npub found in video caption', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'testuser',
        title: `My Nostr key: ${npub} #nostr`,
      }),
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(true)
  })

  it('returns not verified when npub not in caption', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'testuser',
        title: 'Just a regular TikTok caption',
      }),
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('npub not found')
  })

  it('returns error when author does not match identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'otheruser',
        title: npub,
      }),
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('does not match')
  })

  it('matches author name case-insensitively', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'TestUser',
        title: npub,
      }),
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(true)
  })

  it('returns error for 404 video', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('returns error for invalid video ID format', async () => {
    const result = await verifier.verify('testuser', 'bad-id', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Invalid TikTok video ID')
  })

  it('returns error for invalid username format', async () => {
    const result = await verifier.verify('bad user!', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Invalid TikTok username')
  })

  it('returns error on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Failed to fetch')
  })

  it('returns error on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('oEmbed error')
  })
})
