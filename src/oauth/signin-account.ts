import type { Bindings, OAuthVerification } from '../types'

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

/**
 * Whether a kept sign-in record still describes the account claimed. A Bluesky
 * record saved with the account's DID matches a claim of that DID, or of a
 * handle that still points to it; an older record without a DID, other
 * platforms, and a lookup Bluesky couldn't answer all keep the record as it is.
 */
export async function signInAccountStillMatches(env: Bindings, record: OAuthVerification, identity: string): Promise<boolean> {
  if (record.platform !== 'bluesky' || !record.account_id) return true
  // Handles and DIDs are ASCII. Anything else can only look like the linked
  // one, so it doesn't match, and it's never looked up or remembered.
  if (!/^[\x21-\x7e]+$/.test(identity)) return false
  if (/^did:/i.test(identity)) return identity.toLowerCase() === record.account_id.toLowerCase()
  const lookup = await lookUpHandle(env, identity)
  if (!lookup) return true
  return 'did' in lookup && lookup.did === record.account_id
}
