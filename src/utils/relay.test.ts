import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeRelays, type FakeRelay } from '../contract/harness'
import { MAX_RELAY_EVENTS, queryRelay, RELAY_TIMEOUT_MS } from './relay'

const URL_ = 'wss://relay.example'
const relay = (over: Partial<FakeRelay> = {}): FakeRelay => ({ url: URL_, events: [], seenFilters: [], ...over })
const PK = 'a'.repeat(64)
const ev = (id: string, kind = 10000, extra: Record<string, unknown> = {}) =>
  ({ id, kind, pubkey: PK, created_at: Number(id) || 0, tags: [], content: '', ...extra })
const filters = [{ kinds: [10000], authors: ['a'.repeat(64)] }]

afterEach(() => { vi.useRealTimers() })

describe('queryRelay', () => {
  it('resolves with the events for its subscription at EOSE', async () => {
    const r = relay({ events: [ev('1'), ev('2'), ev('3', 1)] })
    fakeRelays([r])
    expect(await queryRelay(URL_, filters)).toEqual([ev('2'), ev('1')])
    expect(r.seenFilters[0]).toEqual(filters)
  })

  it('rejects when the relay refuses', async () => {
    fakeRelays([relay({ behaviour: 'refuse' })])
    await expect(queryRelay(URL_, filters)).rejects.toThrow()
  })

  it('rejects when the relay hangs up before EOSE', async () => {
    fakeRelays([relay({ behaviour: 'drop' })])
    await expect(queryRelay(URL_, filters)).rejects.toThrow()
  })

  it('rejects after the timeout', async () => {
    vi.useFakeTimers()
    fakeRelays([relay({ behaviour: 'hang' })])
    const result = queryRelay(URL_, filters)
    const assertion = expect(result).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(RELAY_TIMEOUT_MS)
    await assertion
  })

  it('leaves no timer running once it settles', async () => {
    vi.useFakeTimers()
    fakeRelays([relay()])
    await queryRelay(URL_, filters)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores frames that are not ours', async () => {
    const socketFrames = (sub: string) => [
      'not json',
      JSON.stringify(['EVENT', 'someone-else', ev('other')]),
      JSON.stringify(['NOTICE', 'hello']),
      JSON.stringify(['EVENT', sub, ev('mine')]),
      JSON.stringify(['EOSE', sub]),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => {
      const socket: any = new EventTarget()
      socket.accept = () => {}
      socket.close = () => {}
      socket.send = (m: string) => {
        const [verb, sub] = JSON.parse(m)
        if (verb !== 'REQ') return
        for (const data of socketFrames(sub)) queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data })))
      }
      return { status: 101, webSocket: socket } as unknown as Response
    }))
    expect(await queryRelay(URL_, filters)).toEqual([ev('mine')])
  })

  it('resolves with the first 50 events when the cap is hit, without waiting for EOSE', async () => {
    const sent: string[] = []
    let closed = false
    vi.stubGlobal('fetch', vi.fn(async () => {
      const socket: any = new EventTarget()
      socket.accept = () => {}
      socket.close = () => { closed = true }
      socket.send = (m: string) => {
        const [verb, sub] = JSON.parse(m)
        sent.push(verb)
        if (verb !== 'REQ') return
        for (let i = 0; i < 60; i++) {
          const data = JSON.stringify(['EVENT', sub, ev(String(i))])
          queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data })))
        }
      }
      return { status: 101, webSocket: socket } as unknown as Response
    }))
    const events = await queryRelay(URL_, [{ kinds: [10000] }])
    expect(events).toHaveLength(MAX_RELAY_EVENTS)
    expect(events[0]).toEqual(ev('0'))
    expect(sent).toEqual(['REQ', 'CLOSE'])
    expect(closed).toBe(true)
  })

  it('rejects when the upgrade is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 400 }) as unknown as Response))
    await expect(queryRelay(URL_, filters)).rejects.toThrow()
  })

  it('rejects instead of throwing when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('boom') }))
    await expect(queryRelay(URL_, filters)).rejects.toThrow('boom')
  })

  it('closes a socket whose upgrade answers after the timeout', async () => {
    vi.useFakeTimers()
    let answer: (response: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { answer = res })))
    const assertion = expect(queryRelay(URL_, filters)).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(RELAY_TIMEOUT_MS)
    await assertion
    const calls: string[] = []
    const socket = { accept: () => { calls.push('accept') }, close: () => { calls.push('close') }, send: () => { calls.push('send') } }
    answer({ status: 101, webSocket: socket } as unknown as Response)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(['accept', 'close'])
  })

  it('rejects at the timeout when the upgrade never answers', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
    })))
    const assertion = expect(queryRelay(URL_, filters)).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(RELAY_TIMEOUT_MS)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('fakeRelays matching', () => {
  const OTHER = 'b'.repeat(64)

  it('matches #i against any i tag', async () => {
    const hit = ev('1', 30000, { tags: [['d', 'x'], ['i', 'github:alice'], ['i', 'other']] })
    const miss = ev('2', 30000, { tags: [['i', 'github:bob']] })
    const noTags = ev('3', 30000)
    fakeRelays([relay({ events: [hit, miss, noTags] })])
    expect(await queryRelay(URL_, [{ kinds: [30000], '#i': ['github:alice', 'nope'] }])).toEqual([hit])
  })

  it('treats a filter without authors as matching every author', async () => {
    const mine = ev('1')
    const theirs = ev('2', 10000, { pubkey: OTHER })
    fakeRelays([relay({ events: [mine, theirs] })])
    expect(await queryRelay(URL_, [{ kinds: [10000] }])).toEqual([theirs, mine])
    expect(await queryRelay(URL_, [{ kinds: [10000], authors: [OTHER] }])).toEqual([theirs])
  })

  it('lets a function behaviour refuse one REQ and answer another', async () => {
    const r = relay({
      events: [ev('1')],
      behaviour: (f) => ((f[0] as any).kinds[0] === 10001 ? 'refuse' : 'answer'),
    })
    fakeRelays([r])
    await expect(queryRelay(URL_, [{ kinds: [10001] }])).rejects.toThrow(/closed/)
    expect(await queryRelay(URL_, [{ kinds: [10000] }])).toEqual([ev('1')])
    expect(r.seenFilters).toHaveLength(2)
  })

  it('applies limit per filter, newest first', async () => {
    const lists = [ev('1', 10011), ev('5', 10011), ev('3', 10011)]
    const profiles = [ev('2', 0), ev('4', 0)]
    fakeRelays([relay({ events: [...lists, ...profiles] })])
    const got = await queryRelay(URL_, [
      { kinds: [10011], authors: [PK], limit: 1 },
      { kinds: [0], authors: [PK], limit: 1 },
    ])
    expect(got).toEqual([ev('5', 10011), ev('4', 0)])
  })

  it('returns an event that matches two filters once', async () => {
    const e = ev('1', 10000)
    fakeRelays([relay({ events: [e] })])
    expect(await queryRelay(URL_, [{ kinds: [10000] }, { authors: [PK] }])).toEqual([e])
  })
})
