// ABOUTME: How long a sign-in record counts, decided from when it was saved,
// ABOUTME: so the lifetimes apply to records already saved when they change.
import type { Bindings, OAuthVerification } from '../types'

/** How long a confirmed link lasts when the verifier can't re-check its account at each verification. */
export const FIXED_SIGNIN_LIFETIME_DAYS = 30

/** How long an unconfirmed sign-in counts, where unconfirmed sign-ins count at all. */
export const UNCONFIRMED_SIGNIN_LIFETIME_SECONDS = 24 * 60 * 60

const DAY_SECONDS = 24 * 60 * 60

/**
 * Whether the verifier re-checks, at every verification, that a linked account
 * is still the one that signed in. Bluesky does: a handle is checked against
 * the account's DID.
 */
export function hasAccountRecheck(env: Bindings, platform: string): boolean {
  return platform === 'bluesky'
}

/**
 * How many days a confirmed link on this platform lasts, or null when it counts
 * while the account still matches.
 */
export function fixedLifetimeDays(env: Bindings, platform: string): number | null {
  return hasAccountRecheck(env, platform) ? null : FIXED_SIGNIN_LIFETIME_DAYS
}

/**
 * Whether a record is a confirmed link the verifier re-checks at every
 * verification, which counts while the account still matches.
 */
export function isRecheckedLink(env: Bindings, record: OAuthVerification): boolean {
  return record.confirmed === true && !!record.account_id && hasAccountRecheck(env, record.platform)
}

/**
 * Whether a sign-in record still counts at `nowSeconds`. A re-checked link
 * counts here whatever its age; the account check happens when it is verified.
 * Any other confirmed record lasts FIXED_SIGNIN_LIFETIME_DAYS from when it was
 * saved, and an unconfirmed one a day. A record without a numeric `checked_at`
 * can't show its age, so only a re-checked link counts without one.
 */
export function signInIsCurrent(env: Bindings, record: OAuthVerification, nowSeconds: number): boolean {
  if (isRecheckedLink(env, record)) return true
  const confirmed = record.confirmed === true
  if (typeof record.checked_at !== 'number' || !Number.isFinite(record.checked_at)) return false
  const lifetimeSeconds = confirmed ? FIXED_SIGNIN_LIFETIME_DAYS * DAY_SECONDS : UNCONFIRMED_SIGNIN_LIFETIME_SECONDS
  return nowSeconds - record.checked_at <= lifetimeSeconds
}
