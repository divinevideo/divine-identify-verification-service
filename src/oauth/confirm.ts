// ABOUTME: Owner confirmation of sign-in links (#113): the settings, the
// ABOUTME: start check, the one-time code and the value that binds them.
import type { Bindings } from '../types'
import { base64url, generateRandomString } from './crypto'

// A sign-in waits this long for its owner to confirm it.
export const CONFIRM_TTL_SECONDS = 600

export type SignInConfirmationMode = 'optional' | 'required'

// Until the switch is set to required, sign-ins from app versions that can't
// confirm still count for a day.
// TODO(#113): remove once SIGNIN_CONFIRMATION is "required".
export function signInConfirmationMode(env: Bindings): SignInConfirmationMode {
  return env.SIGNIN_CONFIRMATION === 'required' ? 'required' : 'optional'
}

export type ConfirmCodePlacement = 'fragment' | 'query'

// After the # by default: browsers don't send it to servers.
export function confirmCodePlacement(env: Bindings): ConfirmCodePlacement {
  return env.SIGNIN_CODE_PLACEMENT === 'query' ? 'query' : 'fragment'
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/

/** Start secrets, start checks and codes are 32 bytes as 43 base64url characters. */
export function isSignInToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = await sha256(text)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Hashes take the 43-character strings, not the raw bytes, so every client
// computes the same values from what it stores.
export async function startCheckFor(startSecret: string): Promise<string> {
  return base64url(await sha256('divine-signin-start:' + startSecret))
}

export async function confirmBindingFor(code: string, startCheck: string): Promise<string> {
  return base64url(await sha256('divine-signin-confirm:' + code + ':' + startCheck))
}

export function newConfirmCode(): string {
  return generateRandomString(32)
}

/** Compares two strings in time that doesn't depend on where they differ. */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
