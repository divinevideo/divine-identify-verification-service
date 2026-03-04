import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BlueskyVerifier } from './bluesky'

describe('BlueskyVerifier', () => {
  const verifier = new BlueskyVerifier()
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns verified when npub found in post from correct author', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        thread: {
          post: {
            author: { handle: 'alice.bsky.social', did: 'did:plc:abc123' },
            record: { text: `Verifying my nostr key: ${npub}` },
          },
        },
      }),
    }))

    const result = await verifier.verify('alice.bsky.social', 'abc123rkey', npub)
    expect(result.verified).toBe(true)
  })

  it('returns not verified when author does not match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        thread: {
          post: {
            author: { handle: 'bob.bsky.social', did: 'did:plc:other' },
            record: { text: `Verifying my nostr key: ${npub}` },
          },
        },
      }),
    }))

    const result = await verifier.verify('alice.bsky.social', 'abc123rkey', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('author does not match')
  })

  it('returns not verified when npub missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        thread: {
          post: {
            author: { handle: 'alice.bsky.social' },
            record: { text: 'Just a regular post' },
          },
        },
      }),
    }))

    const result = await verifier.verify('alice.bsky.social', 'abc123rkey', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('npub not found')
  })

  it('returns error for not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    }))

    const result = await verifier.verify('alice.bsky.social', 'badid', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('not found')
  })
})
