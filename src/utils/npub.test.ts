import { describe, it, expect } from 'vitest'
import { hexToNpub, npubToHex } from './npub'

describe('npub', () => {
  // Known test vector
  const hex = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  it('converts hex to npub', () => {
    const result = hexToNpub(hex)
    expect(result).toBe(npub)
  })

  it('converts npub to hex', () => {
    const result = npubToHex(npub)
    expect(result).toBe(hex)
  })

  it('roundtrips hex → npub → hex', () => {
    const resultNpub = hexToNpub(hex)
    const resultHex = npubToHex(resultNpub)
    expect(resultHex).toBe(hex)
  })

  it('returns null for invalid npub', () => {
    expect(npubToHex('invalid')).toBeNull()
    expect(npubToHex('nsec1abc')).toBeNull()
    expect(npubToHex('')).toBeNull()
  })
})
