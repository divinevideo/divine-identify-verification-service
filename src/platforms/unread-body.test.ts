// ABOUTME: An answer a check won't read is closed before the check's next request goes out, and an
// ABOUTME: answer far bigger than any real one is not read to the end.
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import type { Bindings } from '../types'
import { hexToNpub } from '../utils/npub'
import { MAX_RESPONSE_BYTES } from './base'

const PUBKEY = 'ab'.repeat(32)

function createEnv(extra: Record<string, string> = {}) {
  const store = new Map<string, string>()
  return {
    CACHE_KV: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    },
    RATE_LIMIT_KV: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
    ...extra,
  } as unknown as Bindings
}

// Bodies the stub below has handed out, and whether each was closed.
const handedOut = new Map<string, { closed: boolean }>()

// An answer whose body has started and never ends, so an unread one stays open as it would on a socket.
function stillArriving(name: string, status: number): Response {
  const state = { closed: false }
  handedOut.set(name, state)
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')) },
    cancel() { state.closed = true },
  }), { status })
}

const json = (value: unknown) => Response.json(value)

// Each request, with which earlier bodies were closed at the moment it was made.
let requests: { url: string; closed: Record<string, boolean> }[] = []

function stubFetch(route: (url: string) => Response) {
  requests = []
  handedOut.clear()
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    requests.push({ url, closed: Object.fromEntries([...handedOut].map(([name, state]) => [name, state.closed])) })
    return route(url)
  }))
}

async function check(env: Bindings, platform: string, identity: string, proof: string) {
  const response = await worker.fetch(new Request('https://example.com/verify/single', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, identity, proof, pubkey: PUBKEY }),
  }), env)
  return response.json() as Promise<Record<string, unknown>>
}

// Whether `name` was closed when the first request to a URL containing `next` went out.
function closedBeforeRequestTo(name: string, next: string) {
  const request = requests.find((r) => r.url.includes(next))
  expect(request, `no request to ${next}`).toBeDefined()
  return request!.closed[name]
}

const DID = `did:plc:${'a'.repeat(24)}`
const PDS = 'https://pds.example.com'

// A Bluesky account whose own server (PDS) answers the identity-link record lookup with `pdsStatus`.
function blueskyAccount(pdsStatus: number) {
  return (url: string): Response => {
    if (url.includes('com.atproto.identity.resolveHandle')) return json({ did: DID })
    if (url.startsWith(`https://plc.directory/${DID}`)) return json({ service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] })
    if (url.startsWith(PDS)) return stillArriving('pds', pdsStatus)
    return new Response(null, { status: 404 }) // the proof post
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('an answer the check will not read', () => {
  it.each([
    ['did not answer (503)', 503],
    ['had no usable answer (403)', 403],
    ['found no record (404)', 404],
  ] as const)('bluesky: a record lookup that %s is closed before the proof post is requested', async (_what, status) => {
    stubFetch(blueskyAccount(status))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await check(createEnv(), 'bluesky', 'synthetic.bsky.social', 'abc123rkey')

    expect(closedBeforeRequestTo('pds', 'getPostThread')).toBe(true)
  })

  it.each([
    ['handle lookup', 'com.atproto.identity.resolveHandle'],
    ['DID document lookup', `https://plc.directory/${DID}`],
  ] as const)('bluesky: a %s that had no usable answer is closed before the next lookup', async (step, marker) => {
    stubFetch((url) => {
      if (url.includes(marker)) return stillArriving('lookup', 403)
      if (url.includes('com.atproto.identity.resolveHandle')) return json({ did: DID })
      return new Response(null, { status: 404 })
    })

    await check(createEnv(), 'bluesky', 'synthetic.bsky.social', 'abc123rkey')

    expect(closedBeforeRequestTo('lookup', 'getPostThread'), step).toBe(true)
  })

  it('bluesky: a did:web document lookup that had no usable answer is closed before the proof post is requested', async () => {
    stubFetch((url) => (url.includes('.well-known/did.json') ? stillArriving('lookup', 403) : new Response(null, { status: 404 })))

    await check(createEnv(), 'bluesky', 'did:web:example.com', 'abc123rkey')

    expect(closedBeforeRequestTo('lookup', 'getPostThread')).toBe(true)
  })

  it('github with a token: an API that did not answer (503) is closed before the public copy is requested', async () => {
    stubFetch((url) => (url.startsWith('https://api.github.com/') ? stillArriving('api', 503) : new Response(null, { status: 404 })))

    await check(createEnv({ GITHUB_TOKEN: 'synthetic-token' }), 'github', 'synthetic-user', 'abc123')

    expect(closedBeforeRequestTo('api', 'gist.githubusercontent.com')).toBe(true)
  })

  // These already closed their answers before this was one shared helper, and
  // show that the test above can see a body being closed.
  it('mastodon: a 404 from the claimed server is closed before the WebFinger lookup', async () => {
    stubFetch((url) => (url.includes('/api/v1/statuses/') ? stillArriving('status', 404) : new Response(null, { status: 404 })))

    await check(createEnv(), 'mastodon', 'mastodon.social/@synthetic', '109876543210')

    expect(closedBeforeRequestTo('status', 'webfinger')).toBe(true)
  })

  it('tiktok: a share link\'s redirect is closed before its status is read', async () => {
    stubFetch((url) => (url.includes('/t/') ? stillArriving('share', 302) : new Response(null, { status: 404 })))

    await check(createEnv(), 'tiktok', 'synthetic', 'https://www.tiktok.com/t/ZTsynthetic/')

    expect(handedOut.get('share')?.closed).toBe(true)
  })
})

describe('an answer far bigger than any real one', () => {
  it('github: a gist file past the cap is cut short, and the person is told to put the npub near the start', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(97)
    const source = { pulled: 0, closed: false }
    stubFetch(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (source.pulled >= 8 * MAX_RESPONSE_BYTES) return controller.close()
        controller.enqueue(chunk)
        source.pulled += chunk.length
      },
      cancel() { source.closed = true },
    }), { status: 200 }))

    const body = await check(createEnv(), 'github', 'synthetic-user', 'abc123')

    expect(body.verified).toBe(false)
    expect(body.error).toMatch(/npub not found in gist content/)
    expect(body.error).toMatch(/Only the first 1 MB of that file is read/)
    expect(source.closed).toBe(true)
    expect(source.pulled).toBeLessThan(2 * MAX_RESPONSE_BYTES)
  })

  it('github: a gist file under the cap gets the usual answer, with no note about the cap', async () => {
    stubFetch(() => new Response('nothing to see here', { status: 200 }))

    const body = await check(createEnv(), 'github', 'synthetic-user', 'abc123')

    expect(body.error).toMatch(/npub not found in gist content/)
    expect(body.error).not.toMatch(/first 1 MB/)
  })

  it('github: an npub inside the cap is still found in a large file', async () => {
    stubFetch(() => new Response(`${hexToNpub(PUBKEY)}\n${'a'.repeat(MAX_RESPONSE_BYTES / 2)}`, { status: 200 }))

    const body = await check(createEnv(), 'github', 'synthetic-user', 'abc123')

    expect(body.verified).toBe(true)
  })
})
