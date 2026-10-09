import type { Platform, VerifyClaim } from '../types'
import { cacheKey } from './cache'
import { oauthVerificationKey } from '../oauth/state'

export const VALID_PLATFORMS: readonly Platform[] = ['github', 'twitter', 'mastodon', 'telegram', 'bluesky', 'discord', 'youtube', 'tiktok']

export function isValidPlatform(platform: string): platform is Platform {
  return VALID_PLATFORMS.includes(platform as Platform)
}

export function isValidHexPubkey(pubkey: string): boolean {
  return typeof pubkey === 'string' && pubkey.length === 64 && /^[0-9a-f]+$/i.test(pubkey)
}

/** Normalize hex pubkey to lowercase */
export function normalizePubkey(pubkey: string): string {
  return pubkey.toLowerCase()
}

export function isValidProof(proof: string): boolean {
  if (typeof proof !== 'string' || proof.length === 0 || proof.length > 500) return false
  if (/[<>"'{}|\\^`;]/.test(proof)) return false
  // Block control characters
  if (/[\x00-\x1f\x7f]/.test(proof)) return false
  return true
}

export function isValidIdentity(identity: string): boolean {
  if (typeof identity !== 'string' || identity.length === 0 || identity.length > 500) return false
  if (/[<>"'{}|\\^`;]/.test(identity)) return false
  if (/[\x00-\x1f\x7f]/.test(identity)) return false
  return true
}

/**
 * Check if a hostname is a private/internal address that should not be fetched.
 * The host is read the way a fetch reads it: URL parsing lowercases it, keeps a
 * trailing dot (which is refused), and reads short and hex IPv4 forms (127.1, 0x7f.1)
 * as addresses.
 * Anything other than a bare hostname is refused.
 */
export function isPrivateHostname(hostname: string): boolean {
  // Fail closed: anything that isn't a string would be coerced to one below
  if (typeof hostname !== 'string') return true
  // Characters that end a host or add a port or user to it
  if (/[/\\?#@:]/.test(hostname)) return true
  let url: URL
  try {
    url = new URL(`https://${hostname}/`)
  } catch {
    return true
  }
  const host = url.hostname
  // An empty label stops the parser reading a short IPv4 form as an address
  // (127.1.. stays as written), so a host with one is refused. That includes
  // the empty label a trailing dot leaves: the Workers runtime fails the TLS
  // host check on such a name, so it is refused here with a clear error.
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return true
  // A public name has at least two labels; a bare one (internal, corp, metadata)
  // is resolved by the local network's search domain
  if (!host.includes('.')) return true
  // Only domain names are fetched: block every IPv4 address (IPv6 has a colon)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  // Block localhost variants and internal/common private TLDs
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.corp') || host.endsWith('.lan')) return true
  // home.arpa is reserved for home networks (RFC 8375); the name itself counts too
  if (host === 'home.arpa' || host.endsWith('.home.arpa')) return true
  return false
}

/** Validate that a URL is HTTPS and points to a public host (SSRF protection). */
export function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr)
    if (url.protocol !== 'https:') return false
    return !isPrivateHostname(url.hostname)
  } catch {
    return false
  }
}

export interface ValidationError {
  index: number
  error: string
}

// Workers KV rejects keys over 512 bytes (developers.cloudflare.com/kv/platform/limits).
// A claim whose cache key would exceed that can never be looked up, and the failed
// lookup takes the whole batch down with it. The sign-in record key is only looked up
// for sign-in platforms, but it is checked for all: no real handle comes close.
const KV_MAX_KEY_BYTES = 512

function fitsStorageKeys(platform: string, identity: string, proof: string, pubkey: string): boolean {
  const normalizedPubkey = normalizePubkey(pubkey)
  const keys = [
    cacheKey(platform, identity, proof, normalizedPubkey),
    oauthVerificationKey(platform, identity, normalizedPubkey),
  ]
  const encoder = new TextEncoder()
  return keys.every(key => encoder.encode(key).length <= KV_MAX_KEY_BYTES)
}

export function validateClaim(claim: unknown, index: number): ValidationError | null {
  if (!claim || typeof claim !== 'object') {
    return { index, error: 'Invalid claim: expected an object with platform, identity, proof and pubkey' }
  }
  const c = claim as Partial<VerifyClaim>
  if (!c.pubkey || !isValidHexPubkey(c.pubkey)) {
    return { index, error: 'Invalid pubkey: must be 64-character hex' }
  }
  if (!c.platform || !isValidPlatform(c.platform)) {
    return { index, error: `Invalid platform: must be one of ${VALID_PLATFORMS.join(', ')}` }
  }
  if (!c.identity || !isValidIdentity(c.identity)) {
    return { index, error: 'Invalid identity' }
  }
  // Bluesky can verify via OAuth + identity-link records without a proof post ID.
  // A truthy non-string proof is not "empty"; it falls through to isValidProof and is rejected.
  const blueskyWithoutProof = c.platform === 'bluesky'
    && (!c.proof || (typeof c.proof === 'string' && c.proof.trim() === ''))
  if (!blueskyWithoutProof && (!c.proof || !isValidProof(c.proof))) {
    return { index, error: 'Invalid proof' }
  }
  const proof = typeof c.proof === 'string' ? c.proof : ''
  // An unpaired UTF-16 surrogate can't be encoded into a storage key: local Workers KV
  // rejects such keys outright, which would also take the whole batch down.
  if (/\p{Cs}/u.test(c.identity) || /\p{Cs}/u.test(proof)) {
    return { index, error: 'Invalid claim: identity or proof contains malformed text' }
  }
  if (!fitsStorageKeys(c.platform, c.identity, proof, c.pubkey)) {
    return { index, error: 'Invalid claim: identity and proof are too long' }
  }
  return null
}

export function validateNip05Name(name: string): { local: string; domain: string } | null {
  if (!name || typeof name !== 'string') return null
  const parts = name.split('@')
  if (parts.length !== 2) return null
  const [local, domain] = parts
  if (!local || !domain) return null
  // domain: valid hostname with at least one dot, no leading/trailing/consecutive dots or hyphens
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(domain)) return null
  if (isPrivateHostname(domain)) return null
  // local part: alphanumeric, underscores, hyphens, dots, or _ for root
  if (!/^[a-zA-Z0-9._-]+$/.test(local)) return null
  return { local, domain }
}
