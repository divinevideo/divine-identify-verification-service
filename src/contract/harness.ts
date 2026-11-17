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
  /** "off" or unset: what production and this suite run, so the gate never applies. */
  CONFIRMATION_GATE?: string
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

export type FakeRelayBehaviour = 'answer' | 'refuse' | 'hang' | 'drop'

export interface FakeRelay {
  /** The relay's wss:// URL, as the service is configured with it. */
  url: string
  events: unknown[]
  /** A string, or a function called per REQ with that REQ's filters. Defaults to 'answer'. */
  behaviour?: FakeRelayBehaviour | ((filters: unknown[]) => FakeRelayBehaviour)
  /** The filters of each REQ received, in order. */
  seenFilters: unknown[][]
}

type Filter = { kinds?: number[]; authors?: string[]; '#i'?: string[]; limit?: number }

function matchesFilter(event: any, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event?.kind)) return false
  if (filter.authors && !filter.authors.includes(event?.pubkey)) return false
  if (filter['#i']) {
    const tags: unknown[] = Array.isArray(event?.tags) ? event.tags : []
    const hit = tags.some((t) => Array.isArray(t) && t[0] === 'i' && filter['#i']!.includes(t[1]))
    if (!hit) return false
  }
  return true
}

function answerFor(relay: FakeRelay, subId: string, filters: Filter[]): string[] {
  // NIP-01: limit applies per filter, to that filter's matches newest first.
  const newestFirst = (a: any, b: any) =>
    (b?.created_at ?? 0) - (a?.created_at ?? 0) || String(a?.id).localeCompare(String(b?.id))
  const kept = new Map<unknown, unknown>()
  for (const filter of filters) {
    const matched = relay.events.filter((e) => matchesFilter(e, filter)).sort(newestFirst)
    const capped = typeof filter.limit === 'number' ? matched.slice(0, filter.limit) : matched
    for (const e of capped) kept.set((e as any)?.id ?? e, e)
  }
  return [...kept.values()].map((e) => JSON.stringify(['EVENT', subId, e])).concat(JSON.stringify(['EOSE', subId]))
}

function fakeSocket(relay: FakeRelay) {
  const socket = new EventTarget() as EventTarget & {
    accept(): void
    send(message: string): void
    close(): void
  }
  let closed = false
  const emit = (event: Event) => queueMicrotask(() => { if (!closed) socket.dispatchEvent(event) })
  socket.accept = () => {}
  socket.close = () => { closed = true }
  socket.send = (message: string) => {
    let frame: unknown
    try { frame = JSON.parse(message) } catch { return }
    if (!Array.isArray(frame) || frame[0] !== 'REQ') return
    const subId = String(frame[1])
    const filters = frame.slice(2) as Filter[]
    relay.seenFilters.push(filters)
    const behaviour = typeof relay.behaviour === 'function' ? relay.behaviour(filters) : (relay.behaviour ?? 'answer')
    if (behaviour === 'answer') {
      for (const text of answerFor(relay, subId, filters)) emit(new MessageEvent('message', { data: text }))
    } else if (behaviour === 'refuse') {
      emit(new MessageEvent('message', { data: JSON.stringify(['CLOSED', subId, 'blocked: refused']) }))
    } else if (behaviour === 'drop') {
      emit(new Event('close'))
    }
  }
  return socket
}

/**
 * Stubs global fetch so a WebSocket upgrade to a listed relay's https:// host
 * answers with a fake socket that behaves as the relay says. Any other request
 * goes to `otherFetch`, or throws as failEveryFetch does.
 */
export function fakeRelays(relays: FakeRelay[], otherFetch?: typeof fetch): void {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null
    const url = request ? request.url : String(input)
    const upgrade = new Headers(init?.headers ?? request?.headers).get('Upgrade')
    const relay = relays.find((r) => r.url.replace(/^wss:/, 'https:') === url)
    if (relay && upgrade?.toLowerCase() === 'websocket') {
      // Node's Response refuses status 101, so this is the shape the Workers runtime returns.
      return Promise.resolve({ status: 101, webSocket: fakeSocket(relay) } as unknown as Response)
    }
    if (otherFetch) return otherFetch(input as any, init)
    throw new Error('Unexpected platform fetch')
  }))
}
