import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BlueskyVerifier } from './bluesky'

describe('BlueskyVerifier', () => {
  const verifier = new BlueskyVerifier()
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
  const did = 'did:plc:abc123'
  const pdsEndpoint = 'https://example-pds.test'

  function didDocumentResponse() {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        service: [{ id: '#atproto_pds', serviceEndpoint: pdsEndpoint }],
      }),
    }
  }

  function emptyIdentityLinksResponse() {
    return {
      ok: true,
      status: 200,
      json: async () => ({ records: [] }),
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns verified when identity-link record matches npub', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ did }),
      })
      .mockResolvedValueOnce(didDocumentResponse())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          records: [{
            uri: `at://${did}/video.divine.identity.link/nostr-npub`,
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
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0][0]).toBe('https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=alice.bsky.social')
    expect(fetchMock.mock.calls[2][0]).toBe(`${pdsEndpoint}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(did)}&collection=video.divine.identity.link&limit=100`)
  })

  it('falls back to proof post and verifies when npub found in correct author post', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(didDocumentResponse())
      .mockResolvedValueOnce(emptyIdentityLinksResponse())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          thread: {
            post: {
              author: { handle: 'alice.bsky.social', did },
              record: { text: `Verifying my nostr key: ${npub}` },
            },
          },
        }),
      }))

    const result = await verifier.verify(did, 'abc123rkey', npub)
    expect(result.verified).toBe(true)
    expect(result.method).toBe('proof_post')
  })

  it('returns not verified when author does not match', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(didDocumentResponse())
      .mockResolvedValueOnce(emptyIdentityLinksResponse())
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

    const result = await verifier.verify(did, 'abc123rkey', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('author does not match')
  })

  it('returns not verified when npub missing', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(didDocumentResponse())
      .mockResolvedValueOnce(emptyIdentityLinksResponse())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          thread: {
            post: {
              author: { handle: 'alice.bsky.social', did },
              record: { text: 'Just a regular post' },
            },
          },
        }),
      }))

    const result = await verifier.verify(did, 'abc123rkey', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('npub not found')
  })

  it('returns error for missing identity link and missing post proof', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(didDocumentResponse())
      .mockResolvedValueOnce(emptyIdentityLinksResponse()))

    const result = await verifier.verify(did, '', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('no Bluesky post proof')
  })

  it('targets the resolved PDS for identity-link records and the public AppView for proof posts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(didDocumentResponse())
      .mockResolvedValueOnce(emptyIdentityLinksResponse())
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

    const identityLinkUrl = fetchMock.mock.calls[1][0] as string
    const proofPostUrl = fetchMock.mock.calls[2][0] as string
    expect(identityLinkUrl.startsWith(`${pdsEndpoint}/xrpc/com.atproto.repo.listRecords`)).toBe(true)
    expect(identityLinkUrl.startsWith('https://public.api.bsky.app/')).toBe(false)
    expect(proofPostUrl.startsWith('https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread')).toBe(true)
  })
})
