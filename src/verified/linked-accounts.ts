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

export interface LinkedAccountsRead {
  read: boolean
  event: SignedNostrEvent | null
}

/**
 * Reads a person's linked accounts the way the verifier's own pages do. Relays can each
 * hold a different copy, so ask them all at once and keep the newest identity event, or
 * for profiles from before it, the newest kind 0 profile. `read` is true only when
 * Divine's relay answered and everything it sent passed the checks; the other relays can
 * supply a newer copy but can't stand in for it.
 */
export async function readLinkedAccounts(pubkey: string): Promise<LinkedAccountsRead> {
  return (await readLinkedAccountsOf([pubkey])).get(pubkey) ?? { read: false, event: null }
}

/**
 * readLinkedAccounts for several people in one REQ per relay, so a lookup holds three
 * connections rather than three per person. Both kinds are replaceable, so each filter's
 * limit is the number of people asked about; a relay that keeps old copies can still fill
 * it. A pubkey is read only when Divine's relay answered and every event it sent for that
 * pubkey passed the checks. A failing event, even a malformed one, that names a requested
 * pubkey leaves only that pubkey unread; one that names no requested pubkey can't be
 * pinned on anyone, so it leaves every pubkey unread. When Divine's answer for a kind fills the
 * limit, anyone with none of that kind in it may have been left out, so they are unread.
 */
export async function readLinkedAccountsOf(pubkeys: string[]): Promise<Map<string, LinkedAccountsRead>> {
  const wanted = new Set(pubkeys)
  const reads = new Map<string, LinkedAccountsRead>()
  for (const pubkey of wanted) reads.set(pubkey, { read: false, event: null })
  if (wanted.size === 0) return reads

  const authors = [...wanted]
  const filters = [{ kinds: [10011], authors, limit: authors.length }, { kinds: [0], authors, limit: authors.length }]
  const answers = await Promise.all(PROFILE_RELAYS.map(relay => queryRelay(relay, filters).catch(() => null)))
  let divineAnswered = false
  let divineUnattributable = false
  const divineFailed = new Set<string>()
  const divineKinds = new Map<number, Set<string>>([[10011, new Set()], [0, new Set()]])
  const divineSent = new Map<number, number>()
  const identityEvents = new Map<string, SignedNostrEvent>()
  const profiles = new Map<string, SignedNostrEvent>()
  for (let i = 0; i < answers.length; i++) {
    const answer = answers[i]
    if (!answer) continue
    const fromDivine = PROFILE_RELAYS[i] === DIVINE_RELAY
    if (fromDivine) divineAnswered = true
    const shaped = answer.map(raw => asSignedEvent(raw, [0, 10011]))
    if (fromDivine) {
      shaped.forEach((event, j) => {
        // A malformed event still used up a filter's limit; one whose kind can't be read
        // is counted against both, so it can't hide anyone left out.
        const rawKind = (answer[j] as { kind?: unknown } | null)?.kind
        const kinds = event ? [event.kind] : rawKind === 0 || rawKind === 10011 ? [rawKind] : [0, 10011]
        for (const kind of kinds) divineSent.set(kind, (divineSent.get(kind) ?? 0) + 1)
        if (event) divineKinds.get(event.kind)?.add(event.pubkey)
      })
    }
    const signed = await Promise.all(shaped.map(e => (e && wanted.has(e.pubkey) ? verifyEventSignature(e) : null)))
    shaped.forEach((event, j) => {
      if (event && wanted.has(event.pubkey) && signed[j]?.ok) {
        const newest = event.kind === 10011 ? identityEvents : profiles
        newest.set(event.pubkey, newerEvent(newest.get(event.pubkey) ?? null, event))
      } else if (fromDivine) {
        // A malformed event can still name whose it is; only that person is then in doubt.
        const raw = answer[j] as { pubkey?: unknown } | null
        const named = event?.pubkey ?? (raw && typeof raw === 'object' ? raw.pubkey : undefined)
        if (typeof named === 'string' && wanted.has(named)) divineFailed.add(named)
        else divineUnattributable = true
      }
    })
  }
  // The limit is shared, so a full answer for a kind may have left someone out: a
  // person with none of that kind in it can't be told apart from one who has none.
  for (const [kind, authorsSeen] of divineKinds) {
    if ((divineSent.get(kind) ?? 0) < authors.length) continue
    for (const pubkey of wanted) if (!authorsSeen.has(pubkey)) divineFailed.add(pubkey)
  }
  for (const pubkey of wanted) {
    reads.set(pubkey, {
      read: divineAnswered && !divineUnattributable && !divineFailed.has(pubkey),
      event: identityEvents.get(pubkey) ?? profiles.get(pubkey) ?? null,
    })
  }
  return reads
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
