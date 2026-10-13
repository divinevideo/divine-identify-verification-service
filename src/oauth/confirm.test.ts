import { describe, it, expect } from 'vitest'
import type { Bindings } from '../types'
import {
  CONFIRM_TTL_SECONDS, signInConfirmationMode, confirmCodePlacement, isSignInToken,
  sha256Hex, startCheckFor, confirmBindingFor, newConfirmCode, sameToken,
} from './confirm'

// The same values are pinned in the page tests and in divine-mobile, so every
// client and the verifier hash a sign-in the same way.
const VECTOR = {
  secret: 'S'.repeat(43),
  code: 'C'.repeat(43),
  startCheck: 'G2CN_J8Es1JmsWz0QXd2Kc-4p-lCo8GCsR-tVw6vre4',
  binding: 'y_rdmZDwlKYUcthysDgPyoiPWBwzgSafjaPHJ4JE1ZY',
  codeHex: '942014af03195c97fc8a6121a03e1660b89027a538325a101eba426dacd7e587',
}

const env = (vars: Partial<Bindings>) => ({ CACHE_KV: {}, RATE_LIMIT_KV: {}, ...vars }) as Bindings

describe('sign-in confirmation settings', () => {
  it('waits ten minutes for a confirmation', () => {
    expect(CONFIRM_TTL_SECONDS).toBe(600)
  })

  it('counts unconfirmed sign-ins until the switch is set to required', () => {
    expect(signInConfirmationMode(env({}))).toBe('optional')
    expect(signInConfirmationMode(env({ SIGNIN_CONFIRMATION: 'optional' }))).toBe('optional')
    expect(signInConfirmationMode(env({ SIGNIN_CONFIRMATION: 'Required' }))).toBe('optional')
    expect(signInConfirmationMode(env({ SIGNIN_CONFIRMATION: 'required' }))).toBe('required')
  })

  it('sends the code after the # unless set to the query', () => {
    expect(confirmCodePlacement(env({}))).toBe('fragment')
    expect(confirmCodePlacement(env({ SIGNIN_CODE_PLACEMENT: 'query' }))).toBe('query')
    expect(confirmCodePlacement(env({ SIGNIN_CODE_PLACEMENT: 'bogus' }))).toBe('fragment')
  })
})

describe('hashing a sign-in', () => {
  it('matches the shared test vector', async () => {
    expect(await startCheckFor(VECTOR.secret)).toBe(VECTOR.startCheck)
    expect(await confirmBindingFor(VECTOR.code, VECTOR.startCheck)).toBe(VECTOR.binding)
    expect(await sha256Hex(VECTOR.code)).toBe(VECTOR.codeHex)
  })

  it('binds the value to both the code and the start check', async () => {
    expect(await confirmBindingFor(VECTOR.code, 'X'.repeat(43))).not.toBe(VECTOR.binding)
    expect(await confirmBindingFor('D'.repeat(43), VECTOR.startCheck)).not.toBe(VECTOR.binding)
  })

  it('makes 43-character base64url codes that differ each time', () => {
    const a = newConfirmCode()
    const b = newConfirmCode()
    expect(isSignInToken(a)).toBe(true)
    expect(a).not.toBe(b)
  })

  it('accepts only 43 base64url characters as a secret, check or code', () => {
    expect(isSignInToken(VECTOR.secret)).toBe(true)
    expect(isSignInToken(VECTOR.startCheck)).toBe(true)
    expect(isSignInToken('S'.repeat(42))).toBe(false)
    expect(isSignInToken('S'.repeat(44))).toBe(false)
    expect(isSignInToken('S'.repeat(42) + '=')).toBe(false)
    expect(isSignInToken('S'.repeat(42) + '+')).toBe(false)
    expect(isSignInToken(42)).toBe(false)
  })

  it('compares tokens exactly', () => {
    expect(sameToken(VECTOR.startCheck, VECTOR.startCheck)).toBe(true)
    expect(sameToken(VECTOR.startCheck, VECTOR.startCheck.slice(0, 42) + 'x')).toBe(false)
    expect(sameToken(VECTOR.startCheck, VECTOR.startCheck.slice(0, 42))).toBe(false)
  })
})
