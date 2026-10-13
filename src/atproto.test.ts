import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isMalformedDid, resolveDidDocument } from './atproto'

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
