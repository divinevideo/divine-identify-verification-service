const WINDOW_SECONDS = 60

interface RateLimitConfig {
  limit: number
  prefix: string
}

export const RATE_LIMITS = {
  ip: { limit: 60, prefix: 'rl:ip' } as RateLimitConfig,
  // Counted per check, unlike `ip`, because one request can make many checks.
  // 20 lets one full list of linked accounts be checked from one address.
  address: { limit: 20, prefix: 'rl:ipchk' } as RateLimitConfig,
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

export type CheckCounter = 'address' | 'pubkey' | 'platform'

export interface CheckWant {
  pubkey: string
  platform: string
}

export interface CheckRefusal {
  counter: CheckCounter
  unreadable: boolean
}

export interface CheckReservation {
  /** One entry per want, in input order; null means the check is allowed. */
  refusals: Array<CheckRefusal | null>
  /** Resolves once the counter writes finish. Never rejects. */
  written: Promise<void>
}

const CHECK_COUNTERS: readonly CheckCounter[] = ['address', 'pubkey', 'platform']

/**
 * Only the error's kind is safe to log: a storage error's message can carry the
 * key it failed on, and keys hold identifying values.
 */
function errorKind(err: unknown): string {
  return err instanceof Error ? err.name : typeof err
}

/**
 * Counts every check in a request against the address, pubkey and platform
 * limits in one pass: each counter is read once, units are handed out in input
 * order, and each counter is written once with its final value. A check is
 * allowed only when every counter it touches has a unit left, and then spends
 * one on each.
 */
export async function reserveChecks(
  kv: KVNamespace,
  wants: readonly CheckWant[],
  address: string
): Promise<CheckReservation> {
  if (wants.length === 0) return { refusals: [], written: Promise.resolve() }

  // One window for the whole reservation so reads and writes address the same keys.
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS)
  const keyFor = (counter: CheckCounter, want: CheckWant): string => {
    const config = RATE_LIMITS[counter]
    const id = counter === 'address' ? address : counter === 'pubkey' ? want.pubkey : want.platform
    return `${config.prefix}:${id}:${window}`
  }

  const keys = new Map<string, CheckCounter>()
  for (const want of wants) {
    for (const counter of CHECK_COUNTERS) keys.set(keyFor(counter, want), counter)
  }

  const base = new Map<string, number>()
  const unreadable = new Set<string>()
  await Promise.all(
    [...keys].map(async ([key, counter]) => {
      try {
        base.set(key, parseCount(await kv.get(key)))
      } catch (err) {
        unreadable.add(key)
        console.error('Reading a check limit failed:', counter, errorKind(err))
      }
    })
  )

  const spent = new Map<string, number>()
  const refusals: Array<CheckRefusal | null> = []
  const tally = new Map<string, { counter: CheckCounter; platform: string; asked: number; granted: number; hit: boolean }>()

  for (const want of wants) {
    let refusal: CheckRefusal | null = null
    for (const counter of CHECK_COUNTERS) {
      const key = keyFor(counter, want)
      if (unreadable.has(key)) {
        refusal = { counter, unreadable: true }
        break
      }
      if ((base.get(key) ?? 0) + (spent.get(key) ?? 0) >= RATE_LIMITS[counter].limit) {
        refusal = { counter, unreadable: false }
        break
      }
    }
    refusals.push(refusal)

    if (!refusal) {
      for (const counter of CHECK_COUNTERS) {
        const key = keyFor(counter, want)
        spent.set(key, (spent.get(key) ?? 0) + 1)
      }
    }

    for (const counter of CHECK_COUNTERS) {
      const id = `${counter}:${want.platform}`
      const entry = tally.get(id) ?? { counter, platform: want.platform, asked: 0, granted: 0, hit: false }
      entry.asked++
      if (!refusal) entry.granted++
      if (refusal && !refusal.unreadable && refusal.counter === counter) entry.hit = true
      tally.set(id, entry)
    }
  }

  for (const { hit, ...entry } of tally.values()) {
    if (hit) console.warn('Check limit reached:', entry)
  }

  const writes = [...spent]
    .filter(([, n]) => n > 0)
    .map(async ([key, n]) => {
      try {
        await kv.put(key, String((base.get(key) ?? 0) + n), { expirationTtl: WINDOW_SECONDS * 2 })
      } catch (err) {
        console.error('Saving a check limit failed:', keys.get(key), errorKind(err))
      }
    })

  return { refusals, written: Promise.all(writes).then(() => undefined) }
}
