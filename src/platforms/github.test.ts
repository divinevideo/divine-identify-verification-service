import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GitHubVerifier } from './github'

describe('GitHubVerifier', () => {
  const verifier = new GitHubVerifier()
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns verified when npub found in gist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        owner: { login: 'octocat' },
        files: {
          'nostr.md': { content: `Verifying that I control the following Nostr public key: ${npub}` },
        },
      }),
    }))

    const result = await verifier.verify('octocat', 'abc123', npub)
    expect(result.verified).toBe(true)
  })

  it('returns not verified when npub missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        owner: { login: 'octocat' },
        files: {
          'nostr.md': { content: 'Some other content without the key' },
        },
      }),
    }))

    const result = await verifier.verify('octocat', 'abc123', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('npub not found')
  })

  it('returns not verified when owner does not match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        owner: { login: 'differentuser' },
        files: {
          'nostr.md': { content: npub },
        },
      }),
    }))

    const result = await verifier.verify('octocat', 'abc123', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('owner does not match')
  })

  it('returns error for 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }))

    const result = await verifier.verify('octocat', 'notfound', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('not found')
  })
})
