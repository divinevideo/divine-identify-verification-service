// ABOUTME: Tests the Divine Confirmation access check: the request it sends, how it reads the answer, and its KV cache.
// ABOUTME: Covers untrusted answers (never a yes), unavailable outcomes, KV failures, logs without secrets, and cache expiry.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Bindings } from '../types'
import {
  confirmationAccess,
  confirmationAccessKey,
  readAccessAnswer,
  CONFIRMATION_ACCESS_YES_TTL_SECONDS,
  CONFIRMATION_ACCESS_NO_TTL_SECONDS,
  CONFIRMATION_ACCESS_TIMEOUT_MS,
} from './confirmation-access'

const PUBKEY = 'ab'.repeat(32)
const URL_BASE = 'https://access.example.test/v1/entitlements/'
const TOKEN = 'access-token'

function expiringKv() {
  const store = new Map<string, { value: string; expiresAt: number }>()
  return {
    get: vi.fn(async (key: string) => {
      const hit = store.get(key)
      if (!hit || Date.now() >= hit.expiresAt) return null
      return hit.value
    }),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, expiresAt: Date.now() + (opts?.expirationTtl ?? 0) * 1000 })
    }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
  }
}

function gateEnv(extra: Partial<Record<keyof Bindings, unknown>> = {}) {
  return {
    CACHE_KV: expiringKv(),
    CONFIRMATION_ACCESS_URL: URL_BASE,
    CONFIRMATION_ACCESS_TOKEN: TOKEN,
    ...extra,
  } as unknown as Bindings & { CACHE_KV: ReturnType<typeof expiringKv> }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const UNTRUSTED: [string, () => Response][] = [
  ['a 500', () => new Response('', { status: 500 })],
  ['a 404', () => new Response('', { status: 404 })],
  ['a redirect', () => new Response('', { status: 302, headers: { Location: 'https://elsewhere.test/' } })],
  ['isActive as a string', () => json({ isActive: 'true' })],
  ['isActive as 1', () => json({ isActive: 1 })],
  ['isActive null', () => json({ isActive: null })],
  ['no isActive', () => json({ pubkey: PUBKEY })],
  ['an array', () => json([{ isActive: true }])],
  ['HTML', () => new Response('<html></html>', { status: 200 })],
  ['an empty body', () => new Response('', { status: 200 })],
]

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('readAccessAnswer', () => {
  it('reads a boolean isActive', () => {
    expect(readAccessAnswer({ isActive: true })).toBe('yes')
    expect(readAccessAnswer({ isActive: false })).toBe('no')
  })
  it.each([
    ['isActive as a string', { isActive: 'true' }],
    ['isActive as 1', { isActive: 1 }],
    ['isActive null', { isActive: null }],
    ['no isActive', { pubkey: PUBKEY }],
    ['an array', [{ isActive: true }]],
    ['null', null],
    ['a string', 'yes'],
  ])('is null for %s', (_name, body) => {
    expect(readAccessAnswer(body)).toBeNull()
  })
})

describe('confirmationAccess', () => {
  it('exposes its constants and key', () => {
    expect(CONFIRMATION_ACCESS_YES_TTL_SECONDS).toBe(300)
    expect(CONFIRMATION_ACCESS_NO_TTL_SECONDS).toBe(60)
    expect(CONFIRMATION_ACCESS_TIMEOUT_MS).toBe(3000)
    expect(confirmationAccessKey(PUBKEY)).toBe(`confirmation_access:${PUBKEY}`)
  })

  it('asks the service with the bearer token, a 3 s timeout and no redirects', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    fetchMock.mockResolvedValue(json({ pubkey: PUBKEY, isActive: true }))
    expect(await confirmationAccess(gateEnv(), PUBKEY)).toBe('yes')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`https://access.example.test/v1/entitlements/${PUBKEY}`)
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer access-token')
    expect(init.redirect).toBe('manual')
    expect(timeout).toHaveBeenCalledWith(3000)
  })

  it('answers no for isActive false', async () => {
    fetchMock.mockResolvedValue(json({ isActive: false }))
    expect(await confirmationAccess(gateEnv(), PUBKEY)).toBe('no')
  })

  it.each(UNTRUSTED)('answers unavailable for %s, and caches nothing', async (_name, answer) => {
    const env = gateEnv()
    fetchMock.mockResolvedValue(answer())
    expect(await confirmationAccess(env, PUBKEY)).toBe('unavailable')
    expect(env.CACHE_KV.put).not.toHaveBeenCalled()
  })

  it('answers unavailable for an oversized body, even one that starts with isActive true', async () => {
    const env = gateEnv()
    fetchMock.mockResolvedValue(new Response(`{"isActive":true,"pad":"${'x'.repeat(1024 * 1024 + 10)}"}`, { status: 200 }))
    expect(await confirmationAccess(env, PUBKEY)).toBe('unavailable')
    expect(env.CACHE_KV.put).not.toHaveBeenCalled()
  })

  it('answers unavailable when the body stops arriving partway', async () => {
    const env = gateEnv()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"isActive":'))
        controller.error(new Error('connection reset'))
      },
    })
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }))
    expect(await confirmationAccess(env, PUBKEY)).toBe('unavailable')
    expect(env.CACHE_KV.put).not.toHaveBeenCalled()
  })

  it.each([
    ['a timeout', () => new DOMException('timed out', 'TimeoutError')],
    ['a network error', () => new TypeError('fetch failed')],
  ])('answers unavailable on %s', async (_name, err) => {
    const env = gateEnv()
    fetchMock.mockRejectedValue(err())
    expect(await confirmationAccess(env, PUBKEY)).toBe('unavailable')
    expect(env.CACHE_KV.put).not.toHaveBeenCalled()
  })

  it.each([
    ['no URL', { CONFIRMATION_ACCESS_URL: undefined }],
    ['no token', { CONFIRMATION_ACCESS_TOKEN: undefined }],
  ])('answers unavailable with %s, without a fetch', async (_name, extra) => {
    expect(await confirmationAccess(gateEnv(extra), PUBKEY)).toBe('unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers yes for a tester without a fetch or a cache write', async () => {
    const env = gateEnv({ CONFIRMATION_TESTERS: PUBKEY.toUpperCase() })
    expect(await confirmationAccess(env, PUBKEY)).toBe('yes')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(env.CACHE_KV.put).not.toHaveBeenCalled()
  })

  it.each(['AB'.repeat(32), 'x'])('answers no for %j, which is not a lowercase hex pubkey, without a fetch', async (value) => {
    expect(await confirmationAccess(gateEnv(), value)).toBe('no')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caches yes for 300 s and no for 60 s through KV expiry, with no time in the value', async () => {
    const yesEnv = gateEnv()
    fetchMock.mockResolvedValueOnce(json({ isActive: true }))
    await confirmationAccess(yesEnv, PUBKEY)
    expect(yesEnv.CACHE_KV.put).toHaveBeenCalledWith(confirmationAccessKey(PUBKEY), 'yes', { expirationTtl: 300 })

    const noEnv = gateEnv()
    fetchMock.mockResolvedValueOnce(json({ isActive: false }))
    await confirmationAccess(noEnv, PUBKEY)
    expect(noEnv.CACHE_KV.put).toHaveBeenCalledWith(confirmationAccessKey(PUBKEY), 'no', { expirationTtl: 60 })
  })

  it('turns a cached no into yes once its 60 s pass', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const env = gateEnv()
    fetchMock.mockResolvedValueOnce(json({ isActive: false })).mockResolvedValueOnce(json({ isActive: true }))
    expect(await confirmationAccess(env, PUBKEY)).toBe('no')
    vi.advanceTimersByTime(59_000)
    expect(await confirmationAccess(env, PUBKEY)).toBe('no')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1_000)
    expect(await confirmationAccess(env, PUBKEY)).toBe('yes')
    vi.advanceTimersByTime(299_000)
    expect(await confirmationAccess(env, PUBKEY)).toBe('yes')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('ignores a cached value that is not yes or no', async () => {
    const env = gateEnv()
    await env.CACHE_KV.put(confirmationAccessKey(PUBKEY), 'maybe', { expirationTtl: 60 })
    fetchMock.mockResolvedValue(json({ isActive: true }))
    expect(await confirmationAccess(env, PUBKEY)).toBe('yes')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats a failed cache read as a miss', async () => {
    const env = gateEnv()
    env.CACHE_KV.get.mockRejectedValue(new Error('kv down'))
    fetchMock.mockResolvedValue(json({ isActive: true }))
    expect(await confirmationAccess(env, PUBKEY)).toBe('yes')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns the fresh answer when the cache write fails, and logs without the pubkey', async () => {
    const env = gateEnv()
    env.CACHE_KV.put.mockRejectedValue(new Error(`kv down for ${PUBKEY}`))
    fetchMock.mockResolvedValue(json({ isActive: true }))
    expect(await confirmationAccess(env, PUBKEY)).toBe('yes')
    expect(console.warn).toHaveBeenCalled()
    const logged = JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls)
    expect(logged).not.toContain(PUBKEY)
    expect(logged).not.toContain('access.example.test')
    expect(logged).not.toContain(TOKEN)
  })

  it('logs why it was unavailable without the pubkey, URL or token', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }))
    expect(await confirmationAccess(gateEnv(), PUBKEY)).toBe('unavailable')
    const calls = (console.warn as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    const logged = JSON.stringify(calls)
    expect(logged).toContain('status 500')
    expect(logged).not.toContain(PUBKEY)
    expect(logged).not.toContain('access.example.test')
    expect(logged).not.toContain(TOKEN)
  })
})
