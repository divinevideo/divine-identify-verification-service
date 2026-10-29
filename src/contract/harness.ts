// ABOUTME: Shared harness for the app-contract suite: an in-process Worker target,
// ABOUTME: stubbed KV and a fetch that fails on any unexpected platform call.
import { afterEach, vi } from 'vitest'
import worker from '../index'
import type { Bindings } from '../types'
import { cacheKey } from '../utils/cache'
import { oauthVerificationKey } from '../oauth/state'

/** Anything that answers a request the way the deployed verifier does. */
export type ContractTarget = (request: Request, env: Bindings) => Promise<Response>

/** Today's target: this repo's Worker, run in process. */
export const workerTarget: ContractTarget = async (request, env) => worker.fetch(request, env)

export const BASE_URL = 'https://verifier.divine.video'

export interface ContractEnv {
  env: Bindings
}

export type RateLimitKind = 'pubkey' | 'platform' | 'ip'

export interface SeedClaim {
  platform: string
  /** The tidy form of the identity, as the service stores it. */
  identity: string
  pubkey: string
  proof?: string
  account_id?: string
  handle?: string
}

/**
 * Everything a target needs to run the suite. A successor supplies its own
 * adapter; seeding is the only place internal storage layouts appear.
 */
export interface ContractAdapter {
  target: ContractTarget
  /** A fresh environment. Any call to platform `fetch` throws unless a test installs its own. */
  env(overrides?: Partial<Bindings>): ContractEnv
  /** Store a confirmed sign-in record that answers this claim as verified. */
  seedSignIn(env: Bindings, claim: SeedClaim): Promise<void>
  /** Store a verified result for this claim, as an earlier check would have. */
  seedCachedVerified(env: Bindings, claim: SeedClaim): Promise<void>
  /** Make the named rate limit read as spent for this id. */
  exhaustRateLimit(env: Bindings, kind: RateLimitKind, id: string): Promise<void>
}

const RATE_LIMIT_PREFIXES: Record<RateLimitKind, string> = { pubkey: 'rl:pk', platform: 'rl:plat', ip: 'rl:ip' }
// Rate-limit counters are keyed by a time window, so a spent limit is matched
// by prefix and id rather than by the full key.
const spentLimits = new WeakMap<object, string[]>()

function verifierEnv(overrides: Partial<Bindings> = {}): ContractEnv {
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
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected platform fetch') }))
  return { env: { CACHE_KV: kv, RATE_LIMIT_KV: rateLimit, ...overrides } as unknown as Bindings }
}

/** The adapter for this repo's Worker, run in process. */
export const verifierAdapter: ContractAdapter = {
  target: workerTarget,
  env: verifierEnv,
  async seedSignIn(env, claim) {
    await env.CACHE_KV.put(oauthVerificationKey(claim.platform, claim.identity, claim.pubkey), JSON.stringify({
      platform: claim.platform, identity: claim.identity, pubkey: claim.pubkey, verified: true,
      method: 'oauth', checked_at: Math.floor(Date.now() / 1000), confirmed: true,
      ...(claim.account_id ? { account_id: claim.account_id } : {}),
      ...(claim.handle ? { handle: claim.handle } : {}),
    }))
  },
  async seedCachedVerified(env, claim) {
    await env.CACHE_KV.put(cacheKey(claim.platform, claim.identity, claim.proof ?? '', claim.pubkey), JSON.stringify({
      verified: true, checked_at: Math.floor(Date.now() / 1000), type: 'verified',
    }))
  },
  async exhaustRateLimit(env, kind, id) {
    spentLimits.get(env.RATE_LIMIT_KV)?.push(`${RATE_LIMIT_PREFIXES[kind]}:${id}:`)
  },
}

// A suite file that uses the harness must not leak the fetch stub into the next one.
afterEach(() => vi.unstubAllGlobals())

export function call(
  target: ContractTarget,
  method: string,
  path: string,
  body?: unknown,
  env?: Bindings,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = { method, headers: { ...headers } }
  if (body !== undefined) {
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return target(new Request(`${BASE_URL}${path}`, init), env ?? verifierAdapter.env().env)
}
