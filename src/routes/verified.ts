// ABOUTME: GET /verified/<pubkey>, answering in the old verify.divine.video shape what
// ABOUTME: the person's current list verifies now. Adds no storage of its own: each link is
// ABOUTME: checked exactly as /verify checks it.

import { Hono } from 'hono'
import type { Bindings, Platform, VerifyResult } from '../types'
import { checkRateLimit, RATE_LIMITS } from '../utils/rate-limit'
import { linkedAccountClaims, readLinkedAccounts } from '../verified/linked-accounts'
import { accountKey, couldNotCheck, oldMethod, oldPlatformName } from '../verified/names'
import { proofUrl, verifySingleClaim } from './verify'

const verified = new Hono<{ Bindings: Bindings }>()

// Each check can ask a platform, so a list is only checked this far; the rest are
// reported as not checked rather than silently dropped.
export const MAX_LIST_CLAIMS = 20

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

/**
 * What the person's current list verifies now. A link counts only when it passes the
 * same check `/verify` makes, so a lapsed or removed sign-in drops out. `read` is false
 * when Divine's relay couldn't be read, since an empty list would then be a guess.
 */
export async function checkPersonsLinks(pubkey: string, env: Bindings, clientIp: string): Promise<PersonsLinks> {
  const { read, event } = await readLinkedAccounts(pubkey)
  if (!read) return { read: false }

  const claims = linkedAccountClaims(event, pubkey)
  const checked = claims.slice(0, MAX_LIST_CLAIMS)
  const results = await Promise.all(checked.map(claim => verifySingleClaim(claim, env, clientIp)))

  const seen = new Set<string>()
  const links: CheckedLink[] = []
  const notChecked: Array<{ claim: (typeof claims)[number] }> = claims.slice(MAX_LIST_CLAIMS).map(claim => ({ claim }))
  results.forEach((result, i) => {
    const claim = checked[i]
    if (couldNotCheck(result)) {
      notChecked.push({ claim })
      return
    }
    if (!result.verified) return
    const identity = result.canonical_identity ?? claim.identity
    // One entry per account however its tags are spelled; the first in tag order wins.
    const key = `${claim.platform}|${accountKey(claim.platform, identity)}`
    if (seen.has(key)) return
    seen.add(key)
    links.push({ platform: claim.platform, identity, proof: claim.proof, result })
  })
  // An account is listed once, and not at all when another spelling of it verified.
  const unchecked: Unchecked[] = []
  for (const { claim } of notChecked) {
    const key = `${claim.platform}|${accountKey(claim.platform, claim.identity)}`
    if (seen.has(key)) continue
    seen.add(key)
    unchecked.push({ platform: oldPlatformName(claim.platform), identity: claim.identity })
  }
  return { read: true, verified: links, unchecked }
}

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
