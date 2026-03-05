import { Hono } from 'hono'
import type { Bindings, Platform, VerifyClaim, VerifyResult, CachedResult } from '../types'
import { validateClaim, isValidPlatform, isValidHexPubkey, isValidIdentity, isValidProof, normalizePubkey } from '../utils/validation'
import { hexToNpub } from '../utils/npub'
import { cacheKey, getCached, putCached } from '../utils/cache'
import { checkRateLimit, RATE_LIMITS } from '../utils/rate-limit'
import { getVerifier } from '../platforms/registry'
import { getOAuthVerification } from '../oauth/state'

const verify = new Hono<{ Bindings: Bindings }>()

const MAX_BATCH_SIZE = 10

async function verifySingleClaim(
  claim: VerifyClaim,
  env: Bindings,
  clientIp: string
): Promise<VerifyResult> {
  const now = Math.floor(Date.now() / 1000)
  // Normalize pubkey to lowercase for consistent cache keys
  const normalizedClaim = { ...claim, pubkey: normalizePubkey(claim.pubkey) }
  const key = cacheKey(normalizedClaim.platform, normalizedClaim.identity, normalizedClaim.proof, normalizedClaim.pubkey)

  // Check cache first
  const cached = await getCached(env.CACHE_KV, key)
  if (cached) {
    return {
      platform: normalizedClaim.platform,
      identity: normalizedClaim.identity,
      verified: cached.verified,
      error: cached.error,
      checked_at: cached.checked_at,
      cached: true,
    }
  }

  // Check for OAuth verification (backup method for twitter/bluesky/youtube/tiktok)
  if (normalizedClaim.platform === 'twitter' || normalizedClaim.platform === 'bluesky' || normalizedClaim.platform === 'youtube' || normalizedClaim.platform === 'tiktok') {
    const oauthResult = await getOAuthVerification(env.CACHE_KV, normalizedClaim.platform, normalizedClaim.identity, normalizedClaim.pubkey)
    if (oauthResult) {
      return {
        platform: normalizedClaim.platform,
        identity: normalizedClaim.identity,
        verified: true,
        checked_at: oauthResult.checked_at,
        cached: true,
      }
    }
  }

  // Check rate limits (pubkey + platform) — checkRateLimit increments in one step
  const pubkeyLimit = await checkRateLimit(env.RATE_LIMIT_KV, RATE_LIMITS.pubkey, normalizedClaim.pubkey)
  if (!pubkeyLimit.allowed) {
    return {
      platform: normalizedClaim.platform,
      identity: normalizedClaim.identity,
      verified: false,
      error: 'Rate limit exceeded for this pubkey',
      checked_at: now,
      cached: false,
    }
  }

  const platformLimit = await checkRateLimit(env.RATE_LIMIT_KV, RATE_LIMITS.platform, normalizedClaim.platform)
  if (!platformLimit.allowed) {
    return {
      platform: normalizedClaim.platform,
      identity: normalizedClaim.identity,
      verified: false,
      error: `Rate limit exceeded for ${normalizedClaim.platform}`,
      checked_at: now,
      cached: false,
    }
  }

  // Convert hex pubkey to npub for content search
  const npub = hexToNpub(normalizedClaim.pubkey)

  // Perform verification
  const verifier = getVerifier(normalizedClaim.platform, env.GITHUB_TOKEN, env.YOUTUBE_API_KEY)
  try {
    const result = await verifier.verify(normalizedClaim.identity, normalizedClaim.proof, npub)

    // Cache the result
    const cacheResult: CachedResult = {
      verified: result.verified,
      error: result.error,
      checked_at: now,
      type: result.verified ? 'verified' : 'failed',
    }
    await putCached(env.CACHE_KV, key, cacheResult)

    return {
      platform: normalizedClaim.platform,
      identity: normalizedClaim.identity,
      verified: result.verified,
      error: result.error,
      checked_at: now,
      cached: false,
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown verification error'

    // Cache as platform error (short TTL)
    const cacheResult: CachedResult = {
      verified: false,
      error,
      checked_at: now,
      type: 'platform_error',
    }
    await putCached(env.CACHE_KV, key, cacheResult)

    return {
      platform: normalizedClaim.platform,
      identity: normalizedClaim.identity,
      verified: false,
      error,
      checked_at: now,
      cached: false,
    }
  }
}

// POST /verify — batch verification
verify.post('/', async (c) => {
  const clientIp = c.req.header('cf-connecting-ip') || 'unknown'

  // IP rate limit
  const ipLimit = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.ip, clientIp)
  if (!ipLimit.allowed) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }

  let body: { claims?: VerifyClaim[] }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (!body.claims || !Array.isArray(body.claims)) {
    return c.json({ error: 'Missing or invalid "claims" array' }, 400)
  }

  if (body.claims.length === 0) {
    return c.json({ error: 'Claims array is empty' }, 400)
  }

  if (body.claims.length > MAX_BATCH_SIZE) {
    return c.json({ error: `Maximum ${MAX_BATCH_SIZE} claims per request` }, 400)
  }

  // Validate all claims
  const errors: { index: number; error: string }[] = []
  for (let i = 0; i < body.claims.length; i++) {
    const err = validateClaim(body.claims[i], i)
    if (err) errors.push(err)
  }
  if (errors.length > 0) {
    return c.json({ error: 'Validation failed', details: errors }, 400)
  }

  // Verify all claims concurrently
  const results = await Promise.all(
    body.claims.map(claim => verifySingleClaim(claim, c.env, clientIp))
  )

  return c.json({ results })
})

// POST /verify/single — single claim verification (divine-web compatibility)
// divine-web sends { platform, identity, proof, pubkey } as a flat object
verify.post('/single', async (c) => {
  const clientIp = c.req.header('cf-connecting-ip') || 'unknown'

  const ipLimit = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.ip, clientIp)
  if (!ipLimit.allowed) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }

  let body: { platform?: string; identity?: string; proof?: string; pubkey?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (!body.platform || !isValidPlatform(body.platform)) {
    return c.json({ error: 'Invalid or missing platform' }, 400)
  }
  if (!body.pubkey || !isValidHexPubkey(body.pubkey)) {
    return c.json({ error: 'Invalid or missing pubkey (64-char hex)' }, 400)
  }
  if (!body.identity || !isValidIdentity(body.identity)) {
    return c.json({ error: 'Invalid or missing identity' }, 400)
  }
  if (!body.proof || !isValidProof(body.proof)) {
    return c.json({ error: 'Invalid or missing proof' }, 400)
  }

  const claim: VerifyClaim = {
    platform: body.platform as Platform,
    identity: body.identity,
    proof: body.proof,
    pubkey: body.pubkey,
  }
  const result = await verifySingleClaim(claim, c.env, clientIp)
  return c.json(result)
})

// GET /verify/:platform/* — single claim verification
// Wildcard handles Mastodon identity slashes: /verify/mastodon/mastodon.social/@user/123456?pubkey=hex
verify.get('/:platform/*', async (c) => {
  const clientIp = c.req.header('cf-connecting-ip') || 'unknown'

  // IP rate limit
  const ipLimit = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.ip, clientIp)
  if (!ipLimit.allowed) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }

  const platform = c.req.param('platform')
  const pubkey = c.req.query('pubkey')

  if (!platform || !isValidPlatform(platform)) {
    return c.json({ error: 'Invalid platform' }, 400)
  }
  if (!pubkey || !isValidHexPubkey(pubkey)) {
    return c.json({ error: 'Invalid or missing pubkey query parameter (64-char hex)' }, 400)
  }

  // Parse the wildcard path to extract identity and proof
  const prefix = `/verify/${platform}/`
  const prefixIdx = c.req.path.indexOf(prefix)
  if (prefixIdx === -1) {
    return c.json({ error: 'Invalid path' }, 400)
  }
  const wildcardPath = c.req.path.slice(prefixIdx + prefix.length)
  const lastSlash = wildcardPath.lastIndexOf('/')
  if (lastSlash === -1) {
    return c.json({ error: 'Invalid path: expected /verify/:platform/:identity/:proof' }, 400)
  }

  const identity = decodeURIComponent(wildcardPath.slice(0, lastSlash))
  const proof = decodeURIComponent(wildcardPath.slice(lastSlash + 1))

  if (!isValidIdentity(identity)) {
    return c.json({ error: 'Invalid identity' }, 400)
  }
  if (!isValidProof(proof)) {
    return c.json({ error: 'Invalid proof' }, 400)
  }

  const claim: VerifyClaim = { pubkey, platform: platform as Platform, identity, proof }
  const result = await verifySingleClaim(claim, c.env, clientIp)

  // Content negotiation: HTML for browsers, JSON for API clients
  const accept = c.req.header('accept') || ''
  const formatParam = c.req.query('format')
  if (formatParam === 'json') {
    return c.json(result)
  }
  if (accept.includes('text/html') && !accept.includes('application/json')) {
    const npub = hexToNpub(pubkey)
    const origin = new URL(c.req.url).origin
    return c.html(renderVerifyHtml(result, platform, identity, proof, pubkey, npub, c.req.url, origin))
  }

  return c.json(result)
})

const PLATFORM_LABELS: Record<string, string> = {
  github: 'GitHub',
  twitter: 'Twitter / X',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  telegram: 'Telegram',
  discord: 'Discord',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  nip05: 'NIP-05',
}

function proofUrl(platform: string, identity: string, proof: string): string | null {
  switch (platform) {
    case 'github': return `https://gist.github.com/${identity}/${proof}`
    case 'twitter': return `https://x.com/${identity}/status/${proof}`
    case 'bluesky': return `https://bsky.app/profile/${identity}/post/${proof}`
    case 'mastodon': {
      const instance = identity.split('/')[0]
      return `https://${instance}/statuses/${proof}`
    }
    case 'telegram': return `https://t.me/${proof}`
    case 'discord': return `https://discord.gg/${proof}`
    case 'youtube': return `https://www.youtube.com/watch?v=${proof}`
    case 'tiktok': return `https://www.tiktok.com/@${identity}/video/${proof}`
    default: return null
  }
}

function platformIcon(platform: string): string {
  switch (platform) {
    case 'github': return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>'
    case 'twitter': return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>'
    case 'bluesky': return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C7.8 5.4 5 9 5 11.5c0 2.5 1.2 3.6 2.5 3.8-1 .3-3.5 1-2.5 3.2.7 1.5 3.5 1.5 5 .5 1-.7 1.7-1.7 2-2.7.3 1 1 2 2 2.7 1.5 1 4.3 1 5-.5 1-2.2-1.5-2.9-2.5-3.2 1.3-.2 2.5-1.3 2.5-3.8 0-2.5-2.8-6.1-7-9.5z"/></svg>'
    case 'mastodon': return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 00.023-.043v-1.809a.052.052 0 00-.02-.041.053.053 0 00-.046-.01 20.282 20.282 0 01-4.709.547c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 01-.319-1.433.053.053 0 01.066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.668 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z"/></svg>'
    case 'telegram': return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>'
    case 'discord': return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1569 2.4189z"/></svg>'
    case 'youtube': return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>'
    case 'tiktok': return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>'
    case 'nip05': return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
    default: return ''
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function renderVerifyHtml(result: VerifyResult, platform: string, identity: string, proof: string, pubkey: string, npub: string, requestUrl: string, apiOrigin: string): string {
  const verified = result.verified
  const platformLabel = PLATFORM_LABELS[platform] || platform
  const statusText = verified ? 'Verified' : 'Not Verified'
  const checkedAt = result.checked_at ? new Date(result.checked_at * 1000).toUTCString() : 'N/A'
  const proofLink = proofUrl(platform, identity, proof)
  const profileUrl = `https://divine.video/profile/${npub}`
  const ogTitle = verified
    ? `${identity} is verified on ${platformLabel}`
    : `${identity} on ${platformLabel} — verification failed`
  const ogDescription = verified
    ? `${identity}'s ${platformLabel} account is cryptographically linked to their Nostr identity via Divine.`
    : `Verification of ${identity} on ${platformLabel} did not pass.`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(identity)} on ${esc(platformLabel)} — Divine Identity Verification</title>

  <!-- OpenGraph -->
  <meta property="og:title" content="${esc(ogTitle)}">
  <meta property="og:description" content="${esc(ogDescription)}">
  <meta property="og:type" content="profile">
  <meta property="og:url" content="${esc(requestUrl)}">
  <meta property="og:site_name" content="Divine Identity Verification">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${esc(ogTitle)}">
  <meta name="twitter:description" content="${esc(ogDescription)}">
  <!-- og:image is set dynamically via JS if avatar is found -->

  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6; color: #333; background: #f8fafc;
      min-height: 100vh;
    }
    .container { max-width: 600px; margin: 0 auto; padding: 2rem 1rem; }

    /* Profile header */
    .profile-header {
      background: white; border-radius: 16px; padding: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 1rem;
      display: flex; align-items: center; gap: 1rem;
    }
    .profile-header.loading { min-height: 80px; }
    .avatar {
      width: 64px; height: 64px; border-radius: 50%; object-fit: cover;
      background: #e2e8f0; flex-shrink: 0;
    }
    .avatar-placeholder {
      width: 64px; height: 64px; border-radius: 50%; background: #e2e8f0;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      color: #a0aec0; font-size: 1.5rem;
    }
    .profile-info { min-width: 0; }
    .display-name { font-size: 1.25rem; font-weight: 700; color: #1a202c; }
    .nip05 { font-size: 0.85rem; color: #718096; }
    .npub-display {
      font-size: 0.75rem; color: #a0aec0; word-break: break-all;
      font-family: 'SF Mono', Menlo, Consolas, monospace;
    }
    .profile-links { display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
    .profile-links a {
      font-size: 0.8rem; color: #4299e1; text-decoration: none;
      background: #ebf8ff; padding: 0.2rem 0.6rem; border-radius: 6px;
    }
    .profile-links a:hover { background: #bee3f8; }

    /* Main verification card */
    .verify-card {
      background: white; border-radius: 16px; overflow: hidden;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08); margin-bottom: 1rem;
    }
    .status-bar {
      padding: 1rem 1.5rem; display: flex; align-items: center; gap: 0.75rem;
      font-size: 1.1rem; font-weight: 700;
    }
    .status-bar.verified { background: #c6f6d5; color: #276749; }
    .status-bar.failed { background: #fed7d7; color: #c53030; }
    .status-icon { font-size: 1.4rem; }
    .verify-body { padding: 1.5rem; }
    .claim-row {
      display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem;
      padding-bottom: 1rem; border-bottom: 1px solid #edf2f7;
    }
    .claim-row:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
    .platform-icon { color: #4a5568; flex-shrink: 0; display: flex; align-items: center; }
    .claim-details { flex: 1; min-width: 0; }
    .claim-platform { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #718096; font-weight: 600; }
    .claim-identity { font-size: 1rem; color: #1a202c; }
    .claim-links { display: flex; gap: 0.5rem; margin-top: 0.25rem; }
    .claim-links a {
      font-size: 0.75rem; color: #4299e1; text-decoration: none;
    }
    .claim-links a:hover { text-decoration: underline; }
    .claim-status { flex-shrink: 0; font-size: 1.2rem; }

    .error-msg {
      background: #fff5f5; border: 1px solid #fed7d7; border-radius: 8px;
      padding: 0.75rem 1rem; color: #c53030; font-size: 0.9rem; margin-bottom: 1rem;
    }
    .meta {
      display: flex; gap: 1.5rem; flex-wrap: wrap; padding-top: 1rem;
      border-top: 1px solid #e2e8f0; font-size: 0.8rem; color: #a0aec0;
    }

    /* Other identities */
    .other-identities {
      background: white; border-radius: 16px; padding: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 1rem;
    }
    .section-title {
      font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em;
      color: #718096; font-weight: 600; margin-bottom: 1rem;
    }
    .identity-item {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.5rem 0; border-bottom: 1px solid #f7fafc;
    }
    .identity-item:last-child { border-bottom: none; }
    .identity-item .platform-icon { color: #4a5568; }
    .identity-item .claim-identity { font-size: 0.9rem; }
    .identity-item .claim-links a { font-size: 0.7rem; }
    .identity-loading {
      color: #a0aec0; font-size: 0.85rem; padding: 0.5rem 0;
      display: flex; align-items: center; gap: 0.5rem;
    }
    .spinner {
      width: 14px; height: 14px; border: 2px solid #e2e8f0;
      border-top-color: #4299e1; border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Footer */
    .page-footer {
      text-align: center; padding: 1.5rem 0; color: #a0aec0; font-size: 0.8rem;
    }
    .page-footer a { color: #4299e1; text-decoration: none; }
    .page-footer a:hover { text-decoration: underline; }
    .json-link { color: #a0aec0; font-size: 0.75rem; }
  </style>
</head>
<body>
  <div class="container">
    <!-- Profile header (populated by JS) -->
    <div id="profile-header" class="profile-header loading" style="display:none;"></div>

    <!-- Main verification result -->
    <div class="verify-card">
      <div class="status-bar ${verified ? 'verified' : 'failed'}">
        <span class="status-icon">${verified ? '&#10004;' : '&#10008;'}</span>
        <span>${esc(identity)} ${verified ? 'is verified' : 'is not verified'} on ${esc(platformLabel)}</span>
      </div>
      <div class="verify-body">
        <div class="claim-row">
          <div class="platform-icon">${platformIcon(platform)}</div>
          <div class="claim-details">
            <div class="claim-platform">${esc(platformLabel)}</div>
            <div class="claim-identity">${esc(identity)}</div>
            <div class="claim-links">
              ${proofLink ? `<a href="${esc(proofLink)}" target="_blank" rel="noopener">View proof post ↗</a>` : ''}
            </div>
          </div>
          <div class="claim-status">${verified ? '&#9989;' : '&#10060;'}</div>
        </div>
        ${result.error ? `<div class="error-msg">${esc(result.error)}</div>` : ''}
        <div class="meta">
          <span>Checked: ${esc(checkedAt)}</span>
          <span>${result.cached ? 'Cached' : 'Fresh'}</span>
        </div>
      </div>
    </div>

    <!-- Other verified identities (populated by JS) -->
    <div id="other-identities" style="display:none;"></div>

    <div class="page-footer">
      <a href="/">Divine Identity Verification Service</a> &middot; <a href="https://divine.video">divine.video</a>
      <br><a class="json-link" href="${esc(requestUrl + (requestUrl.includes('?') ? '&' : '?') + 'format=json')}">View as JSON</a>
    </div>
  </div>

  <script>
  (function() {
    var PUBKEY = '${esc(pubkey)}';
    var NPUB = '${esc(npub)}';
    var CURRENT_PLATFORM = '${esc(platform)}';
    var CURRENT_IDENTITY = '${esc(identity)}';
    var API = '${esc(apiOrigin)}';
    var RELAYS = ['wss://relay.divine.video', 'wss://relay.damus.io', 'wss://relay.nostr.band'];
    var PLATFORM_LABELS = ${JSON.stringify(PLATFORM_LABELS)};

    function esc(s) {
      var d = document.createElement('div');
      d.textContent = s || '';
      return d.innerHTML;
    }

    function proofUrl(platform, identity, proof) {
      switch (platform) {
        case 'github': return 'https://gist.github.com/' + identity + '/' + proof;
        case 'twitter': return 'https://x.com/' + identity + '/status/' + proof;
        case 'bluesky': return 'https://bsky.app/profile/' + identity + '/post/' + proof;
        case 'mastodon': return 'https://' + identity.split('/')[0] + '/statuses/' + proof;
        case 'telegram': return 'https://t.me/' + proof;
        case 'discord': return 'https://discord.gg/' + proof;
        case 'youtube': return 'https://www.youtube.com/watch?v=' + proof;
        case 'tiktok': return 'https://www.tiktok.com/@' + identity + '/video/' + proof;
        default: return null;
      }
    }

    function platformIconHtml(platform) {
      var icons = {
        github: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>',
        twitter: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
        bluesky: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C7.8 5.4 5 9 5 11.5c0 2.5 1.2 3.6 2.5 3.8-1 .3-3.5 1-2.5 3.2.7 1.5 3.5 1.5 5 .5 1-.7 1.7-1.7 2-2.7.3 1 1 2 2 2.7 1.5 1 4.3 1 5-.5 1-2.2-1.5-2.9-2.5-3.2 1.3-.2 2.5-1.3 2.5-3.8 0-2.5-2.8-6.1-7-9.5z"/></svg>',
        mastodon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 00.023-.043v-1.809a.052.052 0 00-.02-.041.053.053 0 00-.046-.01 20.282 20.282 0 01-4.709.547c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 01-.319-1.433.053.053 0 01.066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.668 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z"/></svg>',
        telegram: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>',
        discord: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1569 2.4189z"/></svg>',
        youtube: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
        tiktok: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>',
        nip05: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
      };
      return icons[platform] || '';
    }

    // Fetch profile from Nostr relays
    function fetchProfile(relayUrl, pubkey) {
      return new Promise(function(resolve, reject) {
        var timeout = setTimeout(function() { ws.close(); reject(new Error('timeout')); }, 8000);
        var ws;
        try { ws = new WebSocket(relayUrl); } catch(e) { reject(e); return; }
        var subId = 'vp_' + Math.random().toString(36).slice(2, 8);
        ws.onopen = function() {
          ws.send(JSON.stringify(['REQ', subId, { kinds: [0], authors: [pubkey], limit: 1 }]));
        };
        ws.onmessage = function(msg) {
          try {
            var data = JSON.parse(msg.data);
            if (data[0] === 'EVENT' && data[1] === subId) {
              clearTimeout(timeout);
              ws.send(JSON.stringify(['CLOSE', subId]));
              ws.close();
              resolve(data[2]);
            } else if (data[0] === 'EOSE' && data[1] === subId) {
              clearTimeout(timeout);
              ws.close();
              resolve(null);
            }
          } catch(e) {}
        };
        ws.onerror = function() { clearTimeout(timeout); reject(new Error('ws error')); };
      });
    }

    function tryParseJSON(s) {
      try { return JSON.parse(s); } catch(e) { return null; }
    }

    // Render profile header
    function renderProfile(profile) {
      var el = document.getElementById('profile-header');
      if (!profile) { el.style.display = 'none'; return; }
      var content = tryParseJSON(profile.content);
      if (!content) { el.style.display = 'none'; return; }

      var name = content.display_name || content.displayName || content.name || NPUB.slice(0, 12) + '...';
      var avatar = content.picture || content.image || '';
      var nip05 = content.nip05 || '';
      var divineNip05 = '';

      // Check if they have a divine.video NIP-05
      if (nip05 && nip05.endsWith('@divine.video')) {
        var local = nip05.split('@')[0];
        if (local && local !== '_') {
          divineNip05 = 'https://' + local + '.divine.video';
        }
      }

      var profileLink = divineNip05 || 'https://divine.video/profile/' + NPUB;

      var html = '';
      if (avatar) {
        html += '<img class="avatar" src="' + esc(avatar) + '" alt="">';
        // Set OG image dynamically
        var ogImg = document.querySelector('meta[property="og:image"]');
        if (!ogImg) {
          ogImg = document.createElement('meta');
          ogImg.setAttribute('property', 'og:image');
          document.head.appendChild(ogImg);
        }
        ogImg.setAttribute('content', avatar);
        var twImg = document.querySelector('meta[name="twitter:image"]');
        if (!twImg) {
          twImg = document.createElement('meta');
          twImg.setAttribute('name', 'twitter:image');
          document.head.appendChild(twImg);
        }
        twImg.setAttribute('content', avatar);
      } else {
        html += '<div class="avatar-placeholder">&#9787;</div>';
      }

      html += '<div class="profile-info">';
      html += '<div class="display-name">' + esc(name) + '</div>';
      if (nip05) {
        html += '<div class="nip05">' + esc(nip05) + '</div>';
      }
      html += '<div class="npub-display">' + esc(NPUB) + '</div>';
      html += '<div class="profile-links">';
      html += '<a href="' + esc(profileLink) + '" target="_blank">View on Divine ↗</a>';
      html += '</div>';
      html += '</div>';

      el.innerHTML = html;
      el.style.display = 'flex';
      el.classList.remove('loading');
      var avatarImg = el.querySelector('.avatar');
      if (avatarImg) avatarImg.onerror = function() { this.style.display = 'none'; };
    }

    // Render other verified identities
    function renderOtherIdentities(results) {
      var el = document.getElementById('other-identities');
      if (!results || results.length === 0) { el.style.display = 'none'; return; }

      var html = '<div class="other-identities">';
      html += '<div class="section-title">All Verified Identities</div>';

      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var icon = platformIconHtml(r.platform);
        var label = PLATFORM_LABELS[r.platform] || r.platform;
        var link = r._proofUrl ? '<a href="' + esc(r._proofUrl) + '" target="_blank" rel="noopener">proof ↗</a>' : '';
        var status = r.verified ? '&#9989;' : '&#10060;';
        var isCurrent = (r.platform === CURRENT_PLATFORM && r.identity === CURRENT_IDENTITY);

        html += '<div class="identity-item"' + (isCurrent ? ' style="background:#f7fafc;border-radius:8px;padding:0.5rem 0.75rem;"' : '') + '>';
        html += '<div class="platform-icon">' + icon + '</div>';
        html += '<div class="claim-details" style="flex:1;min-width:0;">';
        html += '<div class="claim-platform">' + esc(label) + '</div>';
        html += '<div class="claim-identity">' + esc(r.identity) + '</div>';
        html += '<div class="claim-links">' + link + '</div>';
        html += '</div>';
        html += '<div class="claim-status">' + status + '</div>';
        html += '</div>';
      }

      html += '</div>';
      el.innerHTML = html;
      el.style.display = 'block';
    }

    // Main: fetch profile and other identities
    async function init() {
      var profile = null;
      for (var i = 0; i < RELAYS.length; i++) {
        try {
          profile = await fetchProfile(RELAYS[i], PUBKEY);
          if (profile) break;
        } catch(e) { /* try next */ }
      }

      renderProfile(profile);

      if (!profile) return;

      // Extract i-tags for other identity claims
      var iTags = (profile.tags || []).filter(function(t) {
        return t[0] === 'i' && t[1] && t[2];
      });

      if (iTags.length === 0) return;

      var supportedPlatforms = ['github','twitter','mastodon','telegram','bluesky','discord','youtube','tiktok'];
      var claims = [];
      for (var j = 0; j < iTags.length; j++) {
        var parts = iTags[j][1].split(':');
        var plat = parts[0];
        var ident = parts.slice(1).join(':');
        var proof = iTags[j][2];
        if (supportedPlatforms.indexOf(plat) !== -1) {
          claims.push({ platform: plat, identity: ident, proof: proof, pubkey: PUBKEY });
        }
      }

      if (claims.length === 0) return;

      // Show loading state
      var el = document.getElementById('other-identities');
      el.innerHTML = '<div class="other-identities"><div class="section-title">All Verified Identities</div><div class="identity-loading"><div class="spinner"></div> Verifying ' + claims.length + ' identity claim(s)...</div></div>';
      el.style.display = 'block';

      // Batch verify all claims
      try {
        var resp = await fetch(API + '/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claims: claims }),
        });
        var data = await resp.json();
        if (data.results) {
          // Attach proof URLs
          for (var k = 0; k < data.results.length; k++) {
            data.results[k]._proofUrl = proofUrl(claims[k].platform, claims[k].identity, claims[k].proof);
          }

          // Also check NIP-05 if present
          var content = tryParseJSON(profile.content);
          if (content && content.nip05) {
            try {
              var n5resp = await fetch(API + '/nip05/verify?name=' + encodeURIComponent(content.nip05) + '&pubkey=' + PUBKEY);
              var n5data = await n5resp.json();
              data.results.unshift({
                platform: 'nip05',
                identity: content.nip05,
                verified: n5data.verified,
                error: n5data.error,
                cached: n5data.cached,
                _proofUrl: null
              });
            } catch(e) { /* skip nip05 */ }
          }

          renderOtherIdentities(data.results);
        }
      } catch(e) {
        el.innerHTML = '';
        el.style.display = 'none';
      }
    }

    init();
  })();
  </script>
</body>
</html>`
}

export default verify
