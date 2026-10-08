// ABOUTME: Tests the sign-in binding: the cookie value, its stored hash, the
// ABOUTME: comparison, the cookie headers, and observe/enforce decisions.
import { describe, it, expect } from 'vitest'
import type { Bindings, OAuthState, OAuthVerification } from '../types'
import {
  BINDING_CLEAR_COOKIE, bindingMatches, bindingSetCookie, checkSignInBinding,
  countsAsSignedIn, createBinding, signInBindingMode,
} from './binding'

const env = (mode?: string) => ({ SIGNIN_BINDING: mode } as unknown as Bindings)
const state = (bindingHash?: string) => ({ platform: 'twitter', pubkey: 'a'.repeat(64), codeVerifier: 'v', returnUrl: '/', createdAt: 0, bindingHash } as OAuthState)
const record = (bound?: boolean) => ({ platform: 'twitter', identity: 'jack', pubkey: 'a'.repeat(64), verified: true, method: 'oauth', checked_at: 0, bound } as OAuthVerification)

describe('createBinding', () => {
  it('makes a 32-byte base64url value and the hex SHA-256 of it', async () => {
    const { value, hash } = await createBinding()
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    expect(hash).toBe([...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''))
  })

  it('makes a different value each time', async () => {
    expect((await createBinding()).value).not.toBe((await createBinding()).value)
  })
})

describe('bindingMatches', () => {
  it('matches the cookie whose hash was stored', async () => {
    const { value, hash } = await createBinding()
    expect(await bindingMatches(hash, value)).toBe(true)
  })

  it.each([
    ['no cookie', undefined, undefined],
    ['an empty cookie', '', undefined],
    ['a cookie one character off', 'CHANGED', undefined],
    ['a malformed cookie', '%%%not base64%%%', undefined],
    ['a very long cookie', 'a'.repeat(4096), undefined],
  ])('refuses %s', async (_label, cookie, _) => {
    const { value, hash } = await createBinding()
    const sent = cookie === 'CHANGED' ? value.slice(0, -1) + (value.endsWith('A') ? 'B' : 'A') : cookie
    expect(await bindingMatches(hash, sent)).toBe(false)
  })

  it('refuses when no hash was stored (a sign-in started before this change)', async () => {
    const { value } = await createBinding()
    expect(await bindingMatches(undefined, value)).toBe(false)
  })

  it('refuses when the stored hash is too long (right prefix but extra chars)', async () => {
    const { value, hash } = await createBinding()
    expect(await bindingMatches(hash + '00', value)).toBe(false)
  })

  it('refuses when the stored hash is too short', async () => {
    const { value, hash } = await createBinding()
    expect(await bindingMatches(hash.slice(0, 63), value)).toBe(false)
  })
})

describe('cookie headers', () => {
  it('sets the binding cookie for this host only, for ten minutes, out of scripts\' reach', () => {
    expect(bindingSetCookie('abc')).toBe('__Host-signin_binding=abc; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax')
  })

  it('clears it with the same attributes', () => {
    expect(BINDING_CLEAR_COOKIE).toBe('__Host-signin_binding=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax')
  })
})

describe('modes', () => {
  it.each([[undefined, 'observe'], ['observe', 'observe'], ['enforce', 'enforce'], ['ENFORCE', 'observe'], ['yes', 'observe']])(
    'SIGNIN_BINDING=%s means %s', (value, mode) => {
      expect(signInBindingMode(env(value))).toBe(mode)
    })

  it('observe: a sign-in without the cookie is unbound but allowed', async () => {
    const { hash } = await createBinding()
    expect(await checkSignInBinding(env('observe'), state(hash), undefined)).toEqual({ bound: false, refuse: false })
  })

  it('enforce: a sign-in without the cookie is refused', async () => {
    const { hash } = await createBinding()
    expect(await checkSignInBinding(env('enforce'), state(hash), undefined)).toEqual({ bound: false, refuse: true })
  })

  it('enforce: a sign-in with the cookie is bound', async () => {
    const { value, hash } = await createBinding()
    expect(await checkSignInBinding(env('enforce'), state(hash), value)).toEqual({ bound: true, refuse: false })
  })

  it('observe counts every sign-in record; enforce counts only bound ones', () => {
    expect(countsAsSignedIn(env('observe'), record(undefined))).toBe(true)
    expect(countsAsSignedIn(env('observe'), record(false))).toBe(true)
    expect(countsAsSignedIn(env('enforce'), record(true))).toBe(true)
    expect(countsAsSignedIn(env('enforce'), record(false))).toBe(false)
    expect(countsAsSignedIn(env('enforce'), record(undefined))).toBe(false)
  })
})
