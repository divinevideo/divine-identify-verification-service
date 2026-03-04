import { Hono } from 'hono'
import type { Bindings, CachedResult } from '../types'
import { validateNip05Name, isValidHexPubkey, normalizePubkey } from '../utils/validation'
import { nip05CacheKey, getCached, putCached } from '../utils/cache'
import { checkRateLimit, RATE_LIMITS } from '../utils/rate-limit'

const nip05 = new Hono<{ Bindings: Bindings }>()

nip05.get('/verify', async (c) => {
  const clientIp = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown'

  // IP rate limit
  const ipLimit = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.ip, clientIp)
  if (!ipLimit.allowed) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }

  const name = c.req.query('name')
  const pubkey = c.req.query('pubkey')

  if (!name) {
    return c.json({ error: 'Missing "name" query parameter (format: user@domain)' }, 400)
  }
  if (!pubkey || !isValidHexPubkey(pubkey)) {
    return c.json({ error: 'Missing or invalid "pubkey" query parameter (64-char hex)' }, 400)
  }

  const parsed = validateNip05Name(name)
  if (!parsed) {
    return c.json({ error: 'Invalid NIP-05 name format (expected user@domain)' }, 400)
  }

  const { local, domain } = parsed
  const normalizedPubkey = normalizePubkey(pubkey)
  const now = Math.floor(Date.now() / 1000)
  const key = nip05CacheKey(local, domain, normalizedPubkey)

  // Check cache
  const cached = await getCached(c.env.CACHE_KV, key)
  if (cached) {
    return c.json({
      name: local,
      domain,
      pubkey,
      verified: cached.verified,
      error: cached.error,
      checked_at: cached.checked_at,
      cached: true,
    })
  }

  // Fetch NIP-05 well-known
  try {
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(local)}`
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      redirect: 'manual', // NIP-05 spec: no redirects
    })

    if (!response.ok) {
      const error = `NIP-05 fetch failed: HTTP ${response.status}`
      await putCached(c.env.CACHE_KV, key, { verified: false, error, checked_at: now, type: 'platform_error' })
      return c.json({ name: local, domain, pubkey, verified: false, error, checked_at: now, cached: false })
    }

    const data = await response.json() as { names?: Record<string, string> }

    if (!data.names || typeof data.names !== 'object') {
      const error = 'Invalid NIP-05 response: missing names object'
      await putCached(c.env.CACHE_KV, key, { verified: false, error, checked_at: now, type: 'failed' })
      return c.json({ name: local, domain, pubkey, verified: false, error, checked_at: now, cached: false })
    }

    const registeredPubkey = data.names[local]
    const verified = registeredPubkey?.toLowerCase() === pubkey.toLowerCase()

    const result: CachedResult = {
      verified,
      error: verified ? undefined : 'Pubkey does not match NIP-05 registration',
      checked_at: now,
      type: verified ? 'verified' : 'failed',
    }
    await putCached(c.env.CACHE_KV, key, result)

    return c.json({
      name: local,
      domain,
      pubkey,
      verified: result.verified,
      error: result.error,
      checked_at: now,
      cached: false,
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : 'NIP-05 verification failed'
    await putCached(c.env.CACHE_KV, key, { verified: false, error, checked_at: now, type: 'platform_error' })
    return c.json({ name: local, domain, pubkey, verified: false, error, checked_at: now, cached: false })
  }
})

export default nip05
