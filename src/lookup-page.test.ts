import { describe, expect, it } from 'vitest'
import worker from './index'

const ORIGIN = 'https://verifier.divine.video'

async function get(path: string, env = {}): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`), env as never)
}

// A nonce differs on every response, so compare policies without it.
const withoutNonce = (policy: string | null) => (policy ?? '').replace(/'nonce-[^']+'/g, "'nonce-X'")

// The platforms the lookup always checks, as the page's claim filter lists them.
const FILTER = "['github','twitter','mastodon','telegram','bluesky','discord'"

describe('GET /lookup', () => {
  it('answers 200 HTML with the lookup form', async () => {
    const res = await get('/lookup')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('<h1>Look up someone<span class="punct">.</span></h1>')
    expect(html).toContain('<input id="lookup-input" type="text" class="lookup-input" placeholder="example@divine.video or npub1...">')
    expect(html).toContain('<button id="lookup-btn" class="lookup-btn" type="button">Check</button>')
    expect(html).toContain('<div id="lookup-status" class="lookup-status"></div>')
    expect(html).toContain('<div id="lookup-results"></div>')
    expect(html).toContain('href="/"')
    expect(html).toContain('href="/docs"')
    expect(html).toContain("const API = 'https://verifier.divine.video';")
  })

  it('sets the same content-security policy and caching as the main page', async () => {
    const lookup = await get('/lookup')
    const home = await get('/')
    expect(lookup.headers.get('content-security-policy')).toBeTruthy()
    expect(withoutNonce(lookup.headers.get('content-security-policy')))
      .toBe(withoutNonce(home.headers.get('content-security-policy')))
    expect(lookup.headers.get('cache-control')).toBe(home.headers.get('cache-control'))
  })

  it('needs no signer: no embed bridge, Divine login or nostr-tools', async () => {
    const html = await (await get('/lookup')).text()
    for (const text of ['installDivineEmbedBridge', 'KEYCAST_', 'NOSTR_TOOLS_URL']) expect(html).not.toContain(text)
  })

  it('checks the always-on platforms and TikTok by default', async () => {
    expect(await (await get('/lookup')).text()).toContain(`${FILTER},'tiktok'].includes(c.platform)`)
  })

  it('checks YouTube claims when YouTube is configured', async () => {
    expect(await (await get('/lookup', { YOUTUBE_API_KEY: 'k' })).text()).toContain(`${FILTER},'youtube','tiktok'].includes(c.platform)`)
  })

  it('is the same page with or without the TikTok review cookie', async () => {
    const env = { TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's', OAUTH_REDIRECT_BASE: 'https://verifier.divine.video' }
    const plain = await get('/lookup', env)
    const withCookie = await worker.fetch(new Request(`${ORIGIN}/lookup`, { headers: { Cookie: 'tiktok_oauth_review=1' } }), env as never)
    const body = async (r: Response) => (await r.text()).replace(/nonce="[^"]+"/g, 'nonce="X"')
    expect(await body(withCookie)).toBe(await body(plain))
    expect(withCookie.headers.get('vary') ?? '').not.toMatch(/cookie/i)
  })
})
