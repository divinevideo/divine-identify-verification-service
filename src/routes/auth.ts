import { Hono } from 'hono'
import type { Bindings, OAuthPlatform } from '../types'
import { isValidHexPubkey, normalizePubkey } from '../utils/validation'
import { checkRateLimit, RATE_LIMITS } from '../utils/rate-limit'
import { getOAuthVerification, deleteOAuthVerification } from '../oauth/state'
import { startTwitterOAuth, handleTwitterCallback } from '../oauth/twitter'
import { startBlueskyOAuth, handleBlueskyCallback, blueskyClientMetadata } from '../oauth/bluesky'
import { startYouTubeOAuth, handleYouTubeCallback } from '../oauth/youtube'
import { startTikTokOAuth, handleTikTokCallback } from '../oauth/tiktok'

const auth = new Hono<{ Bindings: Bindings }>()
const DIVINE_LOGIN_BASE = 'https://login.divine.video'

// Allowed origins for OAuth return_url (prevent open redirect)
const ALLOWED_RETURN_ORIGINS = new Set([
  'https://divine.video',
  'https://www.divine.video',
  'https://verifyer.divine.video',
  'https://verifier.divine.video',
])

function isAllowedReturnUrl(url: string, oauthRedirectBase?: string): boolean {
  try {
    const parsed = new URL(url)
    // Compare exact origin (scheme + host + port) to prevent subdomain tricks
    if (oauthRedirectBase) {
      const base = new URL(oauthRedirectBase)
      if (parsed.origin === base.origin) return true
    }
    if (ALLOWED_RETURN_ORIGINS.has(parsed.origin)) return true
    // Allow localhost dev origins
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true
    return false
  } catch {
    return false
  }
}

function buildReturnUrl(returnUrl: string, params: Record<string, string>): string {
  try {
    const url = new URL(returnUrl)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    return url.toString()
  } catch {
    // Fallback: return relative path
    const qs = new URLSearchParams(params).toString()
    return `/?${qs}`
  }
}

// Bluesky client metadata (AT Protocol OAuth requires this to be publicly hosted)
auth.get('/bluesky/client-metadata.json', (c) => {
  const baseUrl = c.env.OAUTH_REDIRECT_BASE || new URL(c.req.url).origin
  return c.json(blueskyClientMetadata(baseUrl))
})

// Nostr login via login.divine.video (NIP-98 signed event passthrough)
// POST /auth/nostr/login { event: { ...nostr event... } }
auth.post('/nostr/login', async (c) => {
  const clientIp = c.req.header('cf-connecting-ip') || 'unknown'
  const ipLimit = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.ip, clientIp)
  if (!ipLimit.allowed) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }

  let body: { event?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const event = body.event as
    | { id?: unknown; pubkey?: unknown; sig?: unknown; kind?: unknown; tags?: unknown; created_at?: unknown; content?: unknown }
    | undefined
  if (!event || typeof event !== 'object') {
    return c.json({ error: 'Missing event payload' }, 400)
  }
  if (typeof event.id !== 'string' || typeof event.pubkey !== 'string' || typeof event.sig !== 'string') {
    return c.json({ error: 'Invalid event: id/pubkey/sig are required' }, 400)
  }
  if (!isValidHexPubkey(event.pubkey)) {
    return c.json({ error: 'Invalid event pubkey' }, 400)
  }
  if (event.kind !== 27235) {
    return c.json({ error: 'Invalid event kind: expected 27235 (NIP-98)' }, 400)
  }
  if (!Array.isArray(event.tags)) {
    return c.json({ error: 'Invalid event tags' }, 400)
  }

  const loginUrl = `${DIVINE_LOGIN_BASE}/api/auth/login`
  const encodedEvent = btoa(JSON.stringify(event))

  let upstreamResp: Response
  try {
    upstreamResp = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Nostr ${encodedEvent}`,
        'Content-Type': 'application/json',
        // login.divine.video currently whitelists divine.video origin for this endpoint.
        'Origin': 'https://divine.video',
      },
      body: '{}',
    })
  } catch {
    return c.json({ error: 'Failed to reach login.divine.video' }, 502)
  }

  let upstreamData: { pubkey?: string; error?: string } = {}
  try {
    upstreamData = await upstreamResp.json() as typeof upstreamData
  } catch {
    // Keep empty object fallback.
  }

  if (!upstreamResp.ok) {
    return c.json({
      error: upstreamData.error || 'Nostr login failed at login.divine.video',
      upstream_status: upstreamResp.status,
    }, 502)
  }

  const upstreamPubkey = typeof upstreamData.pubkey === 'string' ? upstreamData.pubkey : event.pubkey
  if (!isValidHexPubkey(upstreamPubkey)) {
    return c.json({ error: 'Invalid pubkey returned by login provider' }, 502)
  }

  return c.json({
    authenticated: true,
    pubkey: normalizePubkey(upstreamPubkey),
    provider: 'login.divine.video',
    method: 'nostr_nip98',
  })
})

// Start OAuth flow
// GET /auth/:platform/start?pubkey=hex&return_url=https://...&handle=user.bsky.social (handle required for bluesky)
auth.get('/:platform/start', async (c) => {
  const clientIp = c.req.header('cf-connecting-ip') || 'unknown'
  const ipLimit = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.ip, clientIp)
  if (!ipLimit.allowed) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }

  const platform = c.req.param('platform')
  const pubkey = c.req.query('pubkey')
  const returnUrl = c.req.query('return_url') || '/'
  const handle = c.req.query('handle')

  if (!pubkey || !isValidHexPubkey(pubkey)) {
    return c.json({ error: 'Invalid or missing pubkey (64-char hex)' }, 400)
  }

  // Validate return_url to prevent open redirect
  if (returnUrl !== '/' && !isAllowedReturnUrl(returnUrl, c.env.OAUTH_REDIRECT_BASE)) {
    return c.json({ error: 'Invalid return_url: must be a trusted origin' }, 400)
  }

  const normalizedPubkey = normalizePubkey(pubkey)

  switch (platform) {
    case 'twitter':
      return startTwitterOAuth(c.env, normalizedPubkey, returnUrl)

    case 'bluesky':
      if (!handle) {
        return c.json({ error: 'Missing handle parameter (e.g., user.bsky.social)' }, 400)
      }
      return startBlueskyOAuth(c.env, normalizedPubkey, handle, returnUrl)

    case 'youtube':
      return startYouTubeOAuth(c.env, normalizedPubkey, returnUrl)

    case 'tiktok':
      return startTikTokOAuth(c.env, normalizedPubkey, returnUrl)

    default:
      return c.json({ error: 'OAuth not supported for this platform. Supported: twitter, bluesky, youtube, tiktok' }, 400)
  }
})

// OAuth callbacks
auth.get('/twitter/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  if (error) {
    return c.json({ error: 'Twitter OAuth was denied or cancelled' }, 400)
  }
  if (!code || !state) {
    return c.json({ error: 'Missing code or state parameter' }, 400)
  }

  try {
    const result = await handleTwitterCallback(c.env, code, state)
    const redirectUrl = buildReturnUrl(result.returnUrl, result.success
      ? { oauth_verified: 'true', platform: 'twitter', identity: result.identity || '' }
      : { oauth_error: 'Verification failed' }
    )
    return c.redirect(redirectUrl)
  } catch (err) {
    console.error('Twitter callback error:', err instanceof Error ? err.message : err)
    return c.redirect(buildReturnUrl('/', { oauth_error: 'Verification failed' }))
  }
})

auth.get('/youtube/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  if (error) {
    return c.json({ error: 'YouTube OAuth was denied or cancelled' }, 400)
  }
  if (!code || !state) {
    return c.json({ error: 'Missing code or state parameter' }, 400)
  }

  try {
    const result = await handleYouTubeCallback(c.env, code, state)
    const redirectUrl = buildReturnUrl(result.returnUrl, result.success
      ? { oauth_verified: 'true', platform: 'youtube', identity: result.identity || '' }
      : { oauth_error: 'Verification failed' }
    )
    return c.redirect(redirectUrl)
  } catch (err) {
    console.error('YouTube callback error:', err instanceof Error ? err.message : err)
    return c.redirect(buildReturnUrl('/', { oauth_error: 'Verification failed' }))
  }
})

auth.get('/tiktok/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  if (error) {
    return c.json({ error: 'TikTok OAuth was denied or cancelled' }, 400)
  }
  if (!code || !state) {
    return c.json({ error: 'Missing code or state parameter' }, 400)
  }

  try {
    const result = await handleTikTokCallback(c.env, code, state)
    const redirectUrl = buildReturnUrl(result.returnUrl, result.success
      ? { oauth_verified: 'true', platform: 'tiktok', identity: result.identity || '' }
      : { oauth_error: 'Verification failed' }
    )
    return c.redirect(redirectUrl)
  } catch (err) {
    console.error('TikTok callback error:', err instanceof Error ? err.message : err)
    return c.redirect(buildReturnUrl('/', { oauth_error: 'Verification failed' }))
  }
})

auth.get('/bluesky/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const iss = c.req.query('iss')
  const error = c.req.query('error')

  if (error) {
    return c.json({ error: 'Bluesky OAuth was denied or cancelled' }, 400)
  }
  if (!code || !state || !iss) {
    return c.json({ error: 'Missing code, state, or iss parameter' }, 400)
  }

  try {
    const result = await handleBlueskyCallback(c.env, code, state, iss)
    const redirectUrl = buildReturnUrl(result.returnUrl, result.success
      ? { oauth_verified: 'true', platform: 'bluesky', identity: result.identity || '' }
      : { oauth_error: 'Verification failed' }
    )
    return c.redirect(redirectUrl)
  } catch (err) {
    console.error('Bluesky callback error:', err instanceof Error ? err.message : err)
    return c.redirect(buildReturnUrl('/', { oauth_error: 'Verification failed' }))
  }
})

// Check OAuth verification status
// GET /auth/:platform/status?pubkey=hex&identity=handle
auth.get('/:platform/status', async (c) => {
  const platform = c.req.param('platform')
  const pubkey = c.req.query('pubkey')
  const identity = c.req.query('identity')

  if (!pubkey || !isValidHexPubkey(pubkey)) {
    return c.json({ error: 'Invalid or missing pubkey' }, 400)
  }
  if (!identity) {
    return c.json({ error: 'Missing identity parameter' }, 400)
  }
  if (platform !== 'twitter' && platform !== 'bluesky' && platform !== 'youtube' && platform !== 'tiktok') {
    return c.json({ error: 'OAuth status only available for twitter, bluesky, youtube, and tiktok' }, 400)
  }

  const normalizedPubkey = normalizePubkey(pubkey)
  const verification = await getOAuthVerification(c.env.CACHE_KV, platform, identity, normalizedPubkey)

  if (verification) {
    return c.json({
      platform,
      identity: verification.identity,
      pubkey: normalizedPubkey,
      verified: true,
      method: 'oauth',
      checked_at: verification.checked_at,
    })
  }

  return c.json({
    platform,
    identity,
    pubkey: normalizedPubkey,
    verified: false,
    method: null,
  })
})

const OAUTH_PLATFORMS = new Set(['twitter', 'bluesky', 'youtube', 'tiktok'])

// Revoke OAuth verification cache entry
// POST /auth/oauth/revoke { platform, identity, pubkey, event }
auth.post('/oauth/revoke', async (c) => {
  const clientIp = c.req.header('cf-connecting-ip') || 'unknown'
  const ipLimit = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.ip, clientIp)
  if (!ipLimit.allowed) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }

  let body: { platform?: string; identity?: string; pubkey?: string; event?: Record<string, unknown> }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const { platform, identity, pubkey, event } = body
  if (!platform || !identity || !pubkey || !event) {
    return c.json({ error: 'Missing required fields: platform, identity, pubkey, event' }, 400)
  }
  if (!OAUTH_PLATFORMS.has(platform)) {
    return c.json({ error: `OAuth revoke only supported for: ${[...OAUTH_PLATFORMS].join(', ')}` }, 400)
  }
  if (!isValidHexPubkey(pubkey)) {
    return c.json({ error: 'Invalid pubkey (64-char hex required)' }, 400)
  }
  if (typeof event.pubkey !== 'string' || event.kind !== 27235) {
    return c.json({ error: 'Invalid NIP-98 event' }, 400)
  }

  const normalizedBodyPubkey = normalizePubkey(pubkey)
  const eventPubkey = typeof event.pubkey === 'string' ? normalizePubkey(event.pubkey) : ''
  if (normalizedBodyPubkey !== eventPubkey) {
    return c.json({ error: 'Pubkey mismatch: body pubkey does not match event pubkey' }, 401)
  }

  // Verify NIP-98 event via login.divine.video
  const encodedEvent = btoa(JSON.stringify(event))
  let upstreamResp: Response
  try {
    upstreamResp = await fetch(`${DIVINE_LOGIN_BASE}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Authorization': `Nostr ${encodedEvent}`,
        'Content-Type': 'application/json',
        'Origin': 'https://divine.video',
      },
      body: '{}',
    })
  } catch {
    return c.json({ error: 'Failed to reach login.divine.video' }, 502)
  }

  if (!upstreamResp.ok) {
    return c.json({ error: 'NIP-98 verification failed' }, 401)
  }

  // Delete OAuth verification from KV
  await deleteOAuthVerification(c.env.CACHE_KV, platform, identity, normalizedBodyPubkey)

  return c.json({ revoked: true, platform, identity })
})

export default auth
