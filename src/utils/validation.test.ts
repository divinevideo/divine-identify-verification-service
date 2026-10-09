import { describe, it, expect } from 'vitest'
import {
  isValidPlatform,
  isValidHexPubkey,
  isValidProof,
  isValidIdentity,
  validateClaim,
  validateNip05Name,
  isPrivateHostname,
  isSafeUrl,
} from './validation'

describe('isValidPlatform', () => {
  it('accepts valid platforms', () => {
    expect(isValidPlatform('github')).toBe(true)
    expect(isValidPlatform('twitter')).toBe(true)
    expect(isValidPlatform('mastodon')).toBe(true)
    expect(isValidPlatform('telegram')).toBe(true)
    expect(isValidPlatform('bluesky')).toBe(true)
  })

  it('rejects invalid platforms', () => {
    expect(isValidPlatform('reddit')).toBe(false)
    expect(isValidPlatform('')).toBe(false)
    expect(isValidPlatform('GITHUB')).toBe(false)
  })
})

describe('isValidHexPubkey', () => {
  it('accepts valid 64-char hex', () => {
    expect(isValidHexPubkey('7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e')).toBe(true)
  })

  it('rejects invalid pubkeys', () => {
    expect(isValidHexPubkey('')).toBe(false)
    expect(isValidHexPubkey('abc')).toBe(false)
    expect(isValidHexPubkey('ZZZZ9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e')).toBe(false)
    expect(isValidHexPubkey('7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e00')).toBe(false)
  })
})

describe('isValidProof', () => {
  it('accepts valid proofs', () => {
    expect(isValidProof('abc123')).toBe(true)
    expect(isValidProof('1234567890')).toBe(true)
    expect(isValidProof('my-channel/123')).toBe(true)
  })

  it('rejects invalid proofs', () => {
    expect(isValidProof('')).toBe(false)
    expect(isValidProof('<script>')).toBe(false)
  })
})

describe('isValidIdentity', () => {
  it('accepts valid identities', () => {
    expect(isValidIdentity('jack')).toBe(true)
    expect(isValidIdentity('mastodon.social/@alice')).toBe(true)
    expect(isValidIdentity('user.bsky.social')).toBe(true)
  })

  it('rejects invalid identities', () => {
    expect(isValidIdentity('')).toBe(false)
    expect(isValidIdentity('<script>alert(1)</script>')).toBe(false)
  })
})

describe('validateClaim', () => {
  const validClaim = {
    pubkey: '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e',
    platform: 'github' as const,
    identity: 'octocat',
    proof: 'abc123def456',
  }

  it('returns null for valid claim', () => {
    expect(validateClaim(validClaim, 0)).toBeNull()
  })

  it('returns error for invalid pubkey', () => {
    const result = validateClaim({ ...validClaim, pubkey: 'bad' }, 0)
    expect(result).not.toBeNull()
    expect(result!.error).toContain('pubkey')
  })

  it('returns error for invalid platform', () => {
    const result = validateClaim({ ...validClaim, platform: 'reddit' as any }, 0)
    expect(result).not.toBeNull()
    expect(result!.error).toContain('platform')
  })

  it('allows missing proof for bluesky claims', () => {
    const result = validateClaim({
      ...validClaim,
      platform: 'bluesky' as const,
      identity: 'alice.bsky.social',
      proof: '',
    }, 0)
    expect(result).toBeNull()
  })

  it('requires proof for non-bluesky claims', () => {
    const result = validateClaim({ ...validClaim, platform: 'twitter' as const, proof: '' }, 0)
    expect(result).not.toBeNull()
    expect(result!.error).toContain('proof')
  })
})

describe('validateNip05Name', () => {
  it('parses valid NIP-05 names', () => {
    expect(validateNip05Name('_@divine.video')).toEqual({ local: '_', domain: 'divine.video' })
    expect(validateNip05Name('alice@example.com')).toEqual({ local: 'alice', domain: 'example.com' })
  })

  it('rejects invalid NIP-05 names', () => {
    expect(validateNip05Name('')).toBeNull()
    expect(validateNip05Name('noat')).toBeNull()
    expect(validateNip05Name('@nodomain')).toBeNull()
    expect(validateNip05Name('user@')).toBeNull()
    expect(validateNip05Name('user@localhost')).toBeNull()
  })
})

// A host is judged the way a fetch reads it: URL parsing lowercases names,
// keeps a trailing dot, and reads short and hex IPv4 forms as addresses.
describe('isPrivateHostname', () => {
  it.each([
    'localhost', 'LOCALHOST', 'localhost.', 'app.localhost',
    'printer.local', 'printer.LOCAL', 'printer.local.', 'db.internal', 'db.internal.', 'host.corp',
    '127.0.0.1', '127.1', '0x7f.1', '2130706433', '0177.0.0.1', '10.1', '0', '8.8.8.8',
    '[::1]', '::1',
    '', '.', 'example.com:8080', 'example.com:443', 'example.com:', '@example.com', 'user@example.com',
    'example.com/path', 'example.com/.', 'example.com\\x', 'example.com?x', 'example.com#x', 'bad host',
    '127.1..', '2130706433..', '0x7f.1..', '10.1..', 'example.com..', '.example.com', 'a..b.com',
    'printer.lan', 'PRINTER.LAN', 'home.arpa', 'nas.home.arpa', 'NAS.Home.Arpa',
    // A bare label is resolved by the local network, not the public DNS
    'internal', 'corp', 'local', 'metadata', 'intranet', 'INTERNAL', 'lan',
    // A trailing dot fails the TLS host check in the Workers runtime
    'example.com.', 'mastodon.social.', 'Mastodon.Social.',
  ])('treats %j as not fetchable', host => {
    expect(isPrivateHostname(host)).toBe(true)
  })

  it.each(['mastodon.social', 'Mastodon.Social', 'social.example.org', 'lan.example.com', 'home.arpa.example.com', 'wlan.example.org'])('allows the public name %j', host => {
    expect(isPrivateHostname(host)).toBe(false)
  })
})

describe('isPrivateHostname with input that is not a string', () => {
  // The array would read as the public name mastodon.social if it were coerced
  it.each([undefined, null, 42, {}, ['mastodon.social']])('treats %j as not fetchable', value => {
    expect(isPrivateHostname(value as unknown as string)).toBe(true)
  })
})

describe('isSafeUrl', () => {
  it.each([
    'https://localhost./x', 'https://printer.local./x', 'https://db.internal./x', 'https://pds.example.com./x', 'https://metadata/x',
    'https://LOCALHOST/x', 'https://127.1/x', 'https://[::1]/x', 'http://bsky.social/x', 'not a url',
  ])('refuses %j', url => {
    expect(isSafeUrl(url)).toBe(false)
  })

  it.each(['https://bsky.social/xrpc', 'https://pds.example.com', 'https://example.com:8443/x', 'https://münchen.de/', 'https://xn--mnchen-3ya.de/'])('allows %j', url => {
    expect(isSafeUrl(url)).toBe(true)
  })
})
