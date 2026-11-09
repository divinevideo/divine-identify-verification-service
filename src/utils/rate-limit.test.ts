import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reserveChecks } from './rate-limit'

const PK_A = 'a'.repeat(64)
const PK_B = 'b'.repeat(64)
const ADDRESS = '203.0.113.9'

const MINUTE_START = 28_333_333 * 60_000
const WINDOW = Math.floor(MINUTE_START / 60_000)

const pkKey = (pk: string) => `rl:pk:${pk}:${WINDOW}`
const addrKey = () => `rl:ipchk:${ADDRESS}:${WINDOW}`
const platKey = (platform: string) => `rl:plat:${platform}:${WINDOW}`

function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed))
  const get = vi.fn(async (key: string) => store.get(key) ?? null)
  const put = vi.fn(async (key: string, value: string, _opts?: unknown) => {
    store.set(key, value)
  })
  return { store, get, put, kv: { get, put } as unknown as KVNamespace }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('reserveChecks', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(MINUTE_START + 30_000)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('allows checks up to what the pubkey counter has left, in input order', async () => {
    const { kv, store, put } = fakeKv({ [pkKey(PK_A)]: '15' })
    const wants = Array.from({ length: 10 }, () => ({ pubkey: PK_A, platform: 'github' }))

    const { refusals, written } = await reserveChecks(kv, wants, ADDRESS)
    await written

    expect(refusals.slice(0, 5)).toEqual([null, null, null, null, null])
    expect(refusals.slice(5)).toEqual(
      Array.from({ length: 5 }, () => ({ counter: 'pubkey', unreadable: false }))
    )
    expect(store.get(pkKey(PK_A))).toBe('20')
    expect(store.get(platKey('github'))).toBe('5')
    expect(store.get(addrKey())).toBe('5')
    expect(put).toHaveBeenCalledTimes(3)
  })

  it('counts the platform counter once per check', async () => {
    const { kv, store } = fakeKv({ [platKey('github')]: '28' })
    const wants = Array.from({ length: 3 }, () => ({ pubkey: PK_A, platform: 'github' }))

    const { refusals, written } = await reserveChecks(kv, wants, ADDRESS)
    await written

    expect(refusals).toEqual([null, null, { counter: 'platform', unreadable: false }])
    expect(store.get(pkKey(PK_A))).toBe('2')
    expect(store.get(platKey('github'))).toBe('30')
  })

  it('reads and writes each counter once per reservation', async () => {
    const { kv, store, get, put } = fakeKv()
    const wants = [
      { pubkey: PK_A, platform: 'github' },
      { pubkey: PK_B, platform: 'github' },
      { pubkey: PK_A, platform: 'twitter' },
      { pubkey: PK_A, platform: 'github' },
    ]

    const { written } = await reserveChecks(kv, wants, ADDRESS)
    await written

    expect(get).toHaveBeenCalledTimes(5)
    expect(put).toHaveBeenCalledTimes(5)
    expect(store.get(addrKey())).toBe('4')
    expect(store.get(pkKey(PK_A))).toBe('3')
    expect(store.get(pkKey(PK_B))).toBe('1')
    expect(store.get(platKey('github'))).toBe('3')
    expect(store.get(platKey('twitter'))).toBe('1')
    expect(put).toHaveBeenCalledWith(pkKey(PK_A), '3', { expirationTtl: 120 })
  })

  it('writes nothing when every check is refused, and reads nothing when there are no checks', async () => {
    const { kv, get, put } = fakeKv({ [pkKey(PK_A)]: '20' })
    const wants = [
      { pubkey: PK_A, platform: 'github' },
      { pubkey: PK_A, platform: 'github' },
    ]

    const { written } = await reserveChecks(kv, wants, ADDRESS)
    await written
    expect(put).not.toHaveBeenCalled()

    get.mockClear()
    const empty = await reserveChecks(kv, [], ADDRESS)
    expect(get).not.toHaveBeenCalled()
    expect(empty.refusals).toEqual([])
  })

  it('reads every counter before handing out any units', async () => {
    const gate = deferred<string | null>()
    const get = vi.fn(() => gate.promise)
    const put = vi.fn(async () => {})
    const kv = { get, put } as unknown as KVNamespace
    const wants = [
      { pubkey: PK_A, platform: 'github' },
      { pubkey: PK_B, platform: 'twitter' },
    ]

    const pending = reserveChecks(kv, wants, ADDRESS)
    await Promise.resolve()
    await Promise.resolve()

    expect(get).toHaveBeenCalledTimes(5)
    expect(put).not.toHaveBeenCalled()

    gate.resolve(null)
    const { refusals, written } = await pending
    await written
    expect(refusals).toEqual([null, null])
  })

  it('writes to the keys it read when the minute rolls over during the reads', async () => {
    vi.setSystemTime(MINUTE_START + 59_900)
    const gate = deferred<string | null>()
    const get = vi.fn((_key: string) => gate.promise)
    const put = vi.fn(async (_key: string, _value: string, _opts?: unknown) => {})
    const kv = { get, put } as unknown as KVNamespace

    const pending = reserveChecks(kv, [{ pubkey: PK_A, platform: 'github' }], ADDRESS)
    vi.setSystemTime(MINUTE_START + 60_900)
    gate.resolve(null)
    const { written } = await pending
    await written

    const readKeys = get.mock.calls.map((c) => c[0])
    expect(put).toHaveBeenCalled()
    for (const call of put.mock.calls) {
      expect(readKeys).toContain(call[0])
    }
  })

  it('refuses only the checks whose counter could not be read', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv, store, get } = fakeKv()
    get.mockImplementation(async (key: string) => {
      if (key.includes(PK_B)) throw new Error('kv down')
      return store.get(key) ?? null
    })

    const { refusals, written } = await reserveChecks(kv, [
      { pubkey: PK_A, platform: 'github' },
      { pubkey: PK_B, platform: 'github' },
    ], ADDRESS)
    await written

    expect(refusals).toEqual([null, { counter: 'pubkey', unreadable: true }])
    expect(store.get(platKey('github'))).toBe('1')
    expect(errorSpy).toHaveBeenCalled()
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(PK_B)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('reports the pubkey counter when both counters are full', async () => {
    const { kv } = fakeKv({ [pkKey(PK_A)]: '20', [platKey('github')]: '30' })

    const { refusals } = await reserveChecks(kv, [{ pubkey: PK_A, platform: 'github' }], ADDRESS)

    expect(refusals).toEqual([{ counter: 'pubkey', unreadable: false }])
  })

  it('reports an unreadable pubkey counter ahead of a full platform counter', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv, store, get } = fakeKv({ [platKey('github')]: '30' })
    get.mockImplementation(async (key: string) => {
      if (key.includes(PK_A)) throw new Error('kv down')
      return store.get(key) ?? null
    })

    const { refusals } = await reserveChecks(kv, [{ pubkey: PK_A, platform: 'github' }], ADDRESS)

    expect(refusals).toEqual([{ counter: 'pubkey', unreadable: true }])
  })

  it("never logs a storage error's text", async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv, get } = fakeKv()
    get.mockRejectedValue(new Error('failed for rl:ipchk:203.0.113.9 and rl:pk:' + PK_B))

    await reserveChecks(kv, [{ pubkey: PK_B, platform: 'github' }], ADDRESS)

    expect(errorSpy).toHaveBeenCalled()
    const logged = JSON.stringify(errorSpy.mock.calls)
    expect(logged).not.toContain('203.0.113.9')
    expect(logged).not.toContain(PK_B)
  })

  it('still allows the checks when a counter cannot be saved', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv, put } = fakeKv()
    put.mockRejectedValue(new Error('write failed for ' + PK_A))

    const { refusals, written } = await reserveChecks(kv, [{ pubkey: PK_A, platform: 'github' }], ADDRESS)
    await expect(written).resolves.toBeUndefined()

    expect(refusals).toEqual([null])
    expect(errorSpy).toHaveBeenCalled()
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(PK_A)
  })

  it('logs a refusal by counter and platform, without the pubkey', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { kv } = fakeKv({ [pkKey(PK_A)]: '19' })

    const { written } = await reserveChecks(kv, [
      { pubkey: PK_A, platform: 'github' },
      { pubkey: PK_A, platform: 'github' },
    ], ADDRESS)
    await written

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith('Check limit reached:', {
      counter: 'pubkey',
      platform: 'github',
      asked: 2,
      granted: 1,
    })
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(PK_A)
  })

  it('refuses checks past the address budget before the pubkey and platform counters', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { kv, store, put } = fakeKv()
    const pubkeys = Array.from({ length: 20 }, (_, i) => String(i).padStart(2, '0').repeat(32))
    const wants = pubkeys.map((pubkey) => ({ pubkey, platform: 'github' }))

    const { refusals, written } = await reserveChecks(kv, wants, ADDRESS)
    await written

    expect(refusals.slice(0, 15)).toEqual(Array.from({ length: 15 }, () => null))
    expect(refusals.slice(15)).toEqual(
      Array.from({ length: 5 }, () => ({ counter: 'address', unreadable: false }))
    )
    expect(store.get(addrKey())).toBe('15')
    for (const pubkey of pubkeys.slice(15)) expect(put.mock.calls.map((c) => c[0])).not.toContain(pkKey(pubkey))
    expect(warnSpy).toHaveBeenCalledWith('Check limit reached:', {
      counter: 'address',
      platform: 'github',
      asked: 20,
      granted: 15,
    })
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(ADDRESS)
  })

  it('refuses every check when the address counter cannot be read', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv, store, get, put } = fakeKv()
    get.mockImplementation(async (key: string) => {
      if (key.startsWith('rl:ipchk:')) throw new Error('kv down')
      return store.get(key) ?? null
    })

    const { refusals, written } = await reserveChecks(kv, [
      { pubkey: PK_A, platform: 'github' },
      { pubkey: PK_B, platform: 'twitter' },
    ], ADDRESS)
    await written

    expect(refusals).toEqual([
      { counter: 'address', unreadable: true },
      { counter: 'address', unreadable: true },
    ])
    expect(put).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(ADDRESS)
  })

  it('reports the address counter when the pubkey counter is also full', async () => {
    const { kv } = fakeKv({ [addrKey()]: '15', [pkKey(PK_A)]: '20' })

    const { refusals } = await reserveChecks(kv, [{ pubkey: PK_A, platform: 'github' }], ADDRESS)

    expect(refusals).toEqual([{ counter: 'address', unreadable: false }])
  })

  it('reports an unreadable address counter ahead of a full pubkey counter', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv, store, get } = fakeKv({ [pkKey(PK_A)]: '20' })
    get.mockImplementation(async (key: string) => {
      if (key.startsWith('rl:ipchk:')) throw new Error('kv down')
      return store.get(key) ?? null
    })

    const { refusals } = await reserveChecks(kv, [{ pubkey: PK_A, platform: 'github' }], ADDRESS)

    expect(refusals).toEqual([{ counter: 'address', unreadable: true }])
  })
})
