// ABOUTME: Owner confirmation of sign-in links (#113): the settings, the
// ABOUTME: start check, the one-time code and the value that binds them.
import type { Bindings, OAuthPlatform } from '../types'
import { base64url, generateRandomString } from './crypto'

// A sign-in waits this long for its owner to confirm it.
export const CONFIRM_TTL_SECONDS = 600

export type SignInConfirmationMode = 'optional' | 'required'

// Until the switch is set to required, sign-ins from app versions that can't
// confirm still count for a day.
// TODO(#113): remove once SIGNIN_CONFIRMATION is "required".
export function signInConfirmationMode(env: Bindings): SignInConfirmationMode {
  const setting = env.SIGNIN_CONFIRMATION
  // Unset (as in tests) counts unconfirmed sign-ins; wrangler.toml sets it.
  if (setting === undefined) return 'optional'
  const mode = setting.trim().toLowerCase()
  if (mode === 'optional' || mode === 'required') return mode
  // Any other value, empty included, counts only confirmed sign-ins.
  console.warn(`SIGNIN_CONFIRMATION is ${JSON.stringify(setting)}, not "optional" or "required"; treating it as required`)
  return 'required'
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

/** The account a provider confirmed for a sign-in. */
export interface SignedInAccount {
  platform: OAuthPlatform
  identity: string
  // The provider's permanent account ID. Bluesky's (the DID) also comes with
  // the handle, so its link is saved under both.
  account_id?: string
  handle?: string
}

/** A finished sign-in waiting for its owner to confirm it. */
export interface PendingSignIn extends SignedInAccount {
  pubkey: string
  // Absent for a sign-in started without one, which can never be confirmed.
  startCheck?: string
  finishedAt: number
}

/** Which event confirmed a code, so the same event sent again gets the same answer. */
export interface UsedCode {
  event_id: string
  platform: OAuthPlatform
  identity: string
}

// Only a hash of the code is ever stored, so a KV listing reveals nothing usable.
const pendingKey = async (code: string) => `oauth_pending:${await sha256Hex(code)}`
const usedKey = async (code: string) => `oauth_confirmed:${await sha256Hex(code)}`

async function readJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function storePendingSignIn(kv: KVNamespace, code: string, pending: PendingSignIn): Promise<void> {
  await kv.put(await pendingKey(code), JSON.stringify(pending), { expirationTtl: CONFIRM_TTL_SECONDS })
}

export async function getPendingSignIn(kv: KVNamespace, code: string): Promise<PendingSignIn | null> {
  return readJson<PendingSignIn>(kv, await pendingKey(code))
}

export async function deletePendingSignIn(kv: KVNamespace, code: string): Promise<void> {
  await kv.delete(await pendingKey(code))
}

export async function storeUsedCode(kv: KVNamespace, code: string, used: UsedCode): Promise<void> {
  await kv.put(await usedKey(code), JSON.stringify(used), { expirationTtl: CONFIRM_TTL_SECONDS })
}

export async function getUsedCode(kv: KVNamespace, code: string): Promise<UsedCode | null> {
  return readJson<UsedCode>(kv, await usedKey(code))
}
