import type { PlatformVerifier } from './base'

interface TikTokOEmbedResponse {
  // Display name (nickname); not unique, so unsuitable for ownership checks.
  author_name?: string
  // The @handle. Unique per account and what the video URL encodes.
  author_unique_id?: string
  title?: string
}

export class TikTokVerifier implements PlatformVerifier {
  readonly name = 'tiktok'
  readonly label = 'TikTok'

  async verify(identity: string, proof: string, npub: string): Promise<{ verified: boolean; error?: string }> {
    // Validate video ID format (numeric, typically 19 digits but can vary)
    if (!/^\d{15,25}$/.test(proof)) {
      return { verified: false, error: 'Invalid TikTok video ID format' }
    }

    // Validate username format (1-24 chars, alphanumeric + . and _)
    if (!/^[a-zA-Z0-9._]{1,24}$/.test(identity)) {
      return { verified: false, error: 'Invalid TikTok username format' }
    }

    const videoUrl = `https://www.tiktok.com/@${encodeURIComponent(identity)}/video/${encodeURIComponent(proof)}`
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`

    let response: Response
    try {
      response = await fetch(oembedUrl, {
        headers: { 'User-Agent': 'divine-identity-verification-service' },
      })
    } catch {
      return { verified: false, error: 'Failed to fetch TikTok video' }
    }

    if (response.status === 404) {
      return { verified: false, error: 'TikTok video not found' }
    }
    if (!response.ok) {
      return { verified: false, error: `TikTok oEmbed error: ${response.status}` }
    }

    let data: TikTokOEmbedResponse
    try {
      data = await response.json() as TikTokOEmbedResponse
    } catch {
      return { verified: false, error: 'Invalid JSON response from TikTok oEmbed' }
    }

    // The claimed identity is the @handle parsed from the video URL, so match
    // it against oEmbed's author_unique_id. author_name is the display name,
    // which is neither unique nor tied to the handle and cannot prove
    // ownership.
    if (!data.author_unique_id) {
      return { verified: false, error: 'Unable to verify TikTok video author' }
    }
    if (data.author_unique_id.toLowerCase() !== identity.toLowerCase()) {
      return { verified: false, error: 'Video author does not match claimed identity' }
    }

    // Search title (caption) for npub
    const title = data.title || ''
    if (title.includes(npub)) {
      return { verified: true }
    }

    return { verified: false, error: 'npub not found in video caption' }
  }
}
