import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BlueskyVerifier } from './bluesky'

describe('BlueskyVerifier', () => {
  const verifier = new BlueskyVerifier()
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns verified when identity-link record matches npub', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          records: [{
            uri: 'at://did:plc:abc123/video.divine.identity.link/nostr-npub',
            value: {
              $type: 'video.divine.identity.link',
              version: 1,
              target: { protocol: 'nostr', id: npub },
              proof: { type: 'oauth', createdAt: '2026-03-06T00:00:00.000Z' },
            },
          }],
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifier.verify('alice.bsky.social', '', npub)
    expect(result.verified).toBe(true)
    expect(result.method).toBe('identity_link')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to proof post and verifies when npub found in correct author post', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ records: [] }),
      })
      .mockResolvedValueOnce({
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
    expect(result.method).toBe('proof_post')
  })

  it('returns not verified when author does not match', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ records: [] }),
      })
      .mockResolvedValueOnce({
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
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ records: [] }),
      })
      .mockResolvedValueOnce({
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

  it('returns error for missing identity link and missing post proof', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ records: [] }),
    }))

    const result = await verifier.verify('alice.bsky.social', '', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('no Bluesky post proof')
  })

  it('targets the public AppView for both identity-link and proof-post calls', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ records: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          thread: {
            post: {
              author: { handle: 'e2ctbutx6kya6si4if5ngjmm', did: 'did:plc:e2ctbutx6kya6si4if5ngjmm' },
              record: { text: `Verifying my nostr key: ${npub}` },
            },
          },
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifier.verify('did:plc:e2ctbutx6kya6si4if5ngjmm', '3molaaw2qhk25', npub)
    expect(result.verified).toBe(true)
    expect(result.method).toBe('proof_post')

    const identityLinkUrl = fetchMock.mock.calls[0][0] as string
    const proofPostUrl = fetchMock.mock.calls[1][0] as string
    for (const u of [identityLinkUrl, proofPostUrl]) {
      expect(u.startsWith('https://public.api.bsky.app/xrpc/')).toBe(true)
      expect(u.startsWith('https://bsky.social/')).toBe(false)
    }
  })
})
