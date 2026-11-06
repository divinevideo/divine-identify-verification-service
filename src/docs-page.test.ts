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
    // Read within the section: oauth, invalid_request and temporarily_unavailable
    // also appear in the other sections, so the whole page would pass without it.
    const start = html.indexOf('<section id="verified-api">')
    expect(start).toBeGreaterThan(-1)
    const section = html.slice(start, html.indexOf('</section>', start))
    for (const text of [
      '<code>x</code>', '<code>proof-post</code>', '<code>oauth</code>', '<code>identity_link</code>',
      '<code>proof_url</code>', '<code>unchecked</code>', 'at most 10 candidates', 'the limit of 20 links checked per list',
      '<tr><td><code>invalid_pubkey</code></td><td>400</td>',
      '<tr><td><code>invalid_request</code></td><td>400</td>',
      '<tr><td><code>not_found</code></td><td>404</td>',
      '<tr><td><code>rate_limited</code></td><td>429</td>',
      '<tr><td><code>temporarily_unavailable</code></td><td>503</td>',
    ]) {
      expect(section, text).toContain(text)
    }
    expect(html).toContain('<tr><td><code>/verified</code></td>')
  })

  it('says an unknown platform is a 400 and one only the old host listed is a 404', async () => {
    const html = await (await get('/docs')).text()
    expect(html).toContain('<tr><td><code>invalid_request</code></td><td>400</td><td><code>platform</code> or <code>identity</code> is missing, or <code>platform</code> is not a platform name either host knows</td></tr>')
    expect(html).toContain("the platform is one verify.divine.video listed that this verifier doesn't check (<code>instagram</code>, <code>snapchat</code>)</td></tr>")
  })

  it('says how letter case affects finding a proof-post owner', async () => {
    const html = await (await get('/docs')).text()
    expect(html).toContain('<code>?identity=Alice</code> finds a list tagged <code>Alice</code> or <code>alice</code>, but <code>?identity=alice</code> does not find <code>Alice</code>')
    expect(html).toContain('Owners who linked by signing in are found in any letter case. YouTube channel IDs (<code>UC…</code>) are case-sensitive either way.')
  })

  it('says a check limit can leave a link unchecked', async () => {
    const html = await (await get('/docs')).text()
    expect(html).toContain('a platform outage or time limit, the per-person or per-platform check limit, or the limit of 20 links checked per list')
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
