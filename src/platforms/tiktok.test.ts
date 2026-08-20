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
        author_unique_id: 'testuser',
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
        author_unique_id: 'testuser',
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
        author_unique_id: 'otheruser',
        title: npub,
      }),
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('does not match')
  })

  it('matches author handle case-insensitively', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'Display Name',
        author_unique_id: 'TestUser',
        title: npub,
      }),
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(true)
  })

  it('verifies when display name differs from the handle', async () => {
    // Regression: the claimed identity is the @handle, which oEmbed returns as
    // author_unique_id. Matching author_name (the display name) rejected every
    // account whose display name differs from its handle.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'foo',
        author_unique_id: 'foo7323',
        title: npub,
      }),
    }))

    const result = await verifier.verify('foo7323', '7676181219524021535', npub)
    expect(result.verified).toBe(true)
  })

  it('falls back to the documented author_url when author_unique_id is absent', async () => {
    // author_unique_id is undocumented; author_url is documented. Verification
    // must still work off author_url alone if TikTok drops the former.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'Display Name',
        author_url: 'https://www.tiktok.com/@foo7323',
        title: npub,
      }),
    }))

    const result = await verifier.verify('foo7323', '7676181219524021535', npub)
    expect(result.verified).toBe(true)
  })

  it('ignores an author_url on a non-TikTok host', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'Display Name',
        author_url: 'https://evil.example/@foo7323',
        title: npub,
      }),
    }))

    const result = await verifier.verify('foo7323', '7676181219524021535', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Unable to verify')
  })

  it('ignores an author_url that is not a bare @handle profile path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'Display Name',
        author_url: 'https://www.tiktok.com/@foo7323/video/7676181219524021535',
        title: npub,
      }),
    }))

    const result = await verifier.verify('foo7323', '7676181219524021535', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Unable to verify')
  })

  it('returns error when neither author_unique_id nor a valid author_url is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'testuser',
        title: npub,
      }),
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Unable to verify')
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
