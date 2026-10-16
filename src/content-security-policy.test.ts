import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import { ALLOWED_PARENT_SUFFIXES } from './embed-bridge'
import type { Bindings } from './types'
import { cacheKey } from './utils/cache'

// Both HTML pages only run scripts the verifier serves (each response's inline
// script, marked with that response's nonce, and same-origin files such as the
// nostr-tools module), plus Cloudflare's Web Analytics beacon, which
// Cloudflare adds to the page in production. Only the Divine sites the embed
// bridge answers may frame them.

const PUBKEY = 'ab'.repeat(32)
const VERIFY_PATH = `/verify/github/synthetic-user/abc123?pubkey=${PUBKEY}`

const FRAME_ANCESTORS = "frame-ancestors 'self' https://divine.video https://app.divine.video https://divine-mobile.pages.dev"
  + ' http://localhost:* https://localhost:* https://*.divine.video https://*.divine-mobile.pages.dev'

function expectedPolicy(nonce: string): string {
  return `script-src 'nonce-${nonce}' 'self' https://static.cloudflareinsights.com; object-src 'none'; base-uri 'none'; form-action 'none'; ${FRAME_ANCESTORS}`
}

function createEnv(): Bindings {
  const store = new Map<string, string>()
  store.set(cacheKey('github', 'synthetic-user', 'abc123', PUBKEY), JSON.stringify({ verified: true, checked_at: 1_700_000_000, type: 'verified' }))
  return {
    CACHE_KV: { get: async (key: string) => store.get(key) ?? null, put: async () => {} },
    RATE_LIMIT_KV: { get: async () => null, put: async () => {} },
  } as unknown as Bindings
}

async function get(path: string, accept: string): Promise<Response> {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch') }))
  return worker.fetch(new Request(`https://verifier.example${path}`, { headers: { Accept: accept } }), createEnv())
}

// The nonce the response's policy allows, read from its header.
function headerNonce(response: Response): string {
  const nonce = response.headers.get('Content-Security-Policy')?.match(/'nonce-([^']*)'/)?.[1]
  expect(nonce).toBeDefined()
  return nonce!
}

// Every <script> start tag in the page, scripts in markup and inside other scripts' strings alike.
function scriptTags(html: string): string[] {
  return html.match(/<script\b[^>]*>/gi) ?? []
}

afterEach(() => vi.unstubAllGlobals())

const HTML_PAGES: Array<[string, string]> = [
  ['the main page', '/'],
  ['a verification-link page', VERIFY_PATH],
]

describe('Content-Security-Policy on the HTML pages', () => {
  it.each(HTML_PAGES)('%s carries the policy, with its own nonce', async (_label, path) => {
    const response = await get(path, 'text/html')
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(response.headers.get('Content-Security-Policy')).toBe(expectedPolicy(headerNonce(response)))
  })

  it.each(HTML_PAGES)('%s is never stored, so a nonce is never served twice', async (_label, path) => {
    const response = await get(path, 'text/html')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it.each(HTML_PAGES)('%s gets a fresh nonce of at least 128 random bits each time', async (_label, path) => {
    const nonces = await Promise.all(Array.from({ length: 5 }, async () => headerNonce(await get(path, 'text/html'))))
    expect(new Set(nonces).size).toBe(nonces.length)
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
      expect(atob(nonce).length).toBeGreaterThanOrEqual(16)
    }
  })

  it.each(HTML_PAGES)('every script tag on %s carries the response nonce', async (_label, path) => {
    const response = await get(path, 'text/html')
    const nonce = headerNonce(response)
    const tags = scriptTags(await response.text())
    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) expect(tag).toBe(`<script nonce="${nonce}">`)
  })

  // The policy turns each embed-bridge suffix into an https://*<suffix> source, which is
  // a valid wildcard only when the suffix starts with a dot; browsers drop one that doesn't.
  it('every embed-bridge suffix starts with a dot, so its frame-ancestors wildcard is valid', () => {
    expect(ALLOWED_PARENT_SUFFIXES.length).toBeGreaterThan(0)
    for (const suffix of ALLOWED_PARENT_SUFFIXES) expect(suffix).toMatch(/^(\.[a-z0-9-]+)+$/)
  })

  it.each([
    ['the service description', '/', 'application/json'],
    ['a verification result asked for as JSON', VERIFY_PATH, 'application/json'],
    ['a verification result asked for with ?format=json', `${VERIFY_PATH}&format=json`, 'text/html'],
    ['the platform list', '/platforms', 'application/json'],
  ])('%s, a JSON answer, carries no page policy', async (_label, path, accept) => {
    const response = await get(path, accept)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    expect(response.headers.get('Content-Security-Policy')).toBeNull()
  })
})
