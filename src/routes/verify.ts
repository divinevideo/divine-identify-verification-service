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

  // Check for OAuth verification (backup method for twitter/bluesky)
  if (normalizedClaim.platform === 'twitter' || normalizedClaim.platform === 'bluesky') {
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
  const verifier = getVerifier(normalizedClaim.platform, env.GITHUB_TOKEN)
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
  return c.json(result)
})

export default verify
