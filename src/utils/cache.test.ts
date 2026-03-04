import { describe, it, expect } from 'vitest'
import { cacheKey, nip05CacheKey } from './cache'

const pubkey = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'

describe('cache keys', () => {
  it('generates correct cache key with full pubkey', () => {
    const key = cacheKey('github', 'octocat', 'abc123', pubkey)
    expect(key).toBe(`v|github|octocat|abc123|${pubkey}`)
  })

  it('generates correct NIP-05 cache key with full pubkey', () => {
    const key = nip05CacheKey('_', 'divine.video', pubkey)
    expect(key).toBe(`nip05|_@divine.video|${pubkey}`)
  })

  it('uses different cache keys for different pubkeys', () => {
    const pubkey2 = '7e7e9c42ffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    const key1 = cacheKey('github', 'octocat', 'abc123', pubkey)
    const key2 = cacheKey('github', 'octocat', 'abc123', pubkey2)
    expect(key1).not.toBe(key2)
  })
})
