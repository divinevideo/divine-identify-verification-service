// ABOUTME: Maps the names the old site used (platform "x", method "proof-post") and
// ABOUTME: decides when two spellings of a handle are the same account. Pure: never fetches.

import type { VerificationMethod } from '../identity-link'
import type { Platform, VerifyResult } from '../types'
import { tidyClaim } from '../utils/tidy-claim'
import { VALID_PLATFORMS } from '../utils/validation'

// Platforms the old site listed but this service doesn't verify. They are named
// so the old endpoints can answer them explicitly rather than as unknown input.
const UNSUPPORTED_OLD_PLATFORMS = ['instagram', 'snapchat']

export function oldPlatformName(platform: Platform): string {
  return platform === 'twitter' ? 'x' : platform
}

export function parseOldPlatform(input: string | undefined): Platform | 'not_supported' | null {
  const name = (input ?? '').trim().toLowerCase()
  if (!name) return null
  if (name === 'x' || name === 'twitter') return 'twitter'
  if ((VALID_PLATFORMS as readonly string[]).includes(name)) return name as Platform
  if (UNSUPPORTED_OLD_PLATFORMS.includes(name)) return 'not_supported'
  return null
}

export function oldMethod(method: VerificationMethod | undefined): 'oauth' | 'proof-post' | 'identity_link' {
  // The old site called a proof post "proof-post"; a claim with no method was one.
  if (method === 'oauth') return 'oauth'
  if (method === 'identity_link') return 'identity_link'
  return 'proof-post'
}

export function couldNotCheck(result: VerifyResult): boolean {
  return result.code === 'temporarily_unavailable'
}

// YouTube channel IDs are case-sensitive, so they are the one identity kept as sent.
const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/

function keepsCase(platform: Platform, tidied: string): boolean {
  return platform === 'youtube' && YOUTUBE_CHANNEL_ID.test(tidied)
}

export function accountKey(platform: Platform, identity: string): string {
  const tidied = tidyClaim(platform, identity, '').identity
  return keepsCase(platform, tidied) ? tidied : tidied.toLowerCase()
}

// Tags are stored per spelling, so a lookup can find an account however it was
// typed. Lowercased forms are added only where accountKey lowercases, since
// otherwise they would name a different account.
export function tagSpellings(platform: Platform, identities: string[]): string[] {
  const spellings: string[] = []
  for (const identity of identities) {
    const tidied = tidyClaim(platform, identity, '').identity
    const forms = [identity, tidied]
    if (!keepsCase(platform, tidied)) forms.push(identity.toLowerCase(), tidied.toLowerCase())
    for (const form of forms) {
      const tag = `${platform}:${form}`
      if (!spellings.includes(tag)) spellings.push(tag)
    }
  }
  return spellings
}
