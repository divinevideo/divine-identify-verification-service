// ABOUTME: Ties a sign-in to the browser that started it: a short-lived cookie
// ABOUTME: set at start, checked when the sign-in finishes. Spec: PR description.
import type { Bindings, OAuthState, OAuthVerification } from '../types'

export const BINDING_COOKIE = '__Host-signin_binding'
const ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Lax'

export type SignInBindingMode = 'observe' | 'enforce'

// TODO(#113): drop observe mode once enforce has been on for a while.
export function signInBindingMode(env: Bindings): SignInBindingMode {
  return env.SIGNIN_BINDING === 'enforce' ? 'enforce' : 'observe'
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function hashBinding(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

export async function createBinding(): Promise<{ value: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return { value, hash: await hashBinding(value) }
}

// Compares hashes, which are always 64 hex characters, in time that doesn't
// depend on where they differ. (Workers' timingSafeEqual isn't in Node's tests.)
export async function bindingMatches(expectedHash: string | undefined, cookieValue: string | undefined): Promise<boolean> {
  if (!expectedHash || !cookieValue) return false
  const actual = await hashBinding(cookieValue)
  if (actual.length !== expectedHash.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expectedHash.charCodeAt(i)
  return diff === 0
}

export async function checkSignInBinding(
  env: Bindings,
  state: OAuthState,
  cookieValue: string | undefined,
): Promise<{ bound: boolean; refuse: boolean }> {
  const bound = await bindingMatches(state.bindingHash, cookieValue)
  return { bound, refuse: !bound && signInBindingMode(env) === 'enforce' }
}

export function bindingSetCookie(value: string): string {
  return `${BINDING_COOKIE}=${value}; Max-Age=600; ${ATTRIBUTES}`
}

export const BINDING_CLEAR_COOKIE = `${BINDING_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`

// In enforce mode only a sign-in finished in the browser that started it
// counts, including over records written before binding existed.
export function countsAsSignedIn(env: Bindings, record: OAuthVerification): boolean {
  return signInBindingMode(env) === 'observe' || record.bound === true
}
