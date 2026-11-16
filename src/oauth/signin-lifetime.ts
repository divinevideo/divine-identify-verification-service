// ABOUTME: How long a sign-in record counts, decided from when it was saved: a confirmed
// ABOUTME: Bluesky record with its DID until it is unlinked, other confirmed records 30 days, unconfirmed a day.
import type { OAuthVerification } from '../types'

/** How long a confirmed sign-in link lasts, except a Bluesky one saved with its DID, which is kept until unlinked. */
export const FIXED_SIGNIN_LIFETIME_DAYS = 30

/** How long an unconfirmed sign-in counts, where unconfirmed sign-ins count at all. */
export const UNCONFIRMED_SIGNIN_LIFETIME_SECONDS = 24 * 60 * 60

const DAY_SECONDS = 24 * 60 * 60

/**
 * Whether a record is kept until its owner unlinks it: a confirmed Bluesky one
 * saved with the account's DID. Without the DID the account can't be checked
 * (signin-account.ts), so keeping the record forever would keep a link nobody
 * can verify, and it ends at 30 days like other platforms'.
 */
export function keepsUntilUnlinked(record: OAuthVerification): boolean {
  return record.platform === 'bluesky' && record.confirmed === true && !!record.account_id
}

/**
 * Whether a sign-in record still counts at `nowSeconds`. A record that
 * keepsUntilUnlinked counts at any age. Other confirmed records last
 * FIXED_SIGNIN_LIFETIME_DAYS from when they were saved, and an unconfirmed one
 * a day. A record without a numeric `checked_at` can't show its age, so it
 * doesn't count.
 */
export function signInIsCurrent(record: OAuthVerification, nowSeconds: number): boolean {
  if (typeof record.checked_at !== 'number' || !Number.isFinite(record.checked_at)) return false
  if (record.confirmed === true) {
    if (keepsUntilUnlinked(record)) return true
    return nowSeconds - record.checked_at <= FIXED_SIGNIN_LIFETIME_DAYS * DAY_SECONDS
  }
  return nowSeconds - record.checked_at <= UNCONFIRMED_SIGNIN_LIFETIME_SECONDS
}
