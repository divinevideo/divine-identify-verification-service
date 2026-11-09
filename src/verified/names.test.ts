import { describe, expect, it } from 'vitest'
import { accountKey, couldNotCheck, oldMethod, oldPlatformName, parseOldPlatform, tagSpellings } from './names'
import { tidyClaim } from '../utils/tidy-claim'
import type { VerifyResult } from '../types'

describe('oldPlatformName', () => {
  it('names twitter as x and leaves the other platforms alone', () => {
    expect(oldPlatformName('twitter')).toBe('x')
    expect(oldPlatformName('github')).toBe('github')
    expect(oldPlatformName('youtube')).toBe('youtube')
  })
})

describe('parseOldPlatform', () => {
  it.each([
    ['x', 'twitter'],
    ['X', 'twitter'],
    ['Twitter', 'twitter'],
    [' x ', 'twitter'],
    ['github', 'github'],
    ['  Bluesky ', 'bluesky'],
    ['instagram', 'not_supported'],
    ['snapchat', 'not_supported'],
    ['myspace', null],
    ['', null],
    ['   ', null],
  ])('reads %j as %j', (input, expected) => {
    expect(parseOldPlatform(input)).toBe(expected)
  })

  it('reads a missing platform as null', () => {
    expect(parseOldPlatform(undefined)).toBeNull()
  })
})

describe('oldMethod', () => {
  it.each([
    ['proof_post', 'proof-post'],
    ['oauth', 'oauth'],
    ['identity_link', 'identity_link'],
    [undefined, 'proof-post'],
  ])('maps %j to %j', (method, expected) => {
    expect(oldMethod(method as 'proof_post' | 'oauth' | 'identity_link' | undefined)).toBe(expected)
  })
})

describe('couldNotCheck', () => {
  const result = (code?: VerifyResult['code']): VerifyResult => ({
    platform: 'github',
    identity: 'alice',
    verified: false,
    code,
    checked_at: 0,
    cached: false,
  })

  it('is true only for a check that could not run right now', () => {
    expect(couldNotCheck(result('temporarily_unavailable'))).toBe(true)
    expect(couldNotCheck(result('discord_npub_not_in_message'))).toBe(false)
    expect(couldNotCheck(result(undefined))).toBe(false)
  })
})

describe('accountKey', () => {
  it('matches the same twitter account across an @ and a case difference', () => {
    expect(accountKey('twitter', '@Jack')).toBe(accountKey('twitter', 'jack'))
  })

  it('keeps a YouTube channel ID case-sensitive', () => {
    expect(accountKey('youtube', 'UCabcdefghijklmnopqrstuv')).not.toBe(accountKey('youtube', 'UCABCDEFGHIJKLMNOPQRSTUV'))
    expect(accountKey('youtube', 'UCabcdefghijklmnopqrstuv')).toBe('UCabcdefghijklmnopqrstuv')
  })

  it('lowercases a YouTube handle', () => {
    expect(accountKey('youtube', '@Alice')).toBe('@alice')
  })
})

describe('tagSpellings', () => {
  it('gives the spellings of one account, each once, in first-seen order', () => {
    // Confirmed against tidyClaim: '@Jack' tidies to 'Jack'.
    expect(tidyClaim('twitter', '@Jack', '').identity).toBe('Jack')
    expect(tagSpellings('twitter', ['@Jack'])).toEqual(['twitter:@Jack', 'twitter:Jack', 'twitter:@jack', 'twitter:jack'])
  })

  it('drops a spelling that repeats across identities', () => {
    expect(tagSpellings('twitter', ['jack', 'Jack'])).toEqual(['twitter:jack', 'twitter:Jack'])
  })

  it('keeps a YouTube channel ID spelling as given only', () => {
    const id = 'UCabcdefghijklmnopqrstuv'
    expect(tagSpellings('youtube', [id])).toEqual([`youtube:${id}`])
  })
})
