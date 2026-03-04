import type { PlatformVerifier } from './base'

export class TwitterVerifier implements PlatformVerifier {
  readonly name = 'twitter'
  readonly label = 'Twitter / X'

  async verify(identity: string, proof: string, npub: string): Promise<{ verified: boolean; error?: string }> {
    // Use Twitter's oEmbed endpoint which is publicly accessible
    const tweetUrl = `https://x.com/${identity}/status/${proof}`
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}&omit_script=true`

    const response = await fetch(oembedUrl, {
      headers: { 'User-Agent': 'divine-identity-verification-service' },
    })

    if (response.status === 404) {
      return { verified: false, error: 'Tweet not found' }
    }
    if (!response.ok) {
      return { verified: false, error: `Twitter oEmbed error: ${response.status}` }
    }

    let data: { html?: string; author_url?: string }
    try {
      data = await response.json() as typeof data
    } catch {
      return { verified: false, error: 'Invalid JSON response from Twitter oEmbed' }
    }

    // Verify the tweet author matches the claimed identity (mandatory check)
    if (!data.author_url) {
      return { verified: false, error: 'Unable to verify tweet author' }
    }
    const authorMatch = data.author_url.match(/(?:twitter|x)\.com\/(\w+)/)
    if (!authorMatch) {
      return { verified: false, error: 'Unable to parse tweet author URL' }
    }
    if (authorMatch[1].toLowerCase() !== identity.toLowerCase()) {
      return { verified: false, error: 'Tweet author does not match claimed identity' }
    }

    // Check the HTML content for the npub
    if (data.html && data.html.includes(npub)) {
      return { verified: true }
    }

    return { verified: false, error: 'npub not found in tweet content' }
  }
}
