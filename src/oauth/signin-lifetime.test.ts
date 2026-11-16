import { describe, it, expect } from 'vitest'
import type { OAuthVerification } from '../types'
import {
  FIXED_SIGNIN_LIFETIME_DAYS,
  UNCONFIRMED_SIGNIN_LIFETIME_SECONDS,
  signInIsCurrent,
} from './signin-lifetime'

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
  it('gives confirmed links 30 days and unconfirmed sign-ins a day', () => {
    expect(FIXED_SIGNIN_LIFETIME_DAYS).toBe(30)
    expect(UNCONFIRMED_SIGNIN_LIFETIME_SECONDS).toBe(DAY)
  })
})

describe('whether a sign-in record is current', () => {
  it.each([
    ['confirmed TikTok, 29 days', true, record('tiktok', 29 * DAY, confirmed)],
    ['confirmed TikTok, exactly 30 days', true, record('tiktok', 30 * DAY, confirmed)],
    ['confirmed TikTok, 30 days and a second', false, record('tiktok', 30 * DAY + 1, confirmed)],
    ['confirmed Bluesky with a DID, 400 days', false, record('bluesky', 400 * DAY, withDid)],
    ['confirmed Bluesky without a DID, 31 days', false, record('bluesky', 31 * DAY, confirmed)],
    ['unconfirmed TikTok, a day and a second', false, record('tiktok', DAY + 1)],
    ['unconfirmed Bluesky with a DID, a day and a second', false, record('bluesky', DAY + 1, { account_id: withDid.account_id })],
    ['unconfirmed Twitter, exactly a day', true, record('twitter', DAY)],
    ['confirmed Twitter, 31 days', false, record('twitter', 31 * DAY, { ...confirmed, account_id: 'acct-1' })],
    ['confirmed YouTube, 31 days', false, record('youtube', 31 * DAY, { ...confirmed, account_id: 'acct-1' })],
  ])('%s: current is %s', (_label, expected, rec) => {
    expect(signInIsCurrent(rec, NOW)).toBe(expected)
  })

  it.each([
    ['missing', undefined],
    ['a string', String(NOW)],
    ['null', null],
    ['not a number', NaN],
    ['infinite', Infinity],
  ])('does not count a confirmed record whose checked_at is %s, without throwing', (_label, checkedAt) => {
    const rec = { ...record('tiktok', 0, confirmed), checked_at: checkedAt } as unknown as OAuthVerification
    expect(() => signInIsCurrent(rec, NOW)).not.toThrow()
    expect(signInIsCurrent(rec, NOW)).toBe(false)
  })

  it('does not count an unconfirmed record without a checked_at', () => {
    const rec = { ...record('bluesky', 0, { account_id: withDid.account_id }), checked_at: undefined } as unknown as OAuthVerification
    expect(signInIsCurrent(rec, NOW)).toBe(false)
  })

  it('counts a confirmed Bluesky record with a DID for 30 days, then not', () => {
    expect(signInIsCurrent(record('bluesky', 30 * DAY, withDid), NOW)).toBe(true)
    expect(signInIsCurrent(record('bluesky', 30 * DAY + 1, withDid), NOW)).toBe(false)
    const undated = { ...record('bluesky', 0, withDid), checked_at: undefined } as unknown as OAuthVerification
    expect(signInIsCurrent(undated, NOW)).toBe(false)
  })
})

describe('the README states the fixed lifetime', () => {
  it('states FIXED_SIGNIN_LIFETIME_DAYS for sign-in links', async () => {
    const { readFileSync } = await import('node:fs' as string) as { readFileSync: (path: string, encoding: string) => string }
    const readme = readFileSync('README.md', 'utf8')
    expect(readme).toContain(`and lasts ${FIXED_SIGNIN_LIFETIME_DAYS} days from then`)
    expect(readme).toContain('stops counting once the handle points to another account or no longer resolves')
    expect(readme).toContain("the link keeps counting). A claim of the account's DID must match the DID saved at sign-in. For a claim by handle or by DID, the account's host is also asked whether the account is still active, and a deleted, deactivated, suspended or taken-down account stops counting. That answer is reused for up to an hour (five minutes for an inactive account), and while the host can't answer, the link keeps counting and the host is asked again after a minute.")
    expect(readme).not.toContain('without asking Bluesky')
    expect(readme).not.toMatch(/no fixed lifetime|re-checked at each verification/)
    expect(readme).not.toMatch(/until (it is )?unlinked/)
  })
})
