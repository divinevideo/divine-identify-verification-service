const WINDOW_SECONDS = 60

interface RateLimitConfig {
  limit: number
  prefix: string
}

export const RATE_LIMITS = {
  ip: { limit: 60, prefix: 'rl:ip' } as RateLimitConfig,
  pubkey: { limit: 20, prefix: 'rl:pk' } as RateLimitConfig,
  platform: { limit: 30, prefix: 'rl:plat' } as RateLimitConfig,
}

function windowKey(prefix: string, id: string): string {
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS)
  return `${prefix}:${id}:${window}`
}

function parseCount(raw: string | null): number {
  if (!raw) return 0
  const n = parseInt(raw, 10)
  return Number.isNaN(n) ? 0 : n
}

/** Check rate limit and increment counter in one step. Returns whether the request is allowed. */
export async function checkRateLimit(
  kv: KVNamespace,
  config: RateLimitConfig,
  id: string
): Promise<{ allowed: boolean; remaining: number }> {
  const key = windowKey(config.prefix, id)
  const raw = await kv.get(key)
  const current = parseCount(raw)

  if (current >= config.limit) {
    return { allowed: false, remaining: 0 }
  }

  await kv.put(key, String(current + 1), { expirationTtl: WINDOW_SECONDS * 2 })
  return { allowed: true, remaining: config.limit - current - 1 }
}
