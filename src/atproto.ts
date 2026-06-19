export type DidDocument = {
  alsoKnownAs?: string[]
  service?: Array<{ id?: string; serviceEndpoint?: string }>
}

/** Validate that a URL is HTTPS and points to a public host (SSRF protection). */
export function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr)
    if (url.protocol !== 'https:') return false
    const hostname = url.hostname
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false
    if (hostname.startsWith('[') || hostname.includes(':')) return false
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false
    if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.corp')) return false
    return true
  } catch {
    return false
  }
}

export async function resolveHandle(handle: string): Promise<string | null> {
  const resolveUrl = `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
  const resolveResp = await fetch(resolveUrl)
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
    const didResp = await fetch(`https://plc.directory/${did}`)
    if (!didResp.ok) return null
    try {
      return await didResp.json() as DidDocument
    } catch {
      return null
    }
  }

  if (did.startsWith('did:web:')) {
    const domain = decodeURIComponent(did.slice('did:web:'.length))
    if (domain.includes('/') || domain.includes('\\')) return null
    const didWebUrl = `https://${domain}/.well-known/did.json`
    if (!isSafeUrl(didWebUrl)) return null
    const didResp = await fetch(didWebUrl)
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
