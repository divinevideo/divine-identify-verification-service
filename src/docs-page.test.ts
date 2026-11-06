import { describe, expect, it } from 'vitest'
import worker from './index'

const ORIGIN = 'https://verifier.divine.video'

async function get(path: string, env = {}): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`), env as never)
}

// The ids of the API sections that moved from the landing page to /docs.
const MOVED_IDS = [
  'api-about', 'platforms-api', 'single-verify', 'batch-verify', 'get-verify',
  'nip05', 'oauth', 'other', 'rate-limits',
]

// A nonce differs on every response, so compare policies without it.
const withoutNonce = (policy: string | null) => (policy ?? '').replace(/'nonce-[^']+'/g, "'nonce-X'")

describe('GET /docs', () => {
  it('answers 200 HTML with the /verified section', async () => {
    const res = await get('/docs')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('id="verified-api"')
    expect(html).toContain('GET /verified/')
    expect(html).toContain('unchecked')
    expect(html).toContain('proof-post')
  })

  it('carries the moved API sections', async () => {
    const html = await (await get('/docs')).text()
    for (const id of [...MOVED_IDS, 'verified-api']) expect(html).toContain(`<section id="${id}">`)
  })

  it('sets the same content-security policy as the landing page', async () => {
    const docs = await get('/docs')
    const home = await get('/')
    expect(docs.headers.get('content-security-policy')).toBeTruthy()
    expect(withoutNonce(docs.headers.get('content-security-policy')))
      .toBe(withoutNonce(home.headers.get('content-security-policy')))
    expect(docs.headers.get('cache-control')).toBe(home.headers.get('cache-control'))
  })

  it('documents the old names, the limits and the error codes', async () => {
    const html = await (await get('/docs')).text()
    for (const text of ['identity_link', 'oauth', 'temporarily_unavailable', 'invalid_pubkey', 'invalid_request', 'not_found', 'rate_limited', 'proof_url']) {
      expect(html).toContain(text)
    }
    expect(html).toContain('<tr><td><code>/verified</code></td>')
  })
})

describe('landing page after the move', () => {
  it('no longer carries the API reference and links to /docs', async () => {
    const html = await (await get('/')).text()
    expect(html).not.toContain('id="api-about"')
    expect(html).not.toContain('API Documentation')
    expect(html).toContain('href="/docs"')
  })

  it('has none of the moved sections', async () => {
    const html = await (await get('/')).text()
    for (const id of MOVED_IDS) expect(html).not.toContain(`<section id="${id}">`)
  })

  it('has a script that references no element id that moved', async () => {
    const html = await (await get('/')).text()
    const start = html.indexOf('<script nonce=')
    expect(start).toBeGreaterThan(-1)
    const script = html.slice(start, html.indexOf('</script>', start))
    for (const id of [...MOVED_IDS, 'verified-api']) {
      expect(script, id).not.toMatch(new RegExp(`getElementById\\(\\s*['"]${id}['"]`))
      // A selector or anchor such as '#oauth', but not '#oauth-status' or the word 'oauth'.
      expect(script, id).not.toMatch(new RegExp(`#${id}(?![\\w-])`))
    }
  })
})
