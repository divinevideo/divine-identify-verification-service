import { describe, it, expect } from 'vitest'
import {
  isValidPlatform,
  isValidHexPubkey,
  isValidProof,
  isValidIdentity,
  validateClaim,
  validateNip05Name,
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
