import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveDidDocument, resolveHandle } from './atproto'
import { PlatformUnavailableError } from './platforms/base'

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

// bsky.social and the PLC directory are the two services this one names
// itself, and neither takes a credential from it. So a 401, a 403, or a page
// that isn't JSON from either is the service refusing or misbehaving, never an
// answer about the account.
describe.each([
  ['the handle lookup', () => resolveHandle('alice.example.com'), () => Response.json({ did: 'did:plc:alice111111111111111111' })],
  ['the PLC directory lookup', () => resolveDidDocument('did:plc:alice111111111111111111'), () => Response.json({ alsoKnownAs: ['at://alice.example.com'] })],
] as const)('%s', (_name, lookUp, working) => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('answers when the service answers', async () => {
    fetchMock.mockResolvedValueOnce(working())

    expect(await lookUp()).not.toBeNull()
  })

  it.each([401, 403])('says the service didn\'t answer when it refuses with %i', async status => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }))

    await expect(lookUp()).rejects.toBeInstanceOf(PlatformUnavailableError)
  })

  it.each([
    ['a page that isn\'t JSON', () => new Response('<html>blocked</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ['an empty body', () => new Response('', { status: 200 })],
  ])('says the service didn\'t answer when it answers 200 with %s', async (_label, page) => {
    fetchMock.mockResolvedValueOnce(page())

    await expect(lookUp()).rejects.toBeInstanceOf(PlatformUnavailableError)
  })

  // 400 from the handle lookup and 404 from the PLC directory are how each
  // says the account isn't there.
  it.each([400, 404])('still says there is no such account when it answers %i', async status => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }))

    expect(await lookUp()).toBeNull()
  })
})

// A did:web host is the person's own website, and a static host answers a 403
// or a page of its own for a file it doesn't have, which is a plain "not
// there".
describe('resolveDidDocument for a did:web host that refuses or answers oddly', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it.each([401, 403])('finds no document when the host answers %i', async status => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }))

    expect(await resolveDidDocument('did:web:example.com')).toBeNull()
  })

  it('finds no document when the host answers 200 with a page that isn\'t JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>home</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))

    expect(await resolveDidDocument('did:web:example.com')).toBeNull()
  })
})
