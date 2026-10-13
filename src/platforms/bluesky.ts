import { discardBody, fetchFromPlatform, PlatformUnavailableError, readJson, throwIfUnanswered, type PlatformVerifier } from './base'
import { DIVINE_IDENTITY_LINK_COLLECTION, matchNostrIdentityLinkRecord } from '../identity-link'
import { resolveAtprotoIdentityPds } from '../atproto'
import { fetchPublic } from '../utils/safe-fetch'

export class BlueskyVerifier implements PlatformVerifier {
  readonly name = 'bluesky'
  readonly label = 'Bluesky'

  async verify(
    identity: string,
    proof: string,
    npub: string
  ): Promise<{ verified: boolean; error?: string; method?: 'identity_link' | 'proof_post'; provenance?: { method: 'identity_link' | 'proof_post'; collection?: string; at_uri?: string; evidence?: string[]; gateway?: { domain?: string; did?: string } } }> {
    // Prefer deterministic identity-link records over public proof posts.
    let recordUnavailable: PlatformUnavailableError | null = null
    try {
      const identityLink = await this.verifyIdentityLinkRecord(identity, npub)
      if (identityLink) {
        return identityLink
      }
    } catch (err) {
      if (!(err instanceof PlatformUnavailableError)) throw err
      recordUnavailable = err
    }

    // Fall back to legacy proof-post verification. A post that proves the claim
    // settles it even when the record couldn't be looked up; any other answer
    // from the post would leave a record we couldn't see unchecked, so it isn't
    // a verdict.
    const post = await this.verifyProofPost(identity, proof, npub)
    if (recordUnavailable && !post.verified) throw recordUnavailable
    return post
  }

  private async verifyProofPost(
    identity: string,
    proof: string,
    npub: string
  ): Promise<{ verified: boolean; error?: string; method?: 'proof_post'; provenance?: { method: 'proof_post'; at_uri: string; evidence: string[] } }> {
    if (!proof) {
      return { verified: false, error: 'No identity link record found and no Bluesky post proof provided' }
    }

    // Build AT URI from identity (DID or handle) and proof (rkey)
    const atUri = `at://${identity}/app.bsky.feed.post/${proof}`
    const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(atUri)}&depth=0`

    const response = await fetchFromPlatform(this.label, url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'divine-identity-verification-service',
      },
    })

    if (response.status === 400 || response.status === 404) {
      return { verified: false, error: 'Bluesky post not found' }
    }
    throwIfUnanswered(response, this.label)
    if (!response.ok) {
      return { verified: false, error: `Bluesky API error: ${response.status}` }
    }

    const data = await readJson<{
      thread?: {
        post?: {
          author?: { handle?: string; did?: string }
          record?: { text?: string }
        }
      }
    }>(response, this.label)
    if (data === undefined) {
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
    const repo = await resolveAtprotoIdentityPds(identity)
    if (!repo) return null

    const url = `${repo.pdsEndpoint}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(repo.did)}&collection=${encodeURIComponent(DIVINE_IDENTITY_LINK_COLLECTION)}&limit=100`
    const response = await fetchFromPlatform('PDS', url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'divine-identity-verification-service',
      },
    }, fetchPublic)

    if (response.status === 400 || response.status === 404) {
      await discardBody(response)
      return null
    }
    throwIfUnanswered(response, 'PDS')
    if (!response.ok) {
      await discardBody(response)
      return null
    }

    const data = await readJson<{
      records?: Array<{ uri?: string; value?: unknown; record?: unknown }>
    }>(response, 'PDS')
    if (data === undefined) return null

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
