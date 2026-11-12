import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bindings } from '../types'
import { blueskyAccountAnswer } from '../test-support/bluesky-account'
import { accountStatusKey, blueskyAccountStatus, forgetBlueskyAccountStatus } from './bluesky-account-status'

// Whether a Bluesky account is still active on its own host, so a sign-in
// link stops counting once the account is deleted or deactivated.

const DID = 'did:plc:alice111111111111111111'
const PDS = 'https://pds.account.test'
const PLC_URL = `https://plc.directory/${DID}`
const STATUS_URL = `${PDS}/xrpc/com.atproto.sync.getRepoStatus?did=${encodeURIComponent(DID)}`

function createEnv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: { expirationTtl?: number }) => { store.set(key, value) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
  }
  const env = { CACHE_KV: kv } as unknown as Bindings
  return { env, store, kv }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Answers the PLC lookup with a DID document naming PDS, and getRepoStatus with `status()`.
function stubFetch(status: () => Response, overrides: { plc?: () => Response } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === PLC_URL && overrides.plc) return overrides.plc()
    if (url === STATUS_URL) return status()
    const answer = blueskyAccountAnswer(url, DID)
    if (answer) return answer
    throw new Error('unexpected fetch')
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('blueskyAccountStatus', () => {
  it('answers active when the PDS says active, and remembers it for an hour', async () => {
    const { env, kv } = createEnv()
    stubFetch(() => json({ did: DID, active: true }))
    expect(await blueskyAccountStatus(env, DID)).toBe('active')
    expect(kv.put).toHaveBeenCalledWith(`bsky_account_status:${DID}`, 'active', { expirationTtl: 3600 })
  })

  it.each(['deactivated', 'deleted', 'takendown', 'suspended', undefined])(
    'answers inactive for active:false with status %s, remembered for five minutes',
    async (status) => {
      const { env, kv } = createEnv()
      stubFetch(() => json({ did: DID, active: false, ...(status ? { status } : {}) }))
      expect(await blueskyAccountStatus(env, DID)).toBe('inactive')
      expect(kv.put).toHaveBeenCalledWith(`bsky_account_status:${DID}`, 'inactive', { expirationTtl: 300 })
    },
  )

  it('answers inactive for a tombstoned DID (PLC 410) without asking a PDS', async () => {
    const { env } = createEnv()
    const fetchMock = stubFetch(() => json({ did: DID, active: true }), { plc: () => json({ message: 'DID not available' }, 410) })
    expect(await blueskyAccountStatus(env, DID)).toBe('inactive')
    expect(fetchMock.mock.calls.map(c => String(c[0]))).toEqual([PLC_URL])
  })

  it('answers inactive for a DID PLC has never seen (404)', async () => {
    const { env } = createEnv()
    stubFetch(() => json({ did: DID, active: true }), { plc: () => json({ message: 'DID not registered' }, 404) })
    expect(await blueskyAccountStatus(env, DID)).toBe('inactive')
  })

  it('answers inactive for a DID document without an #atproto_pds service', async () => {
    const { env } = createEnv()
    const fetchMock = stubFetch(() => json({ did: DID, active: true }), { plc: () => json({ id: DID, service: [] }) })
    expect(await blueskyAccountStatus(env, DID)).toBe('inactive')
    expect(fetchMock.mock.calls.map(c => String(c[0]))).toEqual([PLC_URL])
  })

  it('answers inactive when the PDS answers 400 RepoNotFound', async () => {
    const { env, kv } = createEnv()
    stubFetch(() => json({ error: 'RepoNotFound', message: 'Could not find repo' }, 400))
    expect(await blueskyAccountStatus(env, DID)).toBe('inactive')
    expect(kv.put).toHaveBeenCalledWith(`bsky_account_status:${DID}`, 'inactive', { expirationTtl: 300 })
  })

  it.each([
    ['the PDS is unreachable', () => { throw new TypeError('network down') }],
    ['the PDS answers 502', () => new Response('bad gateway', { status: 502 })],
    ['the PDS answers 400 with another error', () => json({ error: 'InvalidRequest' }, 400)],
  ])('answers null and remembers nothing when %s', async (_name, answer) => {
    const { env, kv } = createEnv()
    stubFetch(answer)
    expect(await blueskyAccountStatus(env, DID)).toBeNull()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('treats a PDS 404 as unknown', async () => {
    // An XRPC 404 can mean the server does not support the endpoint, so it says nothing about the account.
    const { env, kv } = createEnv()
    stubFetch(() => json({ error: 'NotFound' }, 404))
    expect(await blueskyAccountStatus(env, DID)).toBeNull()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it.each([
    ['an HTML page', () => new Response('<html>', { status: 200 })],
    ['JSON without active', () => json({ did: DID })],
  ])('treats a body that is %s as unknown', async (_name, answer) => {
    const { env, kv } = createEnv()
    stubFetch(answer)
    expect(await blueskyAccountStatus(env, DID)).toBeNull()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('answers null when PLC is unreachable', async () => {
    const { env, kv } = createEnv()
    stubFetch(() => json({ did: DID, active: true }), { plc: () => { throw new TypeError('network down') } })
    expect(await blueskyAccountStatus(env, DID)).toBeNull()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('answers null when the whole lookup takes longer than 3 seconds', async () => {
    vi.useFakeTimers()
    const { env, kv } = createEnv()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === STATUS_URL) return new Promise<Response>(() => {})
      return blueskyAccountAnswer(url, DID)!
    }))
    const pending = blueskyAccountStatus(env, DID)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await pending).toBeNull()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it.each([401, 403, 500, 429, 400])('answers null when PLC answers %s', async (status) => {
    const { env, kv } = createEnv()
    stubFetch(() => json({ did: DID, active: true }), { plc: () => json({ message: 'no' }, status) })
    expect(await blueskyAccountStatus(env, DID)).toBeNull()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it.each([
    ['JSON null', () => json(null)],
    ['a JSON array', () => json([])],
    ['HTML', () => new Response('<html>', { status: 200 })],
  ])('answers null when PLC answers 200 with %s', async (_name, plc) => {
    const { env, kv } = createEnv()
    stubFetch(() => json({ did: DID, active: true }), { plc })
    expect(await blueskyAccountStatus(env, DID)).toBeNull()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('answers null for a PDS service whose endpoint cannot be used', async () => {
    const { env } = createEnv()
    stubFetch(() => json({ did: DID, active: true }), {
      plc: () => json({ id: DID, service: [{ id: '#atproto_pds', serviceEndpoint: 'http://pds.account.test' }] }),
    })
    expect(await blueskyAccountStatus(env, DID)).toBeNull()
  })

  it('answers null for an unsupported DID method', async () => {
    const { env } = createEnv()
    const fetchMock = stubFetch(() => json({ did: DID, active: true }))
    expect(await blueskyAccountStatus(env, 'did:key:z6Mkexample')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  describe('did:web', () => {
    const WEB_DID = 'did:web:alice.example.com'
    const WEB_URL = 'https://alice.example.com/.well-known/did.json'
    function stubWeb(web: () => Response) {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === WEB_URL) return web()
        throw new Error('unexpected fetch')
      }))
    }

    it('answers inactive when the host has no did.json (404)', async () => {
      const { env } = createEnv()
      stubWeb(() => new Response('nope', { status: 404 }))
      expect(await blueskyAccountStatus(env, WEB_DID)).toBe('inactive')
    })

    it.each([403, 500])('answers null when the host answers %s', async (status) => {
      const { env } = createEnv()
      stubWeb(() => new Response('x', { status }))
      expect(await blueskyAccountStatus(env, WEB_DID)).toBeNull()
    })

    it('answers null when the host answers 200 with HTML', async () => {
      const { env } = createEnv()
      stubWeb(() => new Response('<html>', { status: 200 }))
      expect(await blueskyAccountStatus(env, WEB_DID)).toBeNull()
    })
  })

  it('still answers when the remembered answer cannot be read', async () => {
    const { env, kv } = createEnv()
    kv.get.mockRejectedValue(new Error('kv down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch(() => json({ did: DID, active: true }))
    expect(await blueskyAccountStatus(env, DID)).toBe('active')
  })

  it('reuses a remembered answer without fetching', async () => {
    const { env } = createEnv({ [accountStatusKey(DID)]: 'inactive' })
    const fetchMock = stubFetch(() => json({ did: DID, active: true }))
    expect(await blueskyAccountStatus(env, DID)).toBe('inactive')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks again after forgetBlueskyAccountStatus', async () => {
    const { env } = createEnv({ [accountStatusKey(DID)]: 'inactive' })
    stubFetch(() => json({ did: DID, active: true }))
    await forgetBlueskyAccountStatus(env, DID)
    expect(await blueskyAccountStatus(env, DID)).toBe('active')
  })

  it('keys the remembered answer by the lowercased DID', () => {
    expect(accountStatusKey('did:web:Example.COM')).toBe('bsky_account_status:did:web:example.com')
  })

  it('still answers when the answer cannot be remembered', async () => {
    const { env, kv } = createEnv()
    kv.put.mockRejectedValue(new Error('kv down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch(() => json({ did: DID, active: true }))
    expect(await blueskyAccountStatus(env, DID)).toBe('active')
  })

  it('logs no DID or URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { env: unreachableEnv } = createEnv()
    stubFetch(() => { throw new TypeError(`network down ${STATUS_URL}`) })
    await blueskyAccountStatus(unreachableEnv, DID)

    const { env, kv } = createEnv()
    kv.put.mockRejectedValue(new Error(`kv down ${accountStatusKey(DID)} ${DID}`))
    stubFetch(() => json({ did: DID, active: true }))
    await blueskyAccountStatus(env, DID)

    const logged = [...warn.mock.calls, ...error.mock.calls].flat().map(a => String(a)).join(' ')
    expect(warn.mock.calls.length + error.mock.calls.length).toBeGreaterThan(0)
    expect(logged).not.toContain(DID)
    expect(logged).not.toContain('pds.account.test')
    expect(logged).not.toContain('bsky_account_status:')
  })
})
