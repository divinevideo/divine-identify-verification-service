import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import type { Bindings } from './types'
import { cacheKey } from './utils/cache'

// Other tests run parts of each page's script; this one compiles all of it, so
// a syntax error anywhere in a page's script fails the suite instead of only
// the live page. The worker builds the scripts per request, so it checks the
// pages as served, with the optional platforms off and on.

const PUBKEY = 'ab'.repeat(32)

// Every inline <script> in the page: its attributes and its body.
function inlineScripts(html: string): Array<{ attributes: string, body: string }> {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes]) => !/\ssrc\s*=/i.test(attributes))
    .map(([, attributes, body]) => ({ attributes, body }))
}

// node:vm parses source the way a <script> does; new Function would parse it as a
// function body and accept a top-level return. The worker's tsconfig has no Node
// types, so the module name goes in as a plain string.
const { Script } = await import('node:vm' as string)

// Compiles a classic script without running it; throws a SyntaxError if it can't parse.
function compile(source: string) {
  new Script(source)
}

function createEnv(extra: Partial<Bindings> = {}): Bindings {
  const store = new Map<string, string>()
  store.set(cacheKey('github', 'synthetic-user', 'abc123', PUBKEY), JSON.stringify({ verified: true, checked_at: 1_700_000_000, type: 'verified' }))
  store.set(cacheKey('mastodon', 'social.example/@synthetic', '123', PUBKEY), JSON.stringify({ verified: false, checked_at: 1_700_000_000, type: 'failed', error: 'Not found' }))
  return {
    CACHE_KV: { get: async (key: string) => store.get(key) ?? null, put: async () => {} },
    RATE_LIMIT_KV: { get: async () => null, put: async () => {} },
    ...extra,
  } as unknown as Bindings
}

const ALL_PLATFORMS_ON: Partial<Bindings> = {
  YOUTUBE_API_KEY: 'synthetic-key',
  TWITTER_CLIENT_ID: 'synthetic-id',
  TWITTER_CLIENT_SECRET: 'synthetic-secret',
  TIKTOK_CLIENT_KEY: 'synthetic-key',
  TIKTOK_CLIENT_SECRET: 'synthetic-secret',
  TIKTOK_OAUTH_ENABLED: 'true',
  OAUTH_REDIRECT_BASE: 'https://verifier.example',
}

async function served(path: string, env: Bindings): Promise<string> {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch') }))
  const response = await worker.fetch(new Request(`https://verifier.example${path}`, { headers: { Accept: 'text/html' } }), env)
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toContain('text/html')
  return response.text()
}

afterEach(() => vi.unstubAllGlobals())

const PAGES: Array<[string, string, Partial<Bindings>]> = [
  ['the main page', '/', {}],
  ['the main page with every optional platform on', '/', ALL_PLATFORMS_ON],
  ['a verified link page', `/verify/github/synthetic-user/abc123?pubkey=${PUBKEY}`, {}],
  ['a failed Mastodon link page', `/verify/mastodon/social.example%2F%40synthetic/123?pubkey=${PUBKEY}`, {}],
]

describe('page scripts parse', () => {
  it.each(PAGES)('every inline script on %s compiles', async (_label, path, extra) => {
    const scripts = inlineScripts(await served(path, createEnv(extra)))
    expect(scripts.length).toBeGreaterThan(0)
    for (const { attributes, body } of scripts) {
      // A module script would need a module parser; the pages have none today.
      expect(attributes).not.toMatch(/\stype\s*=/i)
      expect(() => compile(body)).not.toThrow()
    }
  })

  it('the check catches a syntax error anywhere in a script', () => {
    expect(() => compile('const a = 1;\nfunction ok() { return a }\nconst b = {;')).toThrow(SyntaxError)
  })

  it('the check catches a return outside any function, which a <script> rejects', () => {
    expect(() => compile('function ok() { return 1 }\nreturn')).toThrow(SyntaxError)
  })
})
