// ABOUTME: Whether a Bluesky account is still active on its own host, asked of the PDS that hosts it,
// ABOUTME: so a sign-in link stops counting once the account is deleted or deactivated.
import type { Bindings } from '../types'
import { getPdsEndpoint, hasPdsService, isMalformedDid, type DidDocument } from '../atproto'
import { isSafeUrl } from '../utils/validation'
import { discardBody, fetchFromPlatform, PlatformUnavailableError, readJson, throwIfUnanswered, withinTimeBudget } from '../platforms/base'
import { fetchPublic } from '../utils/safe-fetch'

/** `null` means the lookup couldn't tell, which keeps a link counting. */
export type AccountStatus = 'active' | 'inactive' | null

// Cached like the handle lookup in signin-account.ts: an active answer for an
// hour, an inactive one for five minutes, so a reactivated account verifies
// again soon. "Couldn't tell" is never remembered.
const ACTIVE_TTL = 60 * 60
const INACTIVE_TTL = 5 * 60
// The whole lookup (DID document, then the PDS) gets the handle lookup's 3 seconds.
const LOOKUP_BUDGET_MS = 3000

export const accountStatusKey = (did: string) => `bsky_account_status:${did.toLowerCase()}`

// A failed write only costs the next lookup, so it never fails this one. Only
// the error's name is logged: its message could carry the key, and the key
// holds the DID.
async function remember(env: Bindings, did: string, status: 'active' | 'inactive'): Promise<void> {
  try {
    await env.CACHE_KV.put(accountStatusKey(did), status, { expirationTtl: status === 'active' ? ACTIVE_TTL : INACTIVE_TTL })
  } catch (err) {
    console.warn('Bluesky account status not cached:', err instanceof Error ? err.name : 'unknown')
  }
}

/** Drop a remembered answer, so a fresh sign-in is checked against the account's current status. */
export async function forgetBlueskyAccountStatus(env: Bindings, did: string): Promise<void> {
  await env.CACHE_KV.delete(accountStatusKey(did))
}

// The DID document for `did`, or a verdict when the lookup says the account is
// gone. Unlike resolveDidDocument (src/atproto.ts), which folds every failed
// status into "no document", this tells "the identity is gone" (inactive) from
// "the lookup didn't say" (null), because a doubtful answer must keep a link
// counting.
async function lookUpDidDocument(did: string): Promise<DidDocument | 'inactive' | null> {
  let url: string
  let label: string
  let fetcher: typeof fetchPublic | undefined
  // Not held to did:plc's exact syntax (PLC answers 404 for a DID it doesn't know), but
  // nothing that could change the path or query of the PLC URL goes into it.
  if (did.startsWith('did:plc:') && /^[A-Za-z0-9:]+$/.test(did)) {
    url = `https://plc.directory/${did}`
    label = 'PLC directory'
  } else if (did.startsWith('did:web:') && !isMalformedDid(did)) {
    // atproto supports hostname-level did:web only; isMalformedDid has ruled out a path.
    url = `https://${decodeURIComponent(did.slice('did:web:'.length))}/.well-known/did.json`
    if (!isSafeUrl(url)) return null
    label = 'did:web host'
    fetcher = fetchPublic
  } else {
    return null
  }

  const resp = await fetchFromPlatform(label, url, undefined, fetcher)
  throwIfUnanswered(resp, label)
  // PLC: 404 "DID Not Found", 410 "DID Not Available (Tombstone)"
  // (did-method-plc, website/spec/plc-server-openapi3.yaml). atproto.com/specs/account:
  // a tombstoned identity's hosting status is interpreted as `deleted`.
  // A did:web host answering the same for did.json has no identity to host.
  if (resp.status === 404 || resp.status === 410) {
    await discardBody(resp)
    return 'inactive'
  }
  // Anything else that isn't a 200 (a 401 or 403 from a CDN challenge, a 400,
  // a redirect) says nothing about the account.
  if (!resp.ok) {
    await discardBody(resp)
    return null
  }
  const doc = await readJson<unknown>(resp, label)
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null
  // Only a real DID document for this DID can say the account has no hosting.
  // Any other JSON a host answers (a catch-all {"message":"ok"}, another DID's
  // document) says nothing about the account.
  const id = (doc as { id?: unknown }).id
  if (typeof id !== 'string' || id.toLowerCase() !== did.toLowerCase()) return null
  return doc as DidDocument
}

async function askHost(did: string): Promise<'active' | 'inactive' | null> {
  const doc = await lookUpDidDocument(did)
  if (doc === null || doc === 'inactive') return doc
  // A DID document that lists no PDS has no hosting, so no account. One that
  // lists a PDS this service won't call (not https, or a private host) is
  // doubtful, not proof the account is gone.
  if (!hasPdsService(doc)) return 'inactive'
  const pds = getPdsEndpoint(doc)
  if (!pds) return null

  // com.atproto.sync.getRepoStatus: query with a required `did`, output
  // { did, active, status?, rev? }, one declared error: RepoNotFound.
  // Source: bluesky-social/atproto lexicons/com/atproto/sync/getRepoStatus.json
  // (last changed in 6e382f67aa73532efadfea80ff96a27b526cb178, 2025-02-22).
  // The PDS is the host the DID document names, which atproto.com/specs/account
  // says to ask "if there is doubt about an account's general status".
  const label = 'PDS'
  const resp = await fetchFromPlatform(
    label,
    `${pds}/xrpc/com.atproto.sync.getRepoStatus?did=${encodeURIComponent(did)}`,
    { headers: { Accept: 'application/json', 'User-Agent': 'divine-identity-verification-service' } },
    fetchPublic,
  )
  throwIfUnanswered(resp, label)

  if (!resp.ok) {
    // XRPC errors are JSON { error, message? } named by the Lexicon
    // (atproto.com/specs/xrpc), and RepoNotFound is getRepoStatus's declared
    // "no such account here" error, sent as a 400.
    if (resp.status === 400) {
      const body = await readJson<{ error?: unknown }>(resp, label)
      return body?.error === 'RepoNotFound' ? 'inactive' : null
    }
    // Any other answer, a 404 included, says nothing about the account: the
    // XRPC spec says a 404 "can also indicate that the server does not support
    // atproto, or does not support this endpoint" (atproto.com/specs/xrpc).
    await discardBody(resp)
    return null
  }

  // atproto.com/specs/account: deleted, deactivated, takendown and suspended
  // all have `active: false`, and services "should use the `active` flag"
  // rather than the `status` string. A body without a boolean `active` isn't
  // the lexicon's shape, so it isn't an answer.
  const body = await readJson<{ active?: unknown }>(resp, label)
  if (typeof body?.active !== 'boolean') return null
  return body.active ? 'active' : 'inactive'
}

/**
 * Whether the account behind `did` is still active on the host that serves it.
 * Answers `null` when that can't be told (an outage, a timeout, a host that
 * doesn't answer the way the lexicon says), and the caller keeps counting the
 * link: atproto.com/specs/account says "if an account's current active PDS is
 * not available, account status should remain unchanged".
 */
export async function blueskyAccountStatus(env: Bindings, did: string): Promise<AccountStatus> {
  // A cache that can't be read is a miss, not a failed lookup.
  let cached: string | null = null
  try {
    cached = await env.CACHE_KV.get(accountStatusKey(did))
  } catch (err) {
    console.warn('Bluesky account status cache unreadable:', err instanceof Error ? err.name : 'unknown')
  }
  if (cached === 'active' || cached === 'inactive') return cached

  let status: 'active' | 'inactive' | null
  try {
    status = await withinTimeBudget(askHost(did), LOOKUP_BUDGET_MS, 'Bluesky account status')
  } catch (err) {
    if (err instanceof PlatformUnavailableError) return null
    throw err
  }
  if (status) await remember(env, did, status)
  return status
}
