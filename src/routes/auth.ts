import { Hono } from 'hono'
import type { Bindings, OAuthPlatform } from '../types'
import { isValidHexPubkey, normalizePubkey } from '../utils/validation'
import { checkRateLimit, RATE_LIMITS } from '../utils/rate-limit'
import { getOAuthVerification } from '../oauth/state'
import { startTwitterOAuth, handleTwitterCallback } from '../oauth/twitter'
import { startBlueskyOAuth, handleBlueskyCallback, blueskyClientMetadata } from '../oauth/bluesky'
import { startYouTubeOAuth, handleYouTubeCallback } from '../oauth/youtube'
import { startTikTokOAuth, handleTikTokCallback } from '../oauth/tiktok'

const auth = new Hono<{ Bindings: Bindings }>()

// Allowed origins for OAuth return_url (prevent open redirect)
const ALLOWED_RETURN_ORIGINS = new Set([
  'https://divine.video',
  'https://www.divine.video',
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

export default auth
