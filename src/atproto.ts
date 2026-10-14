import { isSafeUrl } from './utils/validation'
import { fetchPublic } from './utils/safe-fetch'
import { discardBody, fetchFromPlatform, PlatformUnavailableError, readJson, throwIfUnanswered } from './platforms/base'

export type DidDocument = {
  alsoKnownAs?: string[]
  service?: Array<{ id?: string; serviceEndpoint?: string }>
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

// A did:plc is "did:plc:" and 24 lowercase base32 characters (a-z, 2-7), per
// the did:plc spec (did-method-plc, website/spec/v0.1/did-plc.md).
const DID_PLC = /^did:plc:[a-z2-7]{24}$/
// atproto's DID syntax (atproto.com/specs/did) without ":", because atproto
// supports hostname-level did:web only, so a ":" would start a path (a port is
// written as %3A): letters, digits and ._%- only, and not ending in %.
const DID_WEB = /^did:web:[a-zA-Z0-9._%-]*[a-zA-Z0-9._-]$/

// The host a did:web names, or null when the DID is malformed: characters
// outside the syntax, a % that isn't a valid escape, or a path (atproto
// supports hostname-level did:web only).
function didWebHost(did: string): string | null {
  if (!DID_WEB.test(did)) return null
  let host: string
  try {
    host = decodeURIComponent(did.slice('did:web:'.length))
  } catch {
    return null
  }
  return host.includes('/') || host.includes('\\') ? null : host
}

/**
 * Whether a did:plc or did:web is malformed, so no lookup could find it. Other
 * DIDs and handles are not this check's business: they are reported as false.
 */
export function isMalformedDid(did: string): boolean {
  if (did.startsWith('did:plc:')) return !DID_PLC.test(did)
  if (did.startsWith('did:web:')) return didWebHost(did) === null
  return false
}

// What an account lookup's answer means, decided once for the three lookups
// here. A lookup answers null when the account isn't there or the answer is one
// this service can't use, and throws a PlatformUnavailableError when the
// service didn't answer or couldn't be reached, so an outage isn't taken for a
// missing account.
//
// A 400 or 404 means the account isn't there. bsky.social's 400 reads the same
// for a handle that doesn't exist and for a custom-domain handle it briefly
// couldn't resolve (sign-in remembers it for less time for that reason, in
// src/oauth/signin-account.ts), so a 400 stays "not there".
//
// bsky.social and the PLC directory are the two services named here, and
// neither takes a credential from this service, so a 401, a 403 or a page that
// isn't JSON from either can't be about the account: they didn't answer. A
// did:web host is the person's own website, and a static host answers a 403 or
// a page of its own for a file it doesn't have, so there those mean "not
// there", as they do for the record list on the account's own server
// (src/platforms/bluesky.ts). Pass `fetcher` (fetchPublic) when the host comes
// from the claim, as for fetchFromPlatform; that marks the host as the
// person's.
async function lookUp(label: string, url: string, fetcher?: Fetcher): Promise<unknown> {
  const resp = await fetchFromPlatform(label, url, undefined, fetcher)
  throwIfUnanswered(resp, label)
  const namedByUs = !fetcher
  if (namedByUs && (resp.status === 401 || resp.status === 403)) {
    await discardBody(resp)
    throw new PlatformUnavailableError(`${label} answered ${resp.status}`)
  }
  if (!resp.ok) {
    await discardBody(resp)
    return null
  }
  const data = await readJson<unknown>(resp, label)
  if (data === undefined) {
    if (namedByUs) throw new PlatformUnavailableError(`${label} answered something that isn't JSON`)
    return null
  }
  return data
}

export async function resolveHandle(handle: string): Promise<string | null> {
  const resolved = await lookUp('Bluesky handle lookup', `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`) as { did?: string } | null
  return resolved?.did || null
}

export async function resolveDidDocument(did: string): Promise<DidDocument | null> {
  if (did.startsWith('did:plc:')) {
    return await lookUp('PLC directory', `https://plc.directory/${did}`) as DidDocument | null
  }

  if (did.startsWith('did:web:')) {
    const domain = didWebHost(did)
    if (!domain) return null
    const didWebUrl = `https://${domain}/.well-known/did.json`
    if (!isSafeUrl(didWebUrl)) return null
    return await lookUp('did:web host', didWebUrl, fetchPublic) as DidDocument | null
  }

  return null
}

export function getPdsEndpoint(didDoc: DidDocument): string | null {
  const endpoint = didDoc.service?.find(s => s.id === '#atproto_pds')?.serviceEndpoint
  if (!endpoint || !isSafeUrl(endpoint)) return null
  return endpoint.replace(/\/+$/, '')
}

export function getHandleFromDidDocument(didDoc: DidDocument): string | null {
  const atHandle = didDoc.alsoKnownAs?.find(a => a.startsWith('at://'))
  return atHandle ? atHandle.slice('at://'.length) : null
}

export async function resolveAtprotoIdentityPds(identity: string): Promise<{ did: string; pdsEndpoint: string } | null> {
  const did = identity.startsWith('did:') ? identity : await resolveHandle(identity)
  if (!did) return null

  const didDoc = await resolveDidDocument(did)
  if (!didDoc) return null

  const pdsEndpoint = getPdsEndpoint(didDoc)
  if (!pdsEndpoint) return null

  return { did, pdsEndpoint }
}
