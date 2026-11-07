import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'

export interface SignedNostrEvent {
  id: string
  pubkey: string
  sig: string
  kind: number
  tags: string[][]
  created_at: number
  content: string
}

export const LINKED_ACCOUNTS_MAX_SECONDS_AHEAD = 600

// An event of one of `kinds` with the shape NIP-01 requires, or null.
export function asSignedEvent(raw: unknown, kinds: readonly number[]): SignedNostrEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.id !== 'string' || typeof e.pubkey !== 'string' || typeof e.sig !== 'string') return null
  if (typeof e.kind !== 'number' || !kinds.includes(e.kind) || typeof e.content !== 'string') return null
  if (typeof e.created_at !== 'number' || !Number.isInteger(e.created_at)) return null
  if (!Array.isArray(e.tags) || !e.tags.every(t => Array.isArray(t) && t.every(v => typeof v === 'string'))) return null
  return { id: e.id, pubkey: e.pubkey, sig: e.sig, kind: e.kind, created_at: e.created_at, content: e.content, tags: e.tags as string[][] }
}

// A kind 10011 with the shape NIP-01 requires, or null.
export function asLinkedAccountsList(raw: unknown): SignedNostrEvent | null {
  return asSignedEvent(raw, [10011])
}

const HEX_64 = /^[0-9a-f]{64}$/
const HEX_128 = /^[0-9a-f]{128}$/

/** NIP-01 encodes id and pubkey as 32-byte and sig as 64-byte lowercase hex. */
function hasLowercaseHexFields(event: { id: string; pubkey: string; sig: string }): boolean {
  return HEX_64.test(event.id) && HEX_64.test(event.pubkey) && HEX_128.test(event.sig)
}

/**
 * Checks that a Nostr event is internally consistent and signed by its pubkey:
 * the id must be the NIP-01 hash of the event's contents, and the signature a
 * valid BIP-340 Schnorr signature over that id by `pubkey`. NIP-01 requires
 * lowercase hex for id, pubkey and sig, so other casings are rejected ('format')
 * rather than normalized.
 */
export async function verifyEventSignature(
  event: SignedNostrEvent,
): Promise<{ ok: true } | { ok: false; reason: 'format' | 'id' | 'signature' }> {
  if (!hasLowercaseHexFields(event)) {
    return { ok: false, reason: 'format' }
  }

  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
  if (bytesToHex(new Uint8Array(digest)) !== event.id) {
    return { ok: false, reason: 'id' }
  }

  try {
    const valid = schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey))
    return valid ? { ok: true } : { ok: false, reason: 'signature' }
  } catch {
    // Unreachable with @noble/curves 2.4.0 once the format check has passed (verify only
    // throws on wrong byte lengths). Kept so a future library change fails closed.
    return { ok: false, reason: 'signature' }
  }
}
