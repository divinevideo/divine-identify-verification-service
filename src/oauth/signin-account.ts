import type { Bindings, OAuthVerification } from '../types'
import { lookUpYouTubeHandle } from '../platforms/youtube-handle'
import { blueskyAccountStatus } from './bluesky-account-status'
import { foldYouTubeHandleCase, parseYouTubeIdentity } from '../utils/youtube-identity'

// How long Bluesky's answer to "which account does this handle point to" is
// reused. Only the lookup is cached, never the verified result, so unlinking
// still takes effect on the next check.
const HANDLE_LOOKUP_TTL = 60 * 60
// Bluesky also answers "no such handle" when it briefly can't resolve a
// custom-domain handle, so that answer is reused only for a few minutes.
const HANDLE_NOT_FOUND_TTL = 5 * 60

const handleLookupKey = (handle: string) => `bsky_handle_did:${handle.toLowerCase()}`

// Remembering a lookup only saves the next one, so a failed write never fails
// the check it was made for.
async function remember(env: Bindings, key: string, value: string, ttl: number): Promise<void> {
  try {
    await env.CACHE_KV.put(key, value, { expirationTtl: ttl })
  } catch (err) {
    console.warn('Bluesky handle lookup not cached:', err)
  }
}

/** Drop a remembered lookup, so a fresh sign-in is checked against Bluesky's current answer. */
export async function forgetHandleLookup(env: Bindings, handle: string): Promise<void> {
  await env.CACHE_KV.delete(handleLookupKey(handle))
}

type Lookup = { did: string } | { notFound: true } | null

async function lookUpHandle(env: Bindings, handle: string): Promise<Lookup> {
  const key = handleLookupKey(handle)
  const cached = await env.CACHE_KV.get(key)
  if (cached) return cached === 'not-found' ? { notFound: true } : { did: cached }

  let resp: Response
  try {
    resp = await fetch(`https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`, {
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    return null
  }
  // Bluesky answers 400 for a handle that doesn't resolve; anything else that
  // isn't a DID says nothing about the account, so it isn't remembered.
  if (resp.status === 400) {
    await remember(env, key, 'not-found', HANDLE_NOT_FOUND_TTL)
    return { notFound: true }
  }
  if (!resp.ok) return null
  let did: unknown
  try {
    did = ((await resp.json()) as { did?: unknown }).did
  } catch {
    return null
  }
  if (typeof did !== 'string' || !did.startsWith('did:')) return null
  await remember(env, key, did, HANDLE_LOOKUP_TTL)
  return { did }
}

// A YouTube record saved with its channel id matches a claim of that id, or of
// the handle sign-in saved while YouTube still resolves it to that channel.
// Records are found by the fully lowercased identity, so a claim can reach one
// in spellings sign-in never saved:
// - A channel id differing only in letter case. Channel ids are case-sensitive,
//   so the id is compared exactly.
// - A handle differing beyond A to Z case, such as a look-alike letter. It
//   doesn't match, and it isn't looked up, so one record costs about one
//   lookup a day however it is spelled.
// - Anything else. Sign-in saves only handles and channel ids, so it doesn't
//   match (a record saved before #185 under another name included).
// The lookup is #184's, cached for a day; one YouTube couldn't answer (no API
// key, unreachable, quota) keeps the record.
async function youTubeChannelStillMatches(env: Bindings, record: OAuthVerification & { account_id: string }, identity: string): Promise<boolean> {
  const claimed = parseYouTubeIdentity(identity)
  if (!claimed) return false
  if (claimed.kind === 'channel') return claimed.channelId === record.account_id
  const saved = parseYouTubeIdentity(record.identity)
  if (saved?.kind !== 'handle' || foldYouTubeHandleCase(saved.handle) !== foldYouTubeHandleCase(claimed.handle)) return false
  const lookup = await lookUpYouTubeHandle(env, saved.handle)
  if (!lookup) return true
  return 'channelId' in lookup && lookup.channelId === record.account_id
}

/** `moved`: the claim no longer names the account that signed in. `inactive`: it does, but the account's host says it is gone. */
export type SignInAccountCheck = 'matches' | 'moved' | 'inactive'

// Whether the account itself is still active on its host (bluesky-account-status.ts).
// An answer that couldn't be had keeps the link counting.
async function blueskyAccountCheck(env: Bindings, did: string): Promise<SignInAccountCheck> {
  return (await blueskyAccountStatus(env, did)) === 'inactive' ? 'inactive' : 'matches'
}

/**
 * Whether a kept sign-in record still describes the account claimed. A Bluesky
 * record saved with the account's DID matches a claim of that DID, or of a
 * handle that still points to it, and in both cases only while the account's
 * host still reports it active; a YouTube record saved with its channel id
 * likewise (youTubeChannelStillMatches). An older record without the account's
 * id, other platforms, and a lookup the platform couldn't answer all keep the
 * record as it is.
 */
export async function signInAccountStillMatches(env: Bindings, record: OAuthVerification, identity: string): Promise<SignInAccountCheck> {
  if (!record.account_id) return 'matches'
  if (record.platform === 'youtube') return (await youTubeChannelStillMatches(env, { ...record, account_id: record.account_id }, identity)) ? 'matches' : 'moved'
  if (record.platform !== 'bluesky') return 'matches'
  // Handles and DIDs are ASCII. Anything else can only look like the linked
  // one, so it doesn't match, and it's never looked up or remembered.
  if (!/^[\x21-\x7e]+$/.test(identity)) return 'moved'
  if (/^did:/i.test(identity)) {
    if (identity.toLowerCase() !== record.account_id.toLowerCase()) return 'moved'
    return blueskyAccountCheck(env, record.account_id)
  }
  const lookup = await lookUpHandle(env, identity)
  if (!lookup) return 'matches'
  if (!('did' in lookup) || lookup.did !== record.account_id) return 'moved'
  return blueskyAccountCheck(env, record.account_id)
}
