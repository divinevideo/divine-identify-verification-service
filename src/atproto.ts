import { isSafeUrl } from './utils/validation'
import { fetchPublic } from './utils/safe-fetch'
import { discardBody, fetchFromPlatform, readJson, throwIfUnanswered } from './platforms/base'

export type DidDocument = {
  alsoKnownAs?: string[]
  service?: Array<{ id?: string; serviceEndpoint?: string }>
}

// These lookups answer null when they get no usable answer (no such account,
// or one this service can't use), and throw a PlatformUnavailableError when
// the service didn't answer or couldn't be reached, so an outage isn't taken
// for a missing account.

export async function resolveHandle(handle: string): Promise<string | null> {
  const resolveUrl = `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
  const resolveResp = await fetchFromPlatform('Bluesky handle lookup', resolveUrl)
  throwIfUnanswered(resolveResp, 'Bluesky handle lookup')
  if (!resolveResp.ok) {
    await discardBody(resolveResp)
    return null
  }

  const resolveData = await readJson<{ did?: string }>(resolveResp, 'Bluesky handle lookup')
  return resolveData?.did || null
}

export async function resolveDidDocument(did: string): Promise<DidDocument | null> {
  if (did.startsWith('did:plc:')) {
    const didResp = await fetchFromPlatform('PLC directory', `https://plc.directory/${did}`)
    throwIfUnanswered(didResp, 'PLC directory')
    if (!didResp.ok) {
      await discardBody(didResp)
      return null
    }
    return (await readJson<DidDocument>(didResp, 'PLC directory')) ?? null
  }

  if (did.startsWith('did:web:')) {
    const domain = decodeURIComponent(did.slice('did:web:'.length))
    if (domain.includes('/') || domain.includes('\\')) return null
    const didWebUrl = `https://${domain}/.well-known/did.json`
    if (!isSafeUrl(didWebUrl)) return null
    const didResp = await fetchFromPlatform('did:web host', didWebUrl, undefined, fetchPublic)
    throwIfUnanswered(didResp, 'did:web host')
    if (!didResp.ok) {
      await discardBody(didResp)
      return null
    }
    return (await readJson<DidDocument>(didResp, 'did:web host')) ?? null
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
