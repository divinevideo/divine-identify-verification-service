import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveDidDocument } from './atproto'

describe('resolveDidDocument for did:web', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('reads the document from the well-known path of the domain', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ alsoKnownAs: ['at://alice.example.com'] }))

    const doc = await resolveDidDocument('did:web:example.com')

    expect(doc).toEqual({ alsoKnownAs: ['at://alice.example.com'] })
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/.well-known/did.json')
  })

  it('does not follow a redirect to an internal host', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: 'https://localhost/.well-known/did.json' } }),
    )

    const doc = await resolveDidDocument('did:web:example.com')

    expect(doc).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
  })

  it('follows a redirect to another public host', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: 'https://www.example.com/.well-known/did.json' } }))
      .mockResolvedValueOnce(Response.json({ alsoKnownAs: ['at://alice.example.com'] }))

    const doc = await resolveDidDocument('did:web:example.com')

    expect(doc).toEqual({ alsoKnownAs: ['at://alice.example.com'] })
    expect(fetchMock.mock.calls[1][0]).toBe('https://www.example.com/.well-known/did.json')
  })
})
