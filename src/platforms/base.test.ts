// ABOUTME: The helpers every platform check shares: a time limit on each request and on the whole
// ABOUTME: check, a cap on how much of an answer is read, and closing an answer nobody will read.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discardBody,
  fetchFromPlatform,
  MAX_RESPONSE_BYTES,
  PLATFORM_CHECK_TIME_BUDGET_MS,
  PLATFORM_REQUEST_TIMEOUT_MS,
  PlatformUnavailableError,
  readJson,
  readText,
  throwIfUnanswered,
  withinTimeBudget,
} from './base'

const encode = (text: string) => new TextEncoder().encode(text)
const timedOut = () => new DOMException('The operation timed out.', 'TimeoutError')

// A body that has started and then stops arriving, and fails the way a real one
// does when the request's signal is aborted.
function stallsAfter(first: string, signal: AbortSignal): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encode(first))
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
    },
  }))
}

// A body of `total` bytes that records how much of it was asked for and whether the reader gave up.
function bigBody(total: number) {
  const source = { pulled: 0, cancelled: false }
  const chunk = new Uint8Array(64 * 1024).fill(97)
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (source.pulled >= total) return controller.close()
      controller.enqueue(chunk)
      source.pulled += chunk.length
    },
    cancel() { source.cancelled = true },
  }))
  return { response, source }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('fetchFromPlatform', () => {
  it('gives each request a time limit of five seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'))

    await fetchFromPlatform('Example', 'https://example.com/a', { headers: { 'X-Test': '1' } }, fetcher)

    expect(PLATFORM_REQUEST_TIMEOUT_MS).toBe(5000)
    expect(timeout).toHaveBeenCalledWith(5000)
    const init = fetcher.mock.calls[0][1]
    expect(init?.signal).toBe(timeout.mock.results[0].value)
    expect(init?.headers).toEqual({ 'X-Test': '1' })
  })

  it('reports a request that outlives its limit as the platform not answering', async () => {
    const expired = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(expired.signal)
    const fetcher = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })

    const pending = fetchFromPlatform('Example', 'https://example.com/a', undefined, fetcher)
    expired.abort(timedOut())

    await expect(pending).rejects.toBeInstanceOf(PlatformUnavailableError)
    await expect(pending).rejects.toThrow("Example couldn't be reached (TimeoutError)")
  })
})

describe('readText', () => {
  it('returns a small answer whole', async () => {
    expect(await readText(new Response('hello'), 'Example')).toEqual({ text: 'hello', truncated: false })
  })

  it('reads an empty answer as no text', async () => {
    expect(await readText(new Response(null), 'Example')).toEqual({ text: '', truncated: false })
  })

  it('stops reading at the cap and closes the rest', async () => {
    const { response, source } = bigBody(200 * 1024 * 1024)

    const { text, truncated } = await readText(response, 'Example')

    expect(new TextEncoder().encode(text).length).toBe(MAX_RESPONSE_BYTES)
    expect(truncated).toBe(true)
    expect(source.cancelled).toBe(true)
    expect(source.pulled).toBeLessThan(MAX_RESPONSE_BYTES + 256 * 1024)
  })

  it('does not call an answer exactly the size of the cap cut short', async () => {
    const { response } = bigBody(MAX_RESPONSE_BYTES)
    const { truncated } = await readText(response, 'Example')
    expect(truncated).toBe(false)
  })

  it('reports an answer that stops arriving as the platform not answering', async () => {
    const abort = new AbortController()
    const pending = readText(stallsAfter('{"', abort.signal), 'Example')
    abort.abort(timedOut())

    await expect(pending).rejects.toBeInstanceOf(PlatformUnavailableError)
    await expect(pending).rejects.toThrow('Example stopped answering (TimeoutError)')
  })
})

describe('readJson', () => {
  it('parses an answer', async () => {
    expect(await readJson(new Response('{"a":1}'), 'Example')).toEqual({ a: 1 })
  })

  it('answers undefined for text that is not JSON', async () => {
    expect(await readJson(new Response('<html>'), 'Example')).toBeUndefined()
  })

  it('answers undefined for an answer over the cap, without reading the rest', async () => {
    const { response, source } = bigBody(200 * 1024 * 1024)
    expect(await readJson(response, 'Example')).toBeUndefined()
    expect(source.cancelled).toBe(true)
  })

  it('keeps JSON null as null, so it is not mistaken for unreadable', async () => {
    expect(await readJson(new Response('null'), 'Example')).toBeNull()
  })

  it('reports an answer that stops arriving as the platform not answering, not as bad JSON', async () => {
    const abort = new AbortController()
    const pending = readJson(stallsAfter('{"', abort.signal), 'Example')
    abort.abort(timedOut())

    await expect(pending).rejects.toBeInstanceOf(PlatformUnavailableError)
  })
})

describe('discardBody', () => {
  it('closes an answer nobody will read', async () => {
    const { response, source } = bigBody(1024 * 1024)
    await discardBody(response)
    expect(source.cancelled).toBe(true)
  })

  it('does nothing for an answer with no body, or one already read', async () => {
    await expect(discardBody(new Response(null))).resolves.toBeUndefined()
    const read = new Response('x')
    await read.text()
    await expect(discardBody(read)).resolves.toBeUndefined()
  })
})

describe('withinTimeBudget', () => {
  it('allows a whole check fifteen seconds, three times the limit on one request', () => {
    expect(PLATFORM_CHECK_TIME_BUDGET_MS).toBe(15_000)
    expect(PLATFORM_CHECK_TIME_BUDGET_MS).toBe(3 * PLATFORM_REQUEST_TIMEOUT_MS)
  })

  it('answers with the work when it finishes in time, and leaves no timer running', async () => {
    vi.useFakeTimers()
    const work = new Promise<string>((resolve) => setTimeout(() => resolve('done'), 1000))

    const answer = withinTimeBudget(work, 15_000, 'Example')
    await vi.advanceTimersByTimeAsync(1000)

    await expect(answer).resolves.toBe('done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up on work that runs past the budget, as the platform not answering', async () => {
    vi.useFakeTimers()
    const answer = withinTimeBudget(new Promise<string>(() => {}), 15_000, 'Example')
    const outcome = expect(answer).rejects.toThrow("Example didn't finish within 15 seconds")

    await vi.advanceTimersByTimeAsync(15_000)

    await outcome
    await expect(answer).rejects.toBeInstanceOf(PlatformUnavailableError)
  })

  it('does not give up a moment early', async () => {
    vi.useFakeTimers()
    let settled = false
    const answer = withinTimeBudget(new Promise<string>(() => {}), 15_000, 'Example')
    answer.catch(() => { settled = true })

    await vi.advanceTimersByTimeAsync(14_999)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
  })

  it('passes on the work\'s own failure', async () => {
    const failure = new Error('boom')
    await expect(withinTimeBudget(Promise.reject(failure), 15_000, 'Example')).rejects.toBe(failure)
  })
})

describe('throwIfUnanswered', () => {
  it('closes the answer it refuses, so it is not left open while the check moves on', () => {
    const { response, source } = bigBody(1024 * 1024)
    const refused = new Response(response.body, { status: 503 })

    expect(() => throwIfUnanswered(refused, 'Example')).toThrow(PlatformUnavailableError)
    expect(source.cancelled).toBe(true)
  })

  it('leaves an answer it accepts unread', () => {
    const { response, source } = bigBody(1024 * 1024)
    throwIfUnanswered(response, 'Example')
    expect(source.cancelled).toBe(false)
  })
})
