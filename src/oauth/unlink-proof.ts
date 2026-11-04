// ABOUTME: The rules for unlinking a sign-in (#76): whether a signed list is newer
// ABOUTME: than the link and still names the claim, and reading a NIP-98 header.

import { bytesToHex } from '@noble/curves/utils.js'
import type { OAuthPlatform, OAuthVerification } from '../types'
import type { SignedNostrEvent } from '../utils/nostr-event'
import { tidyClaim } from '../utils/tidy-claim'

/**
 * Whether a list comes after the link, in NIP-01's order for replaceable
 * events: the later created_at wins, and on the same second the lower id. A
 * record never confirmed has no confirming event, so the list must be dated
 * after the record was saved.
 */
export function listIsNewerThanLink(list: Pick<SignedNostrEvent, 'id' | 'created_at'>, record: OAuthVerification): boolean {
  if (typeof record.confirm_created_at === 'number' && typeof record.confirm_event_id === 'string') {
    return list.created_at > record.confirm_created_at
      || (list.created_at === record.confirm_created_at && list.id < record.confirm_event_id)
  }
  return list.created_at > record.checked_at
}

function sameForm(platform: OAuthPlatform, identity: string): string {
  return tidyClaim(platform, identity, '').identity.toLowerCase()
}

// A tag's platform as the verifier names it. Clients read an `x:` tag as
// Twitter, so it names the same claim.
function tagPlatform(raw: string): string {
  const name = raw.trim().toLowerCase()
  return name === 'x' ? 'twitter' : name
}

/**
 * Whether the list still names the claim under any identity the link was saved
 * by. A Bluesky link is saved by handle and by DID, so either one listed keeps
 * it. Both sides are compared tidied and lowercased, so a listed variant of the
 * same account (a leading @, a channel link) still holds the claim.
 */
export function listHoldsClaim(list: SignedNostrEvent, platform: OAuthPlatform, identity: string, record: OAuthVerification): boolean {
  const saved = [identity, record.identity]
  if (platform === 'bluesky') {
    if (record.handle) saved.push(record.handle)
    if (record.account_id) saved.push(record.account_id)
  }
  const forms = new Set(saved.map(id => sameForm(platform, id)))
  return list.tags.some(tag => {
    const value = tag[0] === 'i' ? tag[1] : undefined
    if (typeof value !== 'string') return false
    const colon = value.indexOf(':')
    if (colon === -1) return false
    if (tagPlatform(value.slice(0, colon)) !== platform) return false
    return forms.has(sameForm(platform, value.slice(colon + 1)))
  })
}

export type NostrAuthorization = { kind: 'absent' } | { kind: 'malformed' } | { kind: 'event'; event: unknown }

/**
 * The event in a NIP-98 `Authorization: Nostr <base64>` header. No header, or
 * another scheme, is absent; a Nostr header that doesn't decode to JSON is
 * malformed. The event itself is checked by the caller.
 */
export function readNostrAuthorization(header: string | undefined): NostrAuthorization {
  if (header === undefined) return { kind: 'absent' }
  const [, scheme, token] = header.trim().match(/^(\S+)(?:\s+(.*))?$/s) ?? []
  if (!scheme || scheme.toLowerCase() !== 'nostr') return { kind: 'absent' }
  if (!token) return { kind: 'malformed' }
  try {
    const binary = atob(token)
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    return { kind: 'event', event: JSON.parse(text) }
  } catch {
    return { kind: 'malformed' }
  }
}

/** The SHA-256 of the bytes as lowercase hex, the form of NIP-98's payload tag. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}
