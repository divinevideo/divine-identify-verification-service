export const DIVINE_IDENTITY_LINK_COLLECTION = 'video.divine.identity.link' as const
export const DIVINE_IDENTITY_LINK_TYPE = 'video.divine.identity.link' as const

export type VerificationMethod = 'proof_post' | 'oauth' | 'identity_link'

export interface GatewayProvenance {
  domain?: string
  did?: string
}

export interface VerificationProvenance {
  method: VerificationMethod
  collection?: string
  at_uri?: string
  evidence?: string[]
  gateway?: GatewayProvenance
}

export interface NostrIdentityLinkMatch {
  matched: boolean
  gateway?: GatewayProvenance
}

/**
 * Validate whether a record matches the expected Nostr npub link.
 * This is a strict shape check for v0 with case-insensitive npub comparison.
 */
export function matchNostrIdentityLinkRecord(record: unknown, expectedNpub: string): NostrIdentityLinkMatch {
  if (!record || typeof record !== 'object') return { matched: false }

  const data = record as {
    $type?: unknown
    version?: unknown
    target?: { protocol?: unknown; id?: unknown }
    gateway?: { domain?: unknown; did?: unknown }
  }

  if (data.$type !== DIVINE_IDENTITY_LINK_TYPE) return { matched: false }
  if (data.version !== 1) return { matched: false }
  if (!data.target || typeof data.target !== 'object') return { matched: false }
  if (typeof data.target.protocol !== 'string' || data.target.protocol.toLowerCase() !== 'nostr') {
    return { matched: false }
  }
  if (typeof data.target.id !== 'string') return { matched: false }

  if (data.target.id.toLowerCase() !== expectedNpub.toLowerCase()) {
    return { matched: false }
  }

  const gateway: GatewayProvenance | undefined = data.gateway && typeof data.gateway === 'object'
    ? {
        domain: typeof data.gateway.domain === 'string' ? data.gateway.domain : undefined,
        did: typeof data.gateway.did === 'string' ? data.gateway.did : undefined,
      }
    : undefined

  return { matched: true, gateway }
}
