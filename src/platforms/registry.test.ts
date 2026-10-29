// ABOUTME: Tests that every platform the API accepts has a verifier, so a claim
// ABOUTME: on any accepted platform can be checked instead of failing its whole request.
import { describe, it, expect } from 'vitest'
import { getVerifier } from './registry'
import { VALID_PLATFORMS } from '../utils/validation'

describe('getVerifier', () => {
  it.each(VALID_PLATFORMS)('returns the %s verifier', (platform) => {
    expect(getVerifier(platform).name).toBe(platform)
  })
})
