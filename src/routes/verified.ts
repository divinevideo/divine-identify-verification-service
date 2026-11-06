// ABOUTME: GET /verified/<pubkey> and GET /verified?platform=&identity=, answering in the old
// ABOUTME: verify.divine.video shape from people's current lists. Adds no storage of its own:
// ABOUTME: each link is checked exactly as /verify checks it.

import { Hono } from 'hono'
import { getOAuthVerification, oauthVerificationKey } from '../oauth/state'
import type { Bindings, Platform, VerifyClaim, VerifyResult } from '../types'
import { asSignedEvent, verifyEventSignature, type SignedNostrEvent } from '../utils/nostr-event'
import { checkRateLimit, RATE_LIMITS } from '../utils/rate-limit'
import { MAX_RELAY_EVENTS, queryRelay } from '../utils/relay'
import { tidyClaim } from '../utils/tidy-claim'
import { fitsStorageKeys, validateClaim } from '../utils/validation'
import { DIVINE_RELAY, linkedAccountClaims, PROFILE_RELAYS, readLinkedAccounts, readLinkedAccountsOf } from '../verified/linked-accounts'
import { accountKey, couldNotCheck, oldMethod, oldPlatformName, parseOldPlatform, tagSpellings } from '../verified/names'
import { proofUrl, SIGNIN_PLATFORMS, storageForm, verifySingleClaim } from './verify'

const verified = new Hono<{ Bindings: Bindings }>()

// Each check can ask a platform, so a list is only checked this far; the rest are
// reported as not checked rather than silently dropped.
export const MAX_LIST_CLAIMS = 20

// Each candidate costs a read of their list and checks of its claims, so a lookup
// checks only this many owners, sign-in records first.
export const MAX_LOOKUP_CANDIDATES = 10

export interface CheckedLink {
  platform: Platform
  identity: string
  proof: string
  result: VerifyResult
}

type Unchecked = { platform: string; identity: string }

export type PersonsLinks =
  | { read: false }
  | { read: true; verified: CheckedLink[]; unchecked: Unchecked[] }

// The old host's answers carry an explicit charset, which c.json leaves off.
export function oldJson(body: unknown, status: 200 | 400 | 404 | 429 | 503 = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

// The old host's errors: its own body shape, not this service's.
export function oldError(status: 400 | 404 | 429 | 503, code: string, message: string): Response {
  return oldJson({ error: { code, message } }, status)
}

// Plain code-unit order, as SQL ORDER BY on text gave the old host's lists.
const byPlatformThenIdentity = (a: Unchecked, b: Unchecked): number =>
  a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0

interface ClaimChecks {
  verified: Array<{ claim: VerifyClaim; result: VerifyResult }>
  unavailable: VerifyClaim[]
  pastCap: VerifyClaim[]
}

// Checks the first MAX_LIST_CLAIMS claims as /verify would, in parallel, keeping tag order.
async function checkClaims(claims: VerifyClaim[], env: Bindings, clientIp: string): Promise<ClaimChecks> {
  const checked = claims.slice(0, MAX_LIST_CLAIMS)
  const results = await Promise.all(checked.map(claim => verifySingleClaim(claim, env, clientIp)))
  const checks: ClaimChecks = { verified: [], unavailable: [], pastCap: claims.slice(MAX_LIST_CLAIMS) }
  results.forEach((result, i) => {
    if (couldNotCheck(result)) checks.unavailable.push(checked[i])
    else if (result.verified) checks.verified.push({ claim: checked[i], result })
  })
  return checks
}

/**
 * What the person's current list verifies now. A link counts only when it passes the
 * same check `/verify` makes, so a lapsed or removed sign-in drops out. `read` is false
 * when Divine's relay couldn't be read, since an empty list would then be a guess.
 */
export async function checkPersonsLinks(pubkey: string, env: Bindings, clientIp: string): Promise<PersonsLinks> {
  const { read, event } = await readLinkedAccounts(pubkey)
  if (!read) return { read: false }

  const checks = await checkClaims(linkedAccountClaims(event, pubkey), env, clientIp)

  const seen = new Set<string>()
  const links: CheckedLink[] = []
  for (const { claim, result } of checks.verified) {
    const identity = result.canonical_identity ?? claim.identity
    // One entry per account however its tags are spelled; the first in tag order wins.
    const key = `${claim.platform}|${accountKey(claim.platform, identity)}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ platform: claim.platform, identity, proof: claim.proof, result })
  }
  // An account is listed once, and not at all when another spelling of it verified.
  const unchecked: Unchecked[] = []
  for (const claim of [...checks.pastCap, ...checks.unavailable]) {
    const key = `${claim.platform}|${accountKey(claim.platform, claim.identity)}`
    if (seen.has(key)) continue
    seen.add(key)
    unchecked.push({ platform: oldPlatformName(claim.platform), identity: claim.identity })
  }
  return { read: true, verified: links, unchecked }
}

const HEX_PUBKEY = /^[0-9a-f]{64}$/
// Any well-formed pubkey, so validateClaim judges only the platform and identity.
const ANY_PUBKEY = '0'.repeat(64)
// The proof a sign-in link carries; short, so only the identity decides whether keys fit.
const SIGNIN_PROOF = 'oauth'

interface LookupAnswer {
  platform: string
  identity: string
  pubkey: string
  method: ReturnType<typeof oldMethod>
  verified_at: number
}

type Lookup = { found: true; answer: LookupAnswer } | { found: false; unavailable: boolean }

interface CandidateOutcome {
  verified: Array<{ claim: VerifyClaim; result: VerifyResult }>
  unavailable: boolean
}

/**
 * Pubkeys the verifier holds a sign-in record for under this account, in KV list order.
 * A Bluesky record also names the account's handle and DID, and a list may tag either.
 */
async function signInCandidates(env: Bindings, platform: Platform, identity: string): Promise<{ pubkeys: string[]; identities: string[] }> {
  if (!SIGNIN_PLATFORMS.has(platform)) return { pubkeys: [], identities: [] }
  const prefix = oauthVerificationKey(platform, identity, '')
  // Only the first few owners are checked, so one page of keys is enough.
  const { keys } = await env.CACHE_KV.list({ prefix })
  // What follows the prefix must be a whole pubkey: a longer account that starts the
  // same, such as a DID with more parts, leaves more than that.
  const pubkeys = keys
    .map(key => key.name.slice(prefix.length))
    .filter(pubkey => HEX_PUBKEY.test(pubkey))
    .slice(0, MAX_LOOKUP_CANDIDATES)
  const identities: string[] = []
  if (platform === 'bluesky') {
    const records = await Promise.all(pubkeys.map(pubkey => getOAuthVerification(env.CACHE_KV, platform, identity, pubkey)))
    for (const record of records) {
      for (const id of [record?.handle, record?.account_id]) if (typeof id === 'string' && id) identities.push(id)
    }
  }
  return { pubkeys, identities }
}

/**
 * Authors of signed events that tag the account, newest first, skipping `known`. A hit
 * only names someone to check: its tags may be stale, so their current list decides.
 * `searched` is false when Divine's relay didn't answer, since a miss is then a guess.
 */
async function relayCandidates(platform: Platform, identities: string[], known: string[], room: number): Promise<{ pubkeys: string[]; searched: boolean }> {
  const filter = { kinds: [10011, 0], '#i': tagSpellings(platform, identities), limit: MAX_RELAY_EVENTS }
  const answers = await Promise.all(PROFILE_RELAYS.map(relay => queryRelay(relay, [filter]).catch(() => null)))
  const searched = answers[PROFILE_RELAYS.indexOf(DIVINE_RELAY)] !== null
  const events = answers.flatMap(answer => answer ?? [])
    .map(raw => asSignedEvent(raw, [0, 10011]))
    .filter((event): event is SignedNostrEvent => event !== null)
    .sort((a, b) => b.created_at - a.created_at)
  const found: string[] = []
  for (const event of events) {
    if (found.length >= room) break
    if (known.includes(event.pubkey) || found.includes(event.pubkey)) continue
    // Signatures are checked newest first and only until there are enough candidates.
    if ((await verifyEventSignature(event)).ok) found.push(event.pubkey)
  }
  return { pubkeys: found, searched }
}

/**
 * Who owns this account, verified now. A pubkey is named only when a tag for the
 * account on that person's current list passes the check /verify makes.
 */
async function lookUpOwner(platform: Platform, identity: string, tidyIdentity: string, env: Bindings, clientIp: string): Promise<Lookup> {
  const signIns = await signInCandidates(env, platform, tidyIdentity)
  // The tidy form too: tidying can change a spelling more than once (a doubled @), and
  // tags written the plain way must still be found and matched.
  const identities = [...new Set([identity, tidyIdentity, ...signIns.identities])]
  const room = MAX_LOOKUP_CANDIDATES - signIns.pubkeys.length
  const search = room > 0 ? await relayCandidates(platform, identities, signIns.pubkeys, room) : { pubkeys: [], searched: true }
  const candidates = [...signIns.pubkeys, ...search.pubkeys]

  const requestKey = accountKey(platform, tidyIdentity)
  const sameAccount = new Set(identities.map(id => accountKey(platform, id)))

  async function checkCandidate(pubkey: string, event: SignedNostrEvent | null): Promise<CandidateOutcome> {
    // Each unit is the checks that must all pass for one tag to count.
    const units: VerifyClaim[][] = []
    const seen = new Set<string>()
    let budget = MAX_LIST_CLAIMS
    for (const claim of linkedAccountClaims(event, pubkey)) {
      const key = accountKey(platform, claim.identity)
      if (claim.platform !== platform || !sameAccount.has(key)) continue
      // A tag naming another spelling of the account, such as the DID for a looked-up
      // handle, counts only if it holds as tagged and as the account asked about: the
      // person made the first claim, and the second confirms the two still go together.
      const swapped = { ...claim, identity: tidyIdentity }
      // Key-size guard: the account asked about can be longer than the tagged one, and a
      // check whose storage keys don't fit can't be made, so that tag doesn't count.
      if (key !== requestKey && storageForm(swapped) === null) continue
      const unit = key === requestKey ? [claim] : [claim, swapped]
      const unitKey = `${unit.length}|${claim.identity}|${claim.proof}`
      if (seen.has(unitKey)) continue
      // The cap counts checks, so a tag checked twice uses two.
      if (unit.length > budget) break
      budget -= unit.length
      seen.add(unitKey)
      units.push(unit)
    }
    const results = await Promise.all(units.map(unit => Promise.all(unit.map(claim => verifySingleClaim(claim, env, clientIp)))))
    const outcome: CandidateOutcome = { verified: [], unavailable: false }
    results.forEach((unitResults, u) => {
      const last = unitResults.length - 1
      if (unitResults.every(result => result.verified)) {
        // The answer is about the account asked for, so it comes from that check.
        outcome.verified.push({ claim: units[u][last], result: unitResults[last] })
      } else if (unitResults.every(result => result.verified || couldNotCheck(result))) {
        outcome.unavailable = true
      }
    })
    return outcome
  }

  const lists = await readLinkedAccountsOf(candidates)
  const outcomes = await Promise.all(candidates.map(async (pubkey) => {
    const list = lists.get(pubkey)
    if (!list?.read) return null
    try {
      return await checkCandidate(pubkey, list.event)
    } catch (err) {
      // One candidate's failure leaves the others to answer; it counts as couldn't-check.
      console.error('Checking a lookup candidate failed:', err)
      return { verified: [], unavailable: true }
    }
  }))

  let best: { pubkey: string; claim: VerifyClaim; result: VerifyResult } | null = null
  let unavailable = !search.searched
  for (const [i, outcome] of outcomes.entries()) {
    if (!outcome || outcome.unavailable) unavailable = true
    for (const { claim, result } of outcome?.verified ?? []) {
      // The most recent verification wins; on a tie, the earlier candidate keeps it.
      if (!best || result.checked_at > best.result.checked_at) best = { pubkey: candidates[i], claim, result }
    }
  }
  if (!best) return { found: false, unavailable }
  const { pubkey, claim, result } = best
  return {
    found: true,
    answer: {
      platform: oldPlatformName(platform),
      identity: result.canonical_identity ?? claim.identity,
      pubkey,
      method: oldMethod(result.method),
      verified_at: result.checked_at,
    },
  }
}

verified.get('/', async (c) => {
  const clientIp = c.req.header('cf-connecting-ip') || 'unknown'
  const unavailable = () => oldError(503, 'temporarily_unavailable', 'this platform identity could not be checked right now, try again shortly')
  const notFound = () => oldError(404, 'not_found', 'no live verification for this platform identity')
  // Storage failing at any step must still answer in the old shape, not the app-wide 500.
  let ipAllowed: boolean
  try {
    ipAllowed = (await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.ip, clientIp)).allowed
  } catch (err) {
    console.error('Counting a /verified lookup failed:', err)
    return unavailable()
  }
  if (!ipAllowed) return oldError(429, 'rate_limited', 'rate limit exceeded')

  const platform = parseOldPlatform(c.req.query('platform'))
  const identity = (c.req.query('identity') ?? '').trim()
  if (platform === null || !identity) return oldError(400, 'invalid_request', 'platform and identity are required')
  if (platform === 'not_supported') return notFound()
  // An identity /verify would reject is on no one's list, and may not fit a storage key.
  if (validateClaim({ pubkey: ANY_PUBKEY, platform, identity, proof: SIGNIN_PROOF }, 0)) return notFound()
  // As /verify does: the tidy form, unless its storage keys wouldn't fit.
  const tidied = tidyClaim(platform, identity, '').identity
  const tidyIdentity = fitsStorageKeys(platform, tidied, SIGNIN_PROOF, ANY_PUBKEY) ? tidied : identity

  let lookup: Lookup
  try {
    lookup = await lookUpOwner(platform, identity, tidyIdentity, c.env, clientIp)
  } catch (err) {
    console.error('Looking up a platform identity failed:', err)
    return unavailable()
  }
  if (lookup.found) return oldJson(lookup.answer)
  return lookup.unavailable ? unavailable() : notFound()
})

verified.get('/:pubkey', async (c) => {
  const clientIp = c.req.header('cf-connecting-ip') || 'unknown'
  const unavailable = () => oldError(503, 'temporarily_unavailable', 'linked accounts could not be read right now, try again shortly')
  // Storage failing at any step must still answer in the old shape, not the app-wide 500.
  let ipAllowed: boolean
  try {
    ipAllowed = (await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.ip, clientIp)).allowed
  } catch (err) {
    console.error('Counting a /verified request failed:', err)
    return unavailable()
  }
  if (!ipAllowed) return oldError(429, 'rate_limited', 'rate limit exceeded')

  const pubkey = c.req.param('pubkey').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return oldError(400, 'invalid_pubkey', 'pubkey must be 64 lowercase hex chars')

  let links: PersonsLinks
  try {
    links = await checkPersonsLinks(pubkey, c.env, clientIp)
  } catch (err) {
    console.error('Reading a person\'s linked accounts failed:', err)
    return unavailable()
  }
  if (!links.read) return unavailable()

  const verifications = links.verified.map(({ platform, identity, proof, result }) => {
    const method = oldMethod(result.method)
    return {
      platform: oldPlatformName(platform),
      identity,
      method,
      // Only a proof post has a post to link to; a sign-in or identity-link record has none.
      proof_url: method !== 'proof-post' ? null : proofUrl(platform, identity, result.canonical_proof ?? proof),
      verified_at: result.checked_at,
    }
  })
  verifications.sort(byPlatformThenIdentity)
  return oldJson({ pubkey, verifications, unchecked: links.unchecked.sort(byPlatformThenIdentity) })
})

export { verified }
