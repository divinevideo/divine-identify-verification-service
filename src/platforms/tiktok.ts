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
  if (url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  if (host !== 'www.tiktok.com' && host !== 'tiktok.com') return null
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length !== 1) return null
  const segment = segments[0]
  if (!segment.startsWith('@') || segment.length < 2) return null
  return segment.slice(1)
}

// What a TikTok proof can be: a post number, a link to a video or photo post
// (any of TikTok's own hosts, with or without https:// and tracking
// parameters, including embed links), or a share link (vm./vt.tiktok.com/<code>,
// or tiktok.com/t/<code>), which redirects to the post. Profile links are
// recognized only to explain that they can't prove anything.
//
// Photo posts: TikTok's oEmbed rejects a /photo/ link (400) but answers for a
// photo post's number in the /video/ form, with its author and caption. Checked
// on 2026-10-02 against a real photo post; TikTok doesn't document this.
type TikTokProof =
  | { kind: 'video'; id: string }
  | { kind: 'share'; url: string }
  | { kind: 'profile' }
  | { kind: 'invalid' }

const TIKTOK_HOSTS = new Set(['www.tiktok.com', 'tiktok.com', 'm.tiktok.com'])
const TIKTOK_SHARE_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com'])

const SHARE_LINK_FAILED = 'Could not open that TikTok share link. Paste the full post link instead.'

function parseTikTokProof(proof: string): TikTokProof {
  const trimmed = proof.trim()
  if (/^\d{15,25}$/.test(trimmed)) return { kind: 'video', id: trimmed }

  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return { kind: 'invalid' }
  }
  const host = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)

  if (TIKTOK_SHARE_HOSTS.has(host)) {
    if (segments.length !== 1 || !/^[A-Za-z0-9]+$/.test(segments[0])) return { kind: 'invalid' }
    return { kind: 'share', url: `https://${host}/${segments[0]}/` }
  }
  if (!TIKTOK_HOSTS.has(host)) return { kind: 'invalid' }
  if (segments[0] === 't') {
    if (segments.length !== 2 || !/^[A-Za-z0-9]+$/.test(segments[1])) return { kind: 'invalid' }
    return { kind: 'share', url: `https://www.tiktok.com/t/${segments[1]}/` }
  }
  // Embed links (/embed/<id>, /embed/v2/<id>) and the older /v/<id>.html form.
  const isEmbed = segments[0] === 'embed' && (segments.length === 2 || (segments.length === 3 && segments[1] === 'v2'))
  if (isEmbed && /^\d{15,25}$/.test(segments[segments.length - 1])) return { kind: 'video', id: segments[segments.length - 1] }
  if (segments[0] === 'v' && segments.length === 2 && /^\d{15,25}\.html$/.test(segments[1])) {
    return { kind: 'video', id: segments[1].slice(0, -'.html'.length) }
  }
  if (!segments[0]?.startsWith('@') || segments[0].length < 2) return { kind: 'invalid' }
  if (segments.length === 1) return { kind: 'profile' }
  if (segments.length === 3 && /^\d{15,25}$/.test(segments[2])) {
    if (segments[1] === 'video' || segments[1] === 'photo') return { kind: 'video', id: segments[2] }
  }
  return { kind: 'invalid' }
}

// Follows one redirect from a TikTok share host and accepts only a landing on
// a TikTok video, photo or profile link over https. Never follows a second
// hop or leaves TikTok.
async function resolveShareLink(shareUrl: string): Promise<TikTokProof> {
  let response: Response
  try {
    response = await fetch(shareUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': 'divine-identity-verification-service' },
    })
  } catch {
    return { kind: 'invalid' }
  }
  // Only the status and Location matter; close the body so it isn't left open.
  try {
    await response.body?.cancel()
  } catch {}
  if (response.status < 300 || response.status > 399) return { kind: 'invalid' }
  const location = response.headers.get('Location')
  if (!location) return { kind: 'invalid' }
  let target: URL
  try {
    target = new URL(location, shareUrl)
  } catch {
    return { kind: 'invalid' }
  }
  if (target.protocol !== 'https:') return { kind: 'invalid' }
  const landed = parseTikTokProof(target.toString())
  return landed.kind === 'video' || landed.kind === 'profile' ? landed : { kind: 'invalid' }
}

export class TikTokVerifier implements PlatformVerifier {
  readonly name = 'tiktok'
  readonly label = 'TikTok'

  async verify(identity: string, proof: string, npub: string): Promise<{ verified: boolean; error?: string; canonicalProof?: string }> {
    // Validate username format (1-24 chars, alphanumeric + . and _)
    if (!/^[a-zA-Z0-9._]{1,24}$/.test(identity)) {
      return { verified: false, error: 'Invalid TikTok username format' }
    }

    let parsed = parseTikTokProof(proof)
    if (parsed.kind === 'share') {
      parsed = await resolveShareLink(parsed.url)
      if (parsed.kind === 'invalid') return { verified: false, error: SHARE_LINK_FAILED }
    }
    if (parsed.kind === 'profile') {
      return { verified: false, error: 'That is a TikTok profile link. Paste a link to a video whose caption contains your npub.' }
    }
    if (parsed.kind !== 'video') {
      return { verified: false, error: 'Paste a TikTok video or photo link (or the post number from it).' }
    }
    const videoId = parsed.id

    const videoUrl = `https://www.tiktok.com/@${encodeURIComponent(identity)}/video/${encodeURIComponent(videoId)}`
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`

    let response: Response
    try {
      response = await fetch(oembedUrl, {
        headers: { 'User-Agent': 'divine-identity-verification-service' },
      })
    } catch {
      return { verified: false, error: 'Failed to fetch TikTok video' }
    }

    // TikTok's oEmbed answers 400 ("Something went wrong") for a post that
    // doesn't exist or isn't public (checked 2026-10-02). 404 is treated the
    // same way, as it was before.
    if (response.status === 400 || response.status === 404) {
      return { verified: false, error: 'TikTok post not found or not public' }
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
      return { verified: false, error: 'TikTok did not say who posted this video, so it cannot be checked.' }
    }
    if (handle.toLowerCase() !== identity.toLowerCase()) {
      return { verified: false, error: 'Video author does not match claimed identity' }
    }

    // Search title (caption) for npub
    const title = data.title || ''
    if (title.includes(npub)) {
      // Report the post number for publishing, not the link: it is the only
      // form this verifier accepted before, so claims stay checkable by
      // older deployments, and a share link would need following again.
      return videoId === proof ? { verified: true } : { verified: true, canonicalProof: videoId }
    }

    return { verified: false, error: 'npub not found in video caption' }
  }
}
