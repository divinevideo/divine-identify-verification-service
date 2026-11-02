// ABOUTME: The result shape the Divine apps hard-cast when they read a verify answer,
// ABOUTME: shared by every contract test that checks one.
import { expect } from 'vitest'

// mobile 1.0.24-1.0.27 verification_result.dart: platform, identity and verified are
// hard casts, checked_at is cast `as int`, error and code are String? (a wrong type throws).
export function expectAppShape(result: Record<string, unknown>) {
  expect(typeof result.platform).toBe('string')
  expect(typeof result.identity).toBe('string')
  expect(typeof result.verified).toBe('boolean')
  expect(Number.isInteger(result.checked_at)).toBe(true)
  // mobile 1.0.26 identity_claims_repository.dart: checked_at is epoch seconds (a verified
  // snapshot is fresh for 24 hours after it). Milliseconds would keep it fresh for ages.
  expect(result.checked_at as number).toBeGreaterThan(1e9)
  expect(result.checked_at as number).toBeLessThan(1e10)
  for (const field of ['error', 'code']) {
    if (field in result) expect(typeof result[field]).toBe('string')
  }
  // mobile verification_result.dart: cached is a bool and canonical_* are strings when present.
  if ('cached' in result) expect(typeof result.cached).toBe('boolean')
  for (const field of ['canonical_identity', 'canonical_proof']) {
    if (field in result) expect(typeof result[field]).toBe('string')
  }
}
