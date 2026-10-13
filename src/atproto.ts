import { isSafeUrl } from './utils/validation'
import { fetchPublic } from './utils/safe-fetch'
import { fetchFromPlatform, throwIfUnanswered } from './platforms/base'

export type DidDocument = {
  alsoKnownAs?: string[]
  service?: Array<{ id?: string; serviceEndpoint?: string }>
}

// A did:plc is "did:plc:" and 24 lowercase base32 characters (a-z, 2-7), per
// the did:plc spec (did-method-plc, website/spec/v0.1/did-plc.md).
const DID_PLC = /^did:plc:[a-z2-7]{24}$/
// atproto's general DID syntax (atproto.com/specs/did): letters, digits and
// ._:%- only, and not ending in : or %.
const DID_WEB = /^did:web:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/

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

// These lookups answer null when they get no usable answer (no such account,
// or one this service can't use), and throw a PlatformUnavailableError when
// the service didn't answer or couldn't be reached, so an outage isn't taken
// for a missing account.

export async function resolveHandle(handle: string): Promise<string | null> {
  const resolveUrl = `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
  const resolveResp = await fetchFromPlatform('Bluesky handle lookup', resolveUrl)
  throwIfUnanswered(resolveResp, 'Bluesky handle lookup')
  if (!resolveResp.ok) return null

  try {
    const resolveData = await resolveResp.json() as { did?: string }
    return resolveData.did || null
  } catch {
    return null
  }
}

export async function resolveDidDocument(did: string): Promise<DidDocument | null> {
  if (did.startsWith('did:plc:')) {
    const didResp = await fetchFromPlatform('PLC directory', `https://plc.directory/${did}`)
    throwIfUnanswered(didResp, 'PLC directory')
    if (!didResp.ok) return null
    try {
      return await didResp.json() as DidDocument
    } catch {
      return null
    }
  }

  if (did.startsWith('did:web:')) {
    const domain = didWebHost(did)
    if (!domain) return null
    const didWebUrl = `https://${domain}/.well-known/did.json`
    if (!isSafeUrl(didWebUrl)) return null
    const didResp = await fetchFromPlatform('did:web host', didWebUrl, undefined, fetchPublic)
    throwIfUnanswered(didResp, 'did:web host')
    if (!didResp.ok) return null
    try {
      return await didResp.json() as DidDocument
    } catch {
      return null
    }
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
