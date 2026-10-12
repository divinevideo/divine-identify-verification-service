// ABOUTME: Tidies the account and proof people paste (a leading @, a full post
// ABOUTME: link) into the form each platform check expects. Pure: never fetches.

export interface TidiedClaim {
  identity: string
  proof: string
}

const TWITTER_HOSTS = ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']
const YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']
const YOUTUBE_EMBED_HOSTS = ['www.youtube-nocookie.com', 'youtube-nocookie.com']
const AT_PREFIX = ['twitter', 'bluesky', 'github', 'telegram', 'tiktok']

// A pasted http(s) link, or null. Only links are parsed; other text is left alone.
function link(text: string): URL | null {
  if (!/^https?:\/\//i.test(text)) return null
  try {
    return new URL(text)
  } catch {
    return null
  }
}

function parts(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean)
}

function on(url: URL, hosts: string[]): boolean {
  return hosts.includes(url.hostname.toLowerCase())
}

function twitterProof(proof: string): string | null {
  const url = link(proof)
  if (!url || !on(url, TWITTER_HOSTS)) return null
  // /<user>/status/<id>, /i/status/<id> and /i/web/status/<id>, maybe followed by /photo/1.
  const segments = parts(url)
  const at = segments[0] === 'i' && segments[1] === 'web' ? 2 : 1
  const [status, id] = segments.slice(at)
  return status === 'status' && /^\d+$/.test(id ?? '') ? id : null
}

function blueskyProof(proof: string): string | null {
  const atUri = proof.match(/^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:-]+)$/)
  if (atUri) return atUri[1]
  const url = link(proof)
  if (!url || !on(url, ['bsky.app'])) return null
  const [profile, , post, rkey] = parts(url)
  return profile === 'profile' && post === 'post' && rkey ? rkey : null
}

function githubProof(proof: string): string | null {
  const url = link(proof)
  if (!url || !on(url, ['gist.github.com', 'gist.githubusercontent.com'])) return null
  // /<user>/<id> or, on gist.github.com, /<id>; a clone (.git) or embed (.js) link names the same gist.
  const segments = parts(url)
  const candidate = (segments.length === 1 && on(url, ['gist.github.com']) ? segments[0] : segments[1] ?? '')
    .replace(/\.(git|js)$/, '')
  return /^[0-9a-f]+$/i.test(candidate) ? candidate : null
}

const TELEGRAM_HOSTS = ['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me', 'telegram.dog']

// A public post: exactly <channel>/<post>. Private links (c/...) can't be read
// publicly, and forum-topic links have a third part, so neither is rewritten.
function telegramPost(channel: string | undefined, id: string | undefined): string | null {
  return channel && channel !== 'c' && /^[A-Za-z0-9_]+$/.test(channel) && /^\d+$/.test(id ?? '') ? `${channel}/${id}` : null
}

function telegramProof(proof: string): string | null {
  const bare = proof.match(/^s\/([A-Za-z0-9_]+)\/(\d+)$/)
  if (bare) return telegramPost(bare[1], bare[2])
  const url = link(proof)
  if (!url) return null
  const host = url.hostname.toLowerCase()
  const segments = parts(url)
  // <channel>.t.me/<post>
  if (host.endsWith('.t.me') && host !== 'www.t.me') {
    return segments.length === 1 ? telegramPost(host.slice(0, -'.t.me'.length), segments[0]) : null
  }
  if (!TELEGRAM_HOSTS.includes(host)) return null
  const post = segments[0] === 's' ? segments.slice(1) : segments
  return post.length === 2 ? telegramPost(post[0], post[1]) : null
}

// Mastodon status ids are opaque strings; servers use letters and digits.
const STATUS_ID = /^[A-Za-z0-9]+$/

// A local account in a path: "@alice", not "@alice@other.server". A post seen
// through another server has that server's id, which the account's own server
// doesn't know, so remote views are not rewritten.
function localAccount(segment: string | undefined): boolean {
  return !!segment && segment.startsWith('@') && segment.indexOf('@', 1) === -1
}

function mastodonProof(proof: string): string | null {
  const url = link(proof)
  if (!url) return null
  const segments = parts(url)
  const post = segments[0] === 'web' ? segments.slice(1) : segments
  // /@user/<id>, /@user/<id>/embed and /web/@user/<id>
  if (localAccount(post[0]) && STATUS_ID.test(post[1] ?? '')
    && (post.length === 2 || (post.length === 3 && post[2] === 'embed' && segments[0] !== 'web'))) return post[1]
  // /users/<user>/statuses/<id> (not /activity, which is a boost)
  if (segments.length === 4 && segments[0] === 'users' && segments[2] === 'statuses' && STATUS_ID.test(segments[3])) return segments[3]
  return null
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

function youtubeProof(proof: string): string | null {
  const url = link(proof)
  if (!url) return null
  if (on(url, ['youtu.be'])) {
    const [id] = parts(url)
    return VIDEO_ID.test(id ?? '') ? id : null
  }
  if (!on(url, [...YOUTUBE_HOSTS, ...YOUTUBE_EMBED_HOSTS])) return null
  const [kind, id] = parts(url)
  if (on(url, YOUTUBE_EMBED_HOSTS)) return kind === 'embed' && VIDEO_ID.test(id ?? '') ? id : null
  if (kind === 'watch') {
    const v = url.searchParams.get('v') ?? ''
    return VIDEO_ID.test(v) ? v : null
  }
  return ['shorts', 'live', 'embed'].includes(kind ?? '') && VIDEO_ID.test(id ?? '') ? id : null
}

function youtubeIdentity(identity: string): string | null {
  const url = link(identity)
  if (!url || !on(url, YOUTUBE_HOSTS)) return null
  const [first, second] = parts(url)
  if (first === 'channel' && /^UC[A-Za-z0-9_-]{22}$/.test(second ?? '')) return second
  return first?.startsWith('@') && first.length > 1 ? first : null
}

const PROOF_TIDIERS: Record<string, (proof: string) => string | null> = {
  twitter: twitterProof,
  bluesky: blueskyProof,
  github: githubProof,
  telegram: telegramProof,
  mastodon: mastodonProof,
  youtube: youtubeProof,
}

/**
 * The account and proof in the form each platform's check expects. Only exact,
 * known shapes are rewritten; anything else comes back trimmed and otherwise as
 * sent, so the platform check answers it as it always has.
 */
export function tidyClaim(platform: string, identity: string, proof: string): TidiedClaim {
  let tidyIdentity = identity.trim()
  const tidyProof = proof.trim()

  if (AT_PREFIX.includes(platform) && tidyIdentity.startsWith('@') && tidyIdentity.length > 1) {
    tidyIdentity = tidyIdentity.slice(1)
  }
  if (platform === 'youtube') tidyIdentity = youtubeIdentity(tidyIdentity) ?? tidyIdentity

  const tidier = PROOF_TIDIERS[platform]
  const resolvedProof = (tidier && tidier(tidyProof)) || tidyProof

  // A t.me/s/<channel> link read as account "s": /s/ is Telegram's public
  // preview path, not an account, so the channel is the account.
  if (platform === 'telegram' && tidyIdentity.toLowerCase() === 's' && resolvedProof.includes('/')) {
    tidyIdentity = resolvedProof.split('/')[0]
  }

  return {
    identity: tidyIdentity || identity,
    proof: resolvedProof || proof,
  }
}
