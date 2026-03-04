import type { PlatformVerifier } from './base'

export class BlueskyVerifier implements PlatformVerifier {
  readonly name = 'bluesky'
  readonly label = 'Bluesky'

  async verify(identity: string, proof: string, npub: string): Promise<{ verified: boolean; error?: string }> {
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
      return { verified: true }
    }

    return { verified: false, error: 'npub not found in Bluesky post' }
  }
}
