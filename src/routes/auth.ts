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
const NIP98_MAX_AGE_SECONDS = 120

type Nip98Event = {
  id: string
  pubkey: string
  sig: string
  kind: number
  tags: string[][]
  created_at: number
  content?: unknown
}

function getFirstTagValue(tags: string[][], tagName: string): string | null {
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === tagName && typeof tag[1] === 'string') {
      return tag[1]
    }
  }
  return null
}

function parseAndValidateNip98Event(
  rawEvent: unknown,
  expectedUrl: string,
  expectedMethod: string,
): { event: Nip98Event } | { error: string; status: 400 | 401 } {
  const event = rawEvent as
    | { id?: unknown; pubkey?: unknown; sig?: unknown; kind?: unknown; tags?: unknown; created_at?: unknown; content?: unknown }
    | undefined

  if (!event || typeof event !== 'object') {
    return { error: 'Missing event payload', status: 400 }
  }
  if (typeof event.id !== 'string' || typeof event.pubkey !== 'string' || typeof event.sig !== 'string') {
    return { error: 'Invalid event: id/pubkey/sig are required', status: 400 }
  }
  if (!isValidHexPubkey(event.pubkey)) {
    return { error: 'Invalid event pubkey', status: 400 }
  }
  if (event.kind !== 27235) {
    return { error: 'Invalid event kind: expected 27235 (NIP-98)', status: 400 }
  }
  if (!Array.isArray(event.tags) || event.tags.some((tag) => !Array.isArray(tag))) {
    return { error: 'Invalid event tags', status: 400 }
  }
  if (typeof event.created_at !== 'number' || !Number.isFinite(event.created_at)) {
    return { error: 'Invalid event created_at', status: 400 }
  }

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - Math.floor(event.created_at)) > NIP98_MAX_AGE_SECONDS) {
    return { error: 'NIP-98 event is too old or too far in the future', status: 401 }
  }

  const urlTag = getFirstTagValue(event.tags as string[][], 'u')
  if (urlTag !== expectedUrl) {
    return { error: 'NIP-98 event URL does not match this action', status: 401 }
  }

  const methodTag = getFirstTagValue(event.tags as string[][], 'method')
  if (methodTag !== expectedMethod) {
    return { error: 'NIP-98 event method does not match this action', status: 401 }
  }

  return {
    event: {
      id: event.id,
      pubkey: event.pubkey,
      sig: event.sig,
      kind: event.kind,
      tags: event.tags as string[][],
      created_at: Math.floor(event.created_at),
      content: event.content,
    },
  }
}

async function verifyNip98EventWithUpstream(
  rawEvent: unknown,
  expectedUrl: string,
  expectedMethod: string,
): Promise<
  | { ok: true; event: Nip98Event; upstreamPubkey: string }
  | { ok: false; error: string; status: number; upstreamStatus?: number }
> {
  const parsed = parseAndValidateNip98Event(rawEvent, expectedUrl, expectedMethod)
  if ('error' in parsed) {
    return { ok: false, error: parsed.error, status: parsed.status }
  }

  const loginUrl = `${DIVINE_LOGIN_BASE}/api/auth/login`
  const encodedEvent = btoa(JSON.stringify(parsed.event))

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
    return { ok: false, error: 'Failed to reach login.divine.video', status: 502 }
  }

  let upstreamData: { pubkey?: string; error?: string } = {}
  try {
    upstreamData = await upstreamResp.json() as typeof upstreamData
  } catch {
    // Keep empty object fallback.
  }

  if (!upstreamResp.ok) {
    return {
      ok: false,
      error: upstreamData.error || 'Nostr login failed at login.divine.video',
      status: 502,
      upstreamStatus: upstreamResp.status,
    }
  }

  const upstreamPubkey = typeof upstreamData.pubkey === 'string' ? upstreamData.pubkey : parsed.event.pubkey
  if (!isValidHexPubkey(upstreamPubkey)) {
    return { ok: false, error: 'Invalid pubkey returned by login provider', status: 502 }
  }

  return { ok: true, event: parsed.event, upstreamPubkey: normalizePubkey(upstreamPubkey) }
}

// Allowed origins for OAuth return_url (prevent open redirect)
const ALLOWED_RETURN_ORIGINS = new Set([
  'https://divine.video',
  'https://www.divine.video',
  // Live verify frontend. Its return_url points back to itself, so the
  // service's own origin must be trusted or every OAuth start 400s.
  'https://verify.divine.video',
  'https://verifyer.divine.video',
  'https://verifier.divine.video',
])

export function isAllowedReturnUrl(url: string, oauthRedirectBase?: string): boolean {
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

  const loginUrl = `${DIVINE_LOGIN_BASE}/api/auth/login`
  const verification = await verifyNip98EventWithUpstream(body.event, loginUrl, 'POST')
  if (!verification.ok) {
    const payload = verification.upstreamStatus
      ? { error: verification.error, upstream_status: verification.upstreamStatus }
      : { error: verification.error }
    return c.json(payload, verification.status as 400 | 401 | 502)
  }

  return c.json({
    authenticated: true,
    pubkey: verification.upstreamPubkey,
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
  const normalizedBodyPubkey = normalizePubkey(pubkey)
  if (typeof event?.pubkey === 'string' && normalizePubkey(event.pubkey) !== normalizedBodyPubkey) {
    return c.json({ error: 'Pubkey mismatch: body pubkey does not match event pubkey' }, 401)
  }
  const revokeUrl = new URL(c.req.url).toString()
  const verification = await verifyNip98EventWithUpstream(event, revokeUrl, 'POST')
  if (!verification.ok) {
    const payload = verification.upstreamStatus
      ? { error: verification.error, upstream_status: verification.upstreamStatus }
      : { error: verification.error }
    return c.json(payload, verification.status as 400 | 401 | 502)
  }

  if (normalizedBodyPubkey !== normalizePubkey(verification.event.pubkey)) {
    return c.json({ error: 'Pubkey mismatch: body pubkey does not match event pubkey' }, 401)
  }
  if (normalizedBodyPubkey !== verification.upstreamPubkey) {
    return c.json({ error: 'Pubkey mismatch: verified pubkey does not match request pubkey' }, 401)
  }

  // Delete OAuth verification from KV
  await deleteOAuthVerification(c.env.CACHE_KV, platform, identity, normalizedBodyPubkey)

  return c.json({ revoked: true, platform, identity })
})

export default auth
