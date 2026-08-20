import type { PlatformVerifier } from './base'

interface TikTokOEmbedResponse {
  // Display name (nickname); not unique, so unsuitable for ownership checks.
  author_name?: string
  // The @handle. Unique per account and what the video URL encodes. Present
  // in current responses but not part of TikTok's documented oEmbed schema.
  author_unique_id?: string
  // Documented field, of the form https://www.tiktok.com/@handle. Used as a
  // fallback source of the handle if author_unique_id is ever dropped.
  author_url?: string
  title?: string
}

// Returns the @handle from a documented TikTok author_url
// (https://www.tiktok.com/@handle), or null for anything that is not that
// exact shape, so callers fail closed on untrusted or malformed URLs.
function handleFromAuthorUrl(authorUrl: string | undefined): string | null {
  if (!authorUrl) return null
  let url: URL
  try {
    url = new URL(authorUrl)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (host !== 'www.tiktok.com' && host !== 'tiktok.com') return null
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length !== 1) return null
  const segment = segments[0]
  if (!segment.startsWith('@') || segment.length < 2) return null
  return segment.slice(1)
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

    // The claimed identity is the @handle parsed from the video URL. Match it
    // against the handle TikTok reports: author_unique_id when present, else
    // the @handle in the documented author_url (so this keeps working if the
    // undocumented author_unique_id is ever dropped). Both are set by TikTok,
    // not the poster. author_name is the display name — not unique, not tied
    // to the handle — and cannot prove ownership.
    const handle = data.author_unique_id || handleFromAuthorUrl(data.author_url)
    if (!handle) {
      return { verified: false, error: 'Unable to verify TikTok video author' }
    }
    if (handle.toLowerCase() !== identity.toLowerCase()) {
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
