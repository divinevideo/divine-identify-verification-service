// ABOUTME: The contract adapter for this repo's Worker, run in process. The only file in
// ABOUTME: the suite that imports the Worker or knows its storage keys.
import { vi } from 'vitest'
import worker from '../index'
import type { Bindings } from '../types'
import { cacheKey } from '../utils/cache'
import { oauthVerificationKey } from '../oauth/state'
import { failEveryFetch, type ContractAdapter, type ContractConfig, type ContractEnv, type RateLimitKind } from './harness'

// Fails to compile if the suite names a configuration value this Worker does not read.
const configNamesAreBindings: [Exclude<keyof ContractConfig, keyof Bindings>] extends [never] ? true : false = true
void configNamesAreBindings

const RATE_LIMIT_PREFIXES: Record<RateLimitKind, string> = { pubkey: 'rl:pk', platform: 'rl:plat', ip: 'rl:ip' }
// Rate-limit counters are keyed by a time window, so a spent limit is matched
// by prefix and id rather than by the full key.
const spentLimits = new WeakMap<object, string[]>()

function verifierEnv(config: ContractConfig = {}): ContractEnv {
  const store = new Map<string, string>()
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
  }
  const spent: string[] = []
  const rateLimit = {
    get: vi.fn(async (key: string) => (spent.some(prefix => key.startsWith(prefix)) ? '1000' : null)),
    put: vi.fn(async () => {}),
  }
  spentLimits.set(rateLimit, spent)
  failEveryFetch()
  return { env: { CACHE_KV: kv, RATE_LIMIT_KV: rateLimit, ...config } as unknown as Bindings }
}

const bindings = (env: object) => env as Bindings

/** The adapter for this repo's Worker, run in process. */
export const verifierAdapter: ContractAdapter = {
  target: async (request, env) => worker.fetch(request, bindings(env)),
  env: verifierEnv,
  async seedSignIn(env, claim) {
    await bindings(env).CACHE_KV.put(oauthVerificationKey(claim.platform, claim.identity, claim.pubkey), JSON.stringify({
      platform: claim.platform, identity: claim.identity, pubkey: claim.pubkey, verified: true,
      method: 'oauth', checked_at: Math.floor(Date.now() / 1000), confirmed: true,
      ...(claim.account_id ? { account_id: claim.account_id } : {}),
      ...(claim.handle ? { handle: claim.handle } : {}),
    }))
  },
  async seedCachedVerified(env, claim) {
    await bindings(env).CACHE_KV.put(cacheKey(claim.platform, claim.identity, claim.proof ?? '', claim.pubkey), JSON.stringify({
      verified: true, checked_at: Math.floor(Date.now() / 1000), type: 'verified',
    }))
  },
  async exhaustRateLimit(env, kind, id) {
    spentLimits.get(bindings(env).RATE_LIMIT_KV)?.push(`${RATE_LIMIT_PREFIXES[kind]}:${id}:`)
  },
}
