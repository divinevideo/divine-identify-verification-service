// ABOUTME: Tests that every platform the API accepts gets its own verifier, and that
// ABOUTME: a platform with no verifier still fails with a clear error.
import { describe, it, expect } from 'vitest'
import { getVerifier } from './registry'
import { VALID_PLATFORMS } from '../utils/validation'
import type { Platform } from '../types'

describe('getVerifier', () => {
  it.each(VALID_PLATFORMS)('returns the %s verifier', (platform) => {
    expect(getVerifier(platform).name).toBe(platform)
  })

  it('names a platform it has no verifier for', () => {
    expect(() => getVerifier('nope' as Platform)).toThrow('Unknown platform: nope')
  })
})
