// ABOUTME: Whether a Bluesky account is still active on its own host, asked of the PDS that hosts it,
// ABOUTME: so a sign-in link stops counting once the account is deleted or deactivated.
// ABOUTME: It tells an account gone for the long term (`gone`) from one paused or unclear (`inactive`).
import type { Bindings } from '../types'
import { didDocumentSource, getPdsEndpoint, hasPdsService, isMalformedDid, type DidDocument } from '../atproto'
import { discardBody, fetchFromPlatform, PlatformUnavailableError, readJson, throwIfUnanswered, withinTimeBudget } from '../platforms/base'
import { fetchPublic } from '../utils/safe-fetch'

/**
 * `inactive`: paused or unclear, so the account may come back soon. `gone`:
 * gone for the long term, though it can still come back. Both stop a link
 * counting; only how long its record is kept differs (signin-records.ts).
 * `null` means the lookup couldn't tell, which keeps a link counting.
 */
export type AccountStatus = 'active' | 'inactive' | 'gone' | null

// Cached like the handle lookup in signin-account.ts: an active answer for an
// hour, an inactive or gone one for five minutes, so a reactivated account
// verifies again soon. "Couldn't tell" is remembered for a minute, Cloudflare
// KV's shortest lifetime, under a value of its own that reads back as null:
// the link keeps counting, and the claims and status requests that follow
// within that minute don't ask the host again.
const ACTIVE_TTL = 60 * 60
const INACTIVE_TTL = 5 * 60
const UNKNOWN_TTL = 60
const UNKNOWN = 'unknown'
const TTL = { active: ACTIVE_TTL, inactive: INACTIVE_TTL, gone: INACTIVE_TTL, [UNKNOWN]: UNKNOWN_TTL } as const
// The whole lookup (DID document, then the PDS) gets the handle lookup's 3 seconds.
const LOOKUP_BUDGET_MS = 3000

export const accountStatusKey = (did: string) => `bsky_account_status:${did.toLowerCase()}`

// A failed write only costs the next lookup, so it never fails this one. Only
// the error's name is logged: its message could carry the key, and the key
// holds the DID.
async function remember(env: Bindings, did: string, status: keyof typeof TTL): Promise<void> {
  try {
    await env.CACHE_KV.put(accountStatusKey(did), status, { expirationTtl: TTL[status] })
  } catch (err) {
    console.warn('Bluesky account status not cached:', err instanceof Error ? err.name : 'unknown')
  }
}

// "Couldn't tell" never replaces a real answer another lookup for the same DID
// saved while this one ran (a handle and a DID claim in one batch, or the
// status lookup made alongside a handle lookup), so it is written only when no
// answer is found just before. A write landing between that read and this put
// can still be replaced, and KV reads are eventually consistent across
// locations; either way the cost is at most a minute of "couldn't tell", which
// keeps the link counting. A read that fails skips the write.
async function rememberUnknown(env: Bindings, did: string): Promise<void> {
  let current: string | null
  try {
    current = await env.CACHE_KV.get(accountStatusKey(did))
  } catch (err) {
    console.warn('Bluesky account status cache unreadable:', err instanceof Error ? err.name : 'unknown')
    return
  }
  if (current === 'active' || current === 'inactive' || current === 'gone') return
  await remember(env, did, UNKNOWN)
}

/** Drop a remembered answer, so a fresh sign-in is checked against the account's current status. */
export async function forgetBlueskyAccountStatus(env: Bindings, did: string): Promise<void> {
  await env.CACHE_KV.delete(accountStatusKey(did))
}

// The DID document for `did`, or a verdict when the lookup says the account is
// gone. Unlike resolveDidDocument (src/atproto.ts), which folds every failed
// status into "no document", this tells "the identity is gone" (gone or
// inactive) from "the lookup didn't say" (null), because a doubtful answer must
// keep a link counting.
async function lookUpDidDocument(did: string): Promise<DidDocument | 'inactive' | 'gone' | null> {
  // Held to did:plc's and did:web's exact syntax: PLC answers 404 for a DID it
  // doesn't know, which would read as gone, so a DID that can't name an
  // account isn't asked about.
  if (isMalformedDid(did)) return null
  const source = didDocumentSource(did)
  if (!source) return null
  const { url, label, fetcher } = source

  const resp = await fetchFromPlatform(label, url, undefined, fetcher)
  throwIfUnanswered(resp, label)
  // PLC: 404 "DID Not Found", 410 "DID Not Available (Tombstone)"
  // (did-method-plc, website/spec/plc-server-openapi3.yaml). atproto.com/specs/account:
  // a tombstoned identity is "implied to be permanent and final, but can
  // technically be reversed in certain conditions", and "if the account's
  // identity is `tombstoned`, the account hosting status should be interpreted
  // as `deleted`", so it is gone. The spec says nothing about a DID PLC
  // doesn't know (404); one this account signed in with is treated as gone by
  // decision (#90), not by the text quoted. A did:web host answering the same
  // for did.json has no identity to host for now, but a did:web document lives
  // on a web server that can lose it and serve it again (a misconfigured
  // server, a lapsed domain), so that is inactive, not gone.
  if (resp.status === 404 || resp.status === 410) {
    await discardBody(resp)
    return did.startsWith('did:plc:') ? 'gone' : 'inactive'
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

async function askHost(did: string): Promise<AccountStatus> {
  const doc = await lookUpDidDocument(did)
  if (doc === null || doc === 'inactive' || doc === 'gone') return doc
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
  // the lexicon's shape, so it isn't an answer. So `active` alone decides
  // whether the link counts; the status only decides how long an inactive
  // account's record is kept. The same spec says `deleted` and `takendown` are
  // "implied permanent or long-term, though may be reverted", so they are gone;
  // `deactivated` and `suspended` are "implied time-limited", and any other or
  // missing status says nothing more, so those are inactive.
  const body = await readJson<{ active?: unknown, status?: unknown }>(resp, label)
  if (typeof body?.active !== 'boolean') return null
  if (body.active) return 'active'
  return body.status === 'deleted' || body.status === 'takendown' ? 'gone' : 'inactive'
}

/**
 * Whether the account behind `did` is still active on the host that serves it,
 * and if not, whether it is gone for the long term (`gone`) or paused or
 * unclear (`inactive`). Answers `null` when that can't be told (an outage, a
 * timeout, a host that doesn't answer the way the lexicon says), and the caller
 * keeps counting the link: atproto.com/specs/account says "if an account's
 * current active PDS is not available, account status should remain unchanged".
 */
export async function blueskyAccountStatus(env: Bindings, did: string): Promise<AccountStatus> {
  // A cache that can't be read is a miss, not a failed lookup.
  let cached: string | null = null
  try {
    cached = await env.CACHE_KV.get(accountStatusKey(did))
  } catch (err) {
    console.warn('Bluesky account status cache unreadable:', err instanceof Error ? err.name : 'unknown')
  }
  if (cached === 'active' || cached === 'inactive' || cached === 'gone') return cached
  if (cached === UNKNOWN) return null

  let status: AccountStatus
  try {
    status = await withinTimeBudget(askHost(did), LOOKUP_BUDGET_MS, 'Bluesky account status')
  } catch (err) {
    if (!(err instanceof PlatformUnavailableError)) throw err
    status = null
  }
  if (status) await remember(env, did, status)
  else await rememberUnknown(env, did)
  return status
}
