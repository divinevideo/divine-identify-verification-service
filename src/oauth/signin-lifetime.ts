// ABOUTME: How long a sign-in record counts, decided from when it was saved: a confirmed
// ABOUTME: Bluesky record until it is unlinked, other confirmed records 30 days, unconfirmed a day.
import type { OAuthVerification } from '../types'

/** How long a confirmed sign-in link lasts, except a Bluesky one, which is kept until unlinked. */
export const FIXED_SIGNIN_LIFETIME_DAYS = 30

/** How long an unconfirmed sign-in counts, where unconfirmed sign-ins count at all. */
export const UNCONFIRMED_SIGNIN_LIFETIME_SECONDS = 24 * 60 * 60

const DAY_SECONDS = 24 * 60 * 60

/**
 * Whether a sign-in record still counts at `nowSeconds`. A confirmed Bluesky
 * record lasts until it is unlinked, so its age doesn't matter. Other confirmed
 * records last FIXED_SIGNIN_LIFETIME_DAYS from when it was saved, and an
 * unconfirmed one a day. A record without a numeric `checked_at` can't show its age, so it
 * doesn't count.
 */
export function signInIsCurrent(record: OAuthVerification, nowSeconds: number): boolean {
  if (typeof record.checked_at !== 'number' || !Number.isFinite(record.checked_at)) return false
  if (record.confirmed === true) {
    if (record.platform === 'bluesky') return true
    return nowSeconds - record.checked_at <= FIXED_SIGNIN_LIFETIME_DAYS * DAY_SECONDS
  }
  return nowSeconds - record.checked_at <= UNCONFIRMED_SIGNIN_LIFETIME_SECONDS
}
