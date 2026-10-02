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
