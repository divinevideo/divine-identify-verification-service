import type { PlatformVerifier } from './base'
import { DIVINE_IDENTITY_LINK_COLLECTION, matchNostrIdentityLinkRecord } from '../identity-link'

export class BlueskyVerifier implements PlatformVerifier {
  readonly name = 'bluesky'
  readonly label = 'Bluesky'

  async verify(
    identity: string,
    proof: string,
    npub: string
  ): Promise<{ verified: boolean; error?: string; method?: 'identity_link' | 'proof_post'; provenance?: { method: 'identity_link' | 'proof_post'; collection?: string; at_uri?: string; evidence?: string[]; gateway?: { domain?: string; did?: string } } }> {
    // Prefer deterministic identity-link records over public proof posts.
    const identityLink = await this.verifyIdentityLinkRecord(identity, npub)
    if (identityLink) {
      return identityLink
    }

    // Fall back to legacy proof-post verification.
    if (!proof) {
      return { verified: false, error: 'No identity link record found and no Bluesky post proof provided' }
    }

    // Build AT URI from identity (DID or handle) and proof (rkey)
    const atUri = `at://${identity}/app.bsky.feed.post/${proof}`
    const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(atUri)}&depth=0`

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'divine-identity-verification-service',
      },
    })

    if (response.status === 400 || response.status === 404) {
      return { verified: false, error: 'Bluesky post not found' }
    }
    if (!response.ok) {
      return { verified: false, error: `Bluesky API error: ${response.status}` }
    }

    let data: {
      thread?: {
        post?: {
          author?: { handle?: string; did?: string }
          record?: { text?: string }
        }
      }
    }
    try {
      data = await response.json() as typeof data
    } catch {
      return { verified: false, error: 'Invalid JSON response from Bluesky' }
    }

    // Verify the post author matches the claimed identity
    const authorHandle = data.thread?.post?.author?.handle?.toLowerCase()
    const authorDid = data.thread?.post?.author?.did?.toLowerCase()
    const claimedIdentity = identity.toLowerCase()
    if (authorHandle !== claimedIdentity && authorDid !== claimedIdentity) {
      return { verified: false, error: 'Post author does not match claimed identity' }
    }

    const text = data.thread?.post?.record?.text
    if (text && text.includes(npub)) {
      return {
        verified: true,
        method: 'proof_post',
        provenance: {
          method: 'proof_post',
          at_uri: atUri,
          evidence: [atUri],
        },
      }
    }

    return { verified: false, error: 'npub not found in Bluesky post' }
  }

  private async verifyIdentityLinkRecord(
    identity: string,
    npub: string
  ): Promise<{ verified: boolean; method: 'identity_link'; provenance: { method: 'identity_link'; collection: string; at_uri?: string; evidence?: string[]; gateway?: { domain?: string; did?: string } } } | null> {
    const url = `https://public.api.bsky.app/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(identity)}&collection=${encodeURIComponent(DIVINE_IDENTITY_LINK_COLLECTION)}&limit=100`
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'divine-identity-verification-service',
      },
    })

    if (response.status === 400 || response.status === 404) {
      return null
    }
    if (!response.ok) {
      return null
    }

    let data: {
      records?: Array<{ uri?: string; value?: unknown; record?: unknown }>
    }
    try {
      data = await response.json() as typeof data
    } catch {
      return null
    }

    for (const recordEntry of data.records || []) {
      const record = recordEntry.value ?? recordEntry.record
      const match = matchNostrIdentityLinkRecord(record, npub)
      if (!match.matched) continue
      const evidence = typeof recordEntry.uri === 'string' ? [recordEntry.uri] : undefined
      return {
        verified: true,
        method: 'identity_link',
        provenance: {
          method: 'identity_link',
          collection: DIVINE_IDENTITY_LINK_COLLECTION,
          at_uri: typeof recordEntry.uri === 'string' ? recordEntry.uri : undefined,
          evidence,
          gateway: match.gateway,
        },
      }
    }

    return null
  }
}
