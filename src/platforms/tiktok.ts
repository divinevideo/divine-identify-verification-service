import type { PlatformVerifier } from './base'

interface TikTokOEmbedResponse {
  author_name?: string
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

    // Verify author matches identity (case-insensitive)
    if (!data.author_name) {
      return { verified: false, error: 'Unable to verify TikTok video author' }
    }
    if (data.author_name.toLowerCase() !== identity.toLowerCase()) {
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
