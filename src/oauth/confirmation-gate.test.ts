// ABOUTME: Tests how CONFIRMATION_GATE and CONFIRMATION_TESTERS are read into the gate mode and tester set.
// ABOUTME: Covers unknown values, case, separators, and that malformed testers are never echoed to the logs.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Bindings } from '../types'
import { confirmationGate, confirmationTesters, isConfirmationTester } from './confirmation-gate'

const env = (vars: Partial<Bindings>) => vars as Bindings
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

describe('CONFIRMATION_GATE', () => {
  it.each([
    [undefined, 'off'],
    ['off', 'off'],
    ['shadow', 'shadow'],
    ['on', 'on'],
    [' On ', 'on'],
    ['SHADOW', 'shadow'],
  ])('reads %j as %j', (value, mode) => {
    expect(confirmationGate(env({ CONFIRMATION_GATE: value }))).toBe(mode)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it.each(['onn', '', 'true', 'enabled'])('treats %j as off, and says so', (value) => {
    expect(confirmationGate(env({ CONFIRMATION_GATE: value }))).toBe('off')
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('warns once for a repeated unknown gate value', () => {
    expect(confirmationGate(env({ CONFIRMATION_GATE: 'gate-memo-once' }))).toBe('off')
    expect(confirmationGate(env({ CONFIRMATION_GATE: 'gate-memo-once' }))).toBe('off')
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})

describe('CONFIRMATION_TESTERS', () => {
  it('reads testers separated by commas or spaces', () => {
    expect([...confirmationTesters(env({ CONFIRMATION_TESTERS: `${A}, ${B}\n${A}` }))].sort()).toEqual([A, B])
  })

  it('lowercases an uppercase tester', () => {
    expect(isConfirmationTester(env({ CONFIRMATION_TESTERS: A.toUpperCase() }), A)).toBe(true)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('matches a pubkey given in uppercase', () => {
    expect(isConfirmationTester(env({ CONFIRMATION_TESTERS: A }), A.toUpperCase())).toBe(true)
    expect(isConfirmationTester(env({ CONFIRMATION_TESTERS: A }), B)).toBe(false)
  })

  it('ignores npub and malformed testers without echoing them', () => {
    const npub = 'npub1' + 'q'.repeat(58)
    const short = 'c'.repeat(63)
    const set = confirmationTesters(env({ CONFIRMATION_TESTERS: `${npub} ${short} ${B}` }))
    expect([...set]).toEqual([B])
    expect(console.warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls)
    expect(logged).not.toContain(npub)
    expect(logged).not.toContain(short)
    expect(logged).toContain('2')
  })

  it('warns once for a repeated malformed list', () => {
    const value = `tester-memo-once ${A}`
    confirmationTesters(env({ CONFIRMATION_TESTERS: value }))
    confirmationTesters(env({ CONFIRMATION_TESTERS: value }))
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('has no testers when unset', () => {
    expect(confirmationTesters(env({})).size).toBe(0)
  })
})
