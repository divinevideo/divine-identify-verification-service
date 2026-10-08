import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Context } from 'hono'
import type { Bindings, OAuthPlatform } from '../types'
import { isValidHexPubkey, isValidIdentity, normalizePubkey } from '../utils/validation'
import { checkRateLimit, RATE_LIMITS } from '../utils/rate-limit'
import { verifyEventSignature, type SignedNostrEvent } from '../utils/nostr-event'
import { getOAuthVerification, deleteOAuthVerification, getOAuthState, deleteOAuthState } from '../oauth/state'
import { signInAccountStillMatches } from '../oauth/signin-account'
import { startTwitterOAuth, handleTwitterCallback } from '../oauth/twitter'
import { startBlueskyOAuth, handleBlueskyCallback, blueskyClientMetadata } from '../oauth/bluesky'
import { startYouTubeOAuth, handleYouTubeCallback } from '../oauth/youtube'
import { startTikTokOAuth, handleTikTokCallback, isTikTokOAuthUsable } from '../oauth/tiktok'

const auth = new Hono<{ Bindings: Bindings }>()
// NIP-98 suggests 60s; login.divine.video enforced 60s when it did this check.
const NIP98_MAX_AGE_SECONDS = 60

type Nip98Event = SignedNostrEvent

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
  if (event.kind !== 27235) {
    return { error: 'Invalid event kind: expected 27235 (NIP-98)', status: 400 }
  }
  if (!Array.isArray(event.tags) || event.tags.some((tag) => !Array.isArray(tag))) {
    return { error: 'Invalid event tags', status: 400 }
  }
  if (typeof event.created_at !== 'number' || !Number.isInteger(event.created_at)) {
    return { error: 'Invalid event created_at', status: 400 }
  }
  if (typeof event.content !== 'string') {
    return { error: 'Invalid event content', status: 400 }
  }

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - event.created_at) > NIP98_MAX_AGE_SECONDS) {
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
      created_at: event.created_at,
      content: event.content,
    },
  }
}

// Verifies a NIP-98 event in full, here. NIP-98 binds an event to the exact URL
// it is sent to, so it cannot be checked by forwarding it to another service:
// that service sees its own URL, not this one.
async function verifyNip98Event(
  rawEvent: unknown,
  expectedUrl: string,
  expectedMethod: string,
): Promise<{ ok: true; event: Nip98Event } | { ok: false; error: string; status: 400 | 401 }> {
  const parsed = parseAndValidateNip98Event(rawEvent, expectedUrl, expectedMethod)
  if ('error' in parsed) {
    return { ok: false, error: parsed.error, status: parsed.status }
  }

  const signature = await verifyEventSignature(parsed.event)
  if (!signature.ok) {
    return {
      ok: false,
      error: signature.reason === 'id'
        ? 'NIP-98 event id does not match its contents'
        : signature.reason === 'format'
          ? 'Invalid event: id, pubkey and sig must be lowercase hex'
          : 'NIP-98 event signature is invalid',
      status: signature.reason === 'format' ? 400 : 401,
    }
  }

  return { ok: true, event: parsed.event }
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

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

// requestUrl is the address this request reached the verifier on. The live
// verifier is only ever reached on its public hostnames, so a request that
// arrived on localhost means the verifier is running locally.
export function isAllowedReturnUrl(url: string, oauthRedirectBase?: string, requestUrl?: string): boolean {
  try {
    const parsed = new URL(url)
    // Only web addresses: some other schemes (blob:) report a trusted origin.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const base = oauthRedirectBase ? new URL(oauthRedirectBase) : null
    // Compare exact origin (scheme + host + port) to prevent subdomain tricks
    if (base && parsed.origin === base.origin) return true
    if (ALLOWED_RETURN_ORIGINS.has(parsed.origin)) return true
    // Local development only: when the verifier itself runs on localhost,
    // also accept other local dev servers. Production never sends people to
    // localhost.
    const runningLocally = (base !== null && isLocalHostname(base.hostname))
      || (requestUrl !== undefined && isLocalHostname(new URL(requestUrl).hostname))
    return runningLocally && isLocalHostname(parsed.hostname)
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

// Nostr login: proves the caller holds the key for `pubkey`.
// POST /auth/nostr/login { event: NIP-98 event whose u tag is this endpoint's URL }
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

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const loginUrl = new URL(c.req.url).toString()
  const verification = await verifyNip98Event(body.event, loginUrl, 'POST')
  if (!verification.ok) {
    return c.json({ error: verification.error }, verification.status)
  }

  return c.json({
    authenticated: true,
    pubkey: verification.event.pubkey,
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
  if (returnUrl !== '/' && !isAllowedReturnUrl(returnUrl, c.env.OAUTH_REDIRECT_BASE, c.req.url)) {
    return c.json({ error: 'Invalid return_url: must be a trusted origin' }, 400)
  }

  const normalizedPubkey = normalizePubkey(pubkey)

  switch (platform) {
    case 'twitter':
      return startTwitterOAuth(c.env, normalizedPubkey, returnUrl)

    case 'bluesky': {
      // People type handles the way Bluesky shows them, with a leading @.
      const bareHandle = handle?.trim().replace(/^@/, '').trim()
      if (!bareHandle) {
        return c.json({ error: 'Missing handle parameter (e.g., user.bsky.social)' }, 400)
      }
      return startBlueskyOAuth(c.env, normalizedPubkey, bareHandle, returnUrl)
    }

    case 'youtube':
      return startYouTubeOAuth(c.env, normalizedPubkey, returnUrl)

    case 'tiktok': {
      const allowSandbox = getCookie(c, 'tiktok_oauth_review') === '1'
      if (!isTikTokOAuthUsable(c.env, allowSandbox)) {
        return c.json({ error: 'TikTok OAuth not configured' }, 503)
      }
      return startTikTokOAuth(c.env, normalizedPubkey, returnUrl)
    }

    default:
      return c.json({ error: 'OAuth not supported for this platform. Supported: twitter, bluesky, youtube, tiktok' }, 400)
  }
})

const SIGN_IN_LABELS: Record<OAuthPlatform, string> = {
  twitter: 'Twitter',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  bluesky: 'Bluesky',
}

// A sign-in the provider did not complete comes back with `error` and, per
// RFC 6749 4.1.2.1, the `state` we sent. Send the person back to where the
// sign-in started, like the success path does, instead of leaving them on a
// raw error. The provider's own error text is not passed on. A state that is
// missing, expired or belongs to another platform falls back to the verifier
// page and is left untouched.
async function redirectAfterUnfinishedSignIn(
  c: Context<{ Bindings: Bindings }>,
  platform: OAuthPlatform,
  providerError: string,
  stateId: string | undefined,
): Promise<Response> {
  // Log only the provider's error code, and only when it looks like one, so
  // a misconfigured app can be told apart from a person saying no. The
  // description and the state id are never logged.
  console.warn(`${platform} sign-in returned an error:`, /^[a-z_]{1,64}$/.test(providerError) ? providerError : 'other')

  // The page shows this after "Sign-in was not completed: ". `access_denied`
  // means the request was refused, usually by the person; any other code means
  // the sign-in failed for another reason, possibly our own configuration, so
  // it isn't described as a cancel.
  const label = SIGN_IN_LABELS[platform]
  const reason = {
    oauth_error: providerError === 'access_denied' ? `cancelled or declined at ${label}` : `could not be completed at ${label}`,
  }
  const fallback = () => c.redirect(buildReturnUrl('/', reason))
  if (!stateId) return fallback()

  let returnUrl: string
  try {
    const state = await getOAuthState(c.env.CACHE_KV, stateId)
    if (!state || state.platform !== platform) return fallback()
    returnUrl = state.returnUrl
  } catch (err) {
    // Like the success path: a storage failure must not strand the person.
    console.error(`${platform} unfinished sign-in state lookup failed:`, err instanceof Error ? err.message : err)
    return fallback()
  }
  try {
    await deleteOAuthState(c.env.CACHE_KV, stateId)
  } catch (err) {
    // The return address is already known and was checked when the sign-in
    // started; the leftover state expires on its own (src/oauth/state.ts).
    console.error(`${platform} unfinished sign-in state cleanup failed:`, err instanceof Error ? err.message : err)
  }
  return c.redirect(buildReturnUrl(returnUrl, reason))
}

// OAuth callbacks
auth.get('/twitter/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  if (error) {
    return redirectAfterUnfinishedSignIn(c, 'twitter', error, state)
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
    return redirectAfterUnfinishedSignIn(c, 'youtube', error, state)
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
    return redirectAfterUnfinishedSignIn(c, 'tiktok', error, state)
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
    return redirectAfterUnfinishedSignIn(c, 'bluesky', error, state)
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

  if (verification && await signInAccountStillMatches(c.env, verification, identity)) {
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

// Revoke an OAuth sign-in record (a Bluesky one under both its handle and DID)
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

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const { platform, identity, pubkey, event } = body
  if (!platform || !identity || !pubkey || !event) {
    return c.json({ error: 'Missing required fields: platform, identity, pubkey, event' }, 400)
  }
  // Checked before any signature work: deleting the record lowercases identity.
  if (!isValidIdentity(identity)) {
    return c.json({ error: 'Invalid identity' }, 400)
  }
  if (!OAUTH_PLATFORMS.has(platform)) {
    return c.json({ error: `OAuth revoke only supported for: ${[...OAUTH_PLATFORMS].join(', ')}` }, 400)
  }
  if (!isValidHexPubkey(pubkey)) {
    return c.json({ error: 'Invalid pubkey (64-char hex required)' }, 400)
  }
  const normalizedBodyPubkey = normalizePubkey(pubkey)
  const revokeUrl = new URL(c.req.url).toString()
  const verification = await verifyNip98Event(event, revokeUrl, 'POST')
  if (!verification.ok) {
    return c.json({ error: verification.error }, verification.status)
  }

  const signerPubkey = verification.event.pubkey
  if (normalizedBodyPubkey !== signerPubkey) {
    return c.json({ error: 'Pubkey mismatch: body pubkey does not match event pubkey' }, 401)
  }

  // Delete only the signer's own OAuth verification.
  await deleteOAuthVerification(c.env.CACHE_KV, platform, identity, signerPubkey)

  return c.json({ revoked: true, platform, identity })
})

export default auth
