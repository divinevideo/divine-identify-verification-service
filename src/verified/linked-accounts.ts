import type { VerifyClaim } from '../types'
import { asSignedEvent, verifyEventSignature, type SignedNostrEvent } from '../utils/nostr-event'
import { queryRelay } from '../utils/relay'
import { validateClaim, VALID_PLATFORMS } from '../utils/validation'

export const DIVINE_RELAY = 'wss://relay.divine.video'
export const PROFILE_RELAYS = [DIVINE_RELAY, 'wss://relay.damus.io', 'wss://relay.primal.net'] as const

// NIP-01: of two copies of a replaceable event, the later created_at wins, and on a tie the lowest id.
function newerEvent(a: SignedNostrEvent | null, b: SignedNostrEvent): SignedNostrEvent {
  if (!a) return b
  return b.created_at > a.created_at || (b.created_at === a.created_at && b.id < a.id) ? b : a
}

async function usableEvent(raw: unknown, pubkey: string): Promise<SignedNostrEvent | null> {
  const event = asSignedEvent(raw, [0, 10011])
  if (!event || event.pubkey !== pubkey) return null
  return (await verifyEventSignature(event)).ok ? event : null
}

/**
 * Reads a person's linked accounts the way the verifier's own pages do. Relays can each
 * hold a different copy, so ask them all at once and keep the newest identity event, or
 * for profiles from before it, the newest kind 0 profile. `read` is true only when
 * Divine's relay answered and everything it sent passed the checks; the other relays can
 * supply a newer copy but can't stand in for it.
 */
export async function readLinkedAccounts(pubkey: string): Promise<{ read: boolean; event: SignedNostrEvent | null }> {
  const filters = [{ kinds: [10011], authors: [pubkey], limit: 1 }, { kinds: [0], authors: [pubkey], limit: 1 }]
  const answers = await Promise.all(PROFILE_RELAYS.map(relay => queryRelay(relay, filters).catch(() => null)))
  let read = false
  let identityEvent: SignedNostrEvent | null = null
  let profile: SignedNostrEvent | null = null
  for (let i = 0; i < answers.length; i++) {
    const answer = answers[i]
    if (!answer) continue
    const checked = await Promise.all(answer.map(raw => usableEvent(raw, pubkey)))
    const usable = checked.filter((e): e is SignedNostrEvent => e !== null)
    if (PROFILE_RELAYS[i] === DIVINE_RELAY) read = usable.length === answer.length
    for (const e of usable) {
      if (e.kind === 10011) identityEvent = newerEvent(identityEvent, e)
      else profile = newerEvent(profile, e)
    }
  }
  return { read, event: identityEvent ?? profile }
}

/**
 * The linked accounts on an event, skipping anything that isn't a well-formed
 * ['i', 'platform:identity', proof] tag. Events come from relays, so one malformed entry
 * mustn't hide the others. Claims `/verify` would reject are dropped too, since it never
 * checks them. A tag whose platform prefix is `x:` is skipped, as the verifier's pages skip it.
 */
export function linkedAccountClaims(event: SignedNostrEvent | null, pubkey: string): VerifyClaim[] {
  const claims: VerifyClaim[] = []
  for (const tag of event?.tags ?? []) {
    // Tag values are untrusted at runtime despite the string[][] type, so check before use.
    if (tag[0] !== 'i' || typeof tag[1] !== 'string' || typeof tag[2] !== 'string' || !tag[1] || !tag[2]) continue
    const [platform, ...rest] = tag[1].split(':')
    if (!(VALID_PLATFORMS as readonly string[]).includes(platform)) continue
    const claim = { pubkey, platform, identity: rest.join(':'), proof: tag[2] } as VerifyClaim
    if (validateClaim(claim, claims.length) === null) claims.push(claim)
  }
  return claims
}
