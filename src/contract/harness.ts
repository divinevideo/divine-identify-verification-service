// ABOUTME: Target-neutral harness for the app-contract suite: the adapter interface a
// ABOUTME: target implements, the configuration names the suite sets, and a request helper.
import { afterEach, vi } from 'vitest'

/**
 * The environment a target is called with. The tests never read it: they only
 * hand it back to the target and the adapter's seeders, so its shape is the
 * adapter's business.
 */
export type TargetEnv = object

/** Anything that answers a request the way the deployed verifier does, run in this process. */
export type ContractTarget = (request: Request, env: TargetEnv) => Promise<Response>

export const BASE_URL = 'https://verifier.divine.video'

/**
 * Every configuration value the suite sets, named as this worker names them.
 * A successor's adapter honors each name or translates it to its own. Setting a
 * name to undefined means "not configured".
 */
export interface ContractConfig {
  /** Base URL for sign-in callbacks. Unset turns every sign-in off. */
  OAUTH_REDIRECT_BASE?: string
  /** "required": only confirmed sign-ins count, as production runs. */
  SIGNIN_CONFIRMATION?: string
  /** "fragment" (production) or unset: the one-time code goes after the #. */
  SIGNIN_CODE_PLACEMENT?: string
  TWITTER_CLIENT_ID?: string
  TWITTER_CLIENT_SECRET?: string
  /** YouTube sign-in. */
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** YouTube proof checks; youtube is listed only when this is set. */
  YOUTUBE_API_KEY?: string
  /** Discord proof checks, through the bot API. */
  DISCORD_BOT_TOKEN?: string
  TIKTOK_CLIENT_KEY?: string
  TIKTOK_CLIENT_SECRET?: string
  /** "true" turns TikTok sign-in on when its keys are set; production sets "false". */
  TIKTOK_OAUTH_ENABLED?: string
}

export interface ContractEnv {
  env: TargetEnv
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
 * adapter and names it in adapter.ts; seeding is the only place internal
 * storage layouts appear.
 */
export interface ContractAdapter {
  target: ContractTarget
  /**
   * A fresh environment with this configuration. It also installs a global
   * `fetch` that throws on any call, so a platform request the test did not
   * stub fails loudly.
   */
  env(config?: ContractConfig): ContractEnv
  /** Store a confirmed sign-in record that answers this claim as verified. */
  seedSignIn(env: TargetEnv, claim: SeedClaim): Promise<void>
  /** Store a verified result for this claim, as an earlier check would have. */
  seedCachedVerified(env: TargetEnv, claim: SeedClaim): Promise<void>
  /**
   * Make the named rate limit read as spent for this id: a pubkey, a platform
   * name, or a client IP as the cf-connecting-ip header carries it.
   */
  exhaustRateLimit(env: TargetEnv, kind: RateLimitKind, id: string): Promise<void>
}

/** Replaces global fetch with one that throws, so no test reaches the network. */
export function failEveryFetch(): void {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected platform fetch') }))
}

// A suite file that uses the harness must not leak the fetch stub into the next one.
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Sends one request to the target. `env` is required: building one here would
 * install a fresh throwing fetch over any stub the test set up.
 */
export function call(
  target: ContractTarget,
  method: string,
  path: string,
  body: unknown,
  env: TargetEnv,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = { method, headers: { ...headers } }
  if (body !== undefined) {
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return target(new Request(`${BASE_URL}${path}`, init), env)
}
