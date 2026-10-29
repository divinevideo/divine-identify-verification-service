import { describe, it, expect } from 'vitest'
import type { Bindings, OAuthVerification } from '../types'
import {
  FIXED_SIGNIN_LIFETIME_DAYS,
  UNCONFIRMED_SIGNIN_LIFETIME_SECONDS,
  fixedLifetimeDays,
  hasAccountRecheck,
  signInIsCurrent,
} from './signin-lifetime'

const env = {} as Bindings
const NOW = 1_800_000_000
const DAY = 24 * 60 * 60
const PUBKEY = 'ab'.repeat(32)

function record(platform: OAuthVerification['platform'], ageSeconds: number, extra: Record<string, unknown> = {}): OAuthVerification {
  return {
    platform, identity: 'creator', pubkey: PUBKEY, verified: true, method: 'oauth',
    checked_at: NOW - ageSeconds, ...extra,
  } as OAuthVerification
}
const confirmed = { confirmed: true }
const withDid = { confirmed: true, account_id: 'did:plc:alice111111111111111111' }

describe('the sign-in lifetime constants', () => {
  it('gives fixed-lifetime links 30 days and unconfirmed sign-ins a day', () => {
    expect(FIXED_SIGNIN_LIFETIME_DAYS).toBe(30)
    expect(UNCONFIRMED_SIGNIN_LIFETIME_SECONDS).toBe(DAY)
  })
})

describe('whether a sign-in record is current', () => {
  it.each([
    ['confirmed TikTok, 29 days', true, record('tiktok', 29 * DAY, confirmed)],
    ['confirmed TikTok, exactly 30 days', true, record('tiktok', 30 * DAY, confirmed)],
    ['confirmed TikTok, 30 days and a second', false, record('tiktok', 30 * DAY + 1, confirmed)],
    ['confirmed Bluesky with a DID, 400 days', true, record('bluesky', 400 * DAY, withDid)],
    ['confirmed Bluesky without a DID, 31 days', false, record('bluesky', 31 * DAY, confirmed)],
    ['unconfirmed TikTok, a day and a second', false, record('tiktok', DAY + 1)],
    ['unconfirmed Bluesky with a DID, a day and a second', false, record('bluesky', DAY + 1, { account_id: withDid.account_id })],
    ['unconfirmed Twitter, exactly a day', true, record('twitter', DAY)],
    ['confirmed Twitter, 31 days', false, record('twitter', 31 * DAY, { ...confirmed, account_id: 'acct-1' })],
    ['confirmed YouTube, 31 days', false, record('youtube', 31 * DAY, { ...confirmed, account_id: 'acct-1' })],
  ])('%s: current is %s', (_label, expected, rec) => {
    expect(signInIsCurrent(env, rec, NOW)).toBe(expected)
  })

  it.each([
    ['missing', undefined],
    ['a string', String(NOW)],
    ['null', null],
    ['not a number', NaN],
    ['infinite', Infinity],
  ])('does not count a fixed-lifetime record whose checked_at is %s, without throwing', (_label, checkedAt) => {
    const rec = { ...record('tiktok', 0, confirmed), checked_at: checkedAt } as unknown as OAuthVerification
    expect(() => signInIsCurrent(env, rec, NOW)).not.toThrow()
    expect(signInIsCurrent(env, rec, NOW)).toBe(false)
  })

  it('does not count an unconfirmed record without a checked_at', () => {
    const rec = { ...record('bluesky', 0, { account_id: withDid.account_id }), checked_at: undefined } as unknown as OAuthVerification
    expect(signInIsCurrent(env, rec, NOW)).toBe(false)
  })

  it('counts a confirmed Bluesky record with a DID whatever its checked_at, since it lasts until unlinked', () => {
    const rec = { ...record('bluesky', 0, withDid), checked_at: undefined } as unknown as OAuthVerification
    expect(signInIsCurrent(env, rec, NOW)).toBe(true)
  })
})

describe('which platforms re-check the linked account', () => {
  it('re-checks Bluesky only', () => {
    expect(hasAccountRecheck(env, 'bluesky')).toBe(true)
    for (const platform of ['twitter', 'youtube', 'tiktok']) expect(hasAccountRecheck(env, platform)).toBe(false)
  })

  it('gives Bluesky links no fixed lifetime and TikTok links 30 days', () => {
    expect(fixedLifetimeDays(env, 'bluesky')).toBeNull()
    expect(fixedLifetimeDays(env, 'tiktok')).toBe(30)
  })
})
