import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isMalformedDid, resolveDidDocument, resolveHandle } from './atproto'
import { PlatformUnavailableError } from './platforms/base'

describe('isMalformedDid', () => {
  // A did:plc is "did:plc:" and 24 lowercase base32 letters and digits
  // (a-z, 2-7), per the did:plc spec.
  it.each([
    'did:plc:',
    'did:plc:abc',
    'did:plc:abc123',
    `did:plc:${'a'.repeat(23)}`,
    `did:plc:${'a'.repeat(25)}`,
    `did:plc:${'A'.repeat(24)}`,
    `did:plc:${'a'.repeat(23)}1`,
    `did:plc:${'a'.repeat(23)}-`,
  ])('%s is not a did:plc', did => {
    expect(isMalformedDid(did)).toBe(true)
  })

  // A did:web is held to atproto's DID syntax: letters, digits and ._%- only
  // (no ":", since atproto supports hostname-level did:web only), not ending
  // in %, and each % followed by an escape that decodes.
  it.each([
    'did:web:',
    'did:web:%',
    'did:web:example.com%',
    'did:web:example.com:',
    'did:web:%E0%A4%A',
    'did:web:%FF',
    'did:web:example.com?x=1',
    'did:web:example.com#key',
    'did:web:exam ple.com',
    'did:web:example.com%2Fpath',
    'did:web:example.com%5Cpath',
    'did:web:example.com:user:alice',
  ])('%s is not a did:web', did => {
    expect(isMalformedDid(did)).toBe(true)
  })

  it.each([
    `did:plc:${'a'.repeat(24)}`,
    'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
    'did:web:example.com',
    'did:web:user.example.com',
    // A port is written as an escaped colon.
    'did:web:localhost%3A8080',
    // Not a DID at all, and no business of this check.
    'alice.bsky.social',
  ])('%s is not reported as malformed', did => {
    expect(isMalformedDid(did)).toBe(false)
  })
})

describe('resolveDidDocument for did:web', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('finds no document for a did:web with a broken percent-escape, instead of throwing', async () => {
    await expect(resolveDidDocument('did:web:%')).resolves.toBeNull()
    await expect(resolveDidDocument('did:web:%E0%A4%A')).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
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
