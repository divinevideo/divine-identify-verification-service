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

describe('main page after the move', () => {
  const LOOKUP_IDS = ['check', 'lookup-input', 'lookup-btn', 'lookup-status', 'lookup-results']
  it('has no lookup section or hero button', async () => {
    const html = await (await get('/')).text()
    for (const id of LOOKUP_IDS) expect(html, id).not.toContain(`id="${id}"`)
    expect(html).not.toContain('href="#check"')
    expect(html).not.toContain('class="btn btn-outline">Look up someone</a>')
  })
  it('links to /lookup from the top bar and beside the API link', async () => {
    const html = await (await get('/')).text()
    expect(html).toContain('<a class="nav-link" href="/lookup">Look up</a>')
    const apiLink = html.slice(html.indexOf('<section id="api-link">'), html.indexOf('</section>', html.indexOf('<section id="api-link">')))
    expect(apiLink).toContain('href="/lookup"')
    expect(apiLink).toContain('href="/docs"')
  })
  it('has a script that reaches for no lookup element and carries no lookup code', async () => {
    const html = await (await get('/')).text()
    const script = html.slice(html.indexOf('<script nonce='), html.indexOf('</script>'))
    for (const id of LOOKUP_IDS) expect(script, id).not.toMatch(new RegExp(`getElementById\\(\\s*['"]${id}['"]`))
    for (const name of ['doLookup', 'showStatus', 'renderResults', 'fetchEventByKind', 'fetchIdentityEvent', 'fetchProfileLegacy', 'VERIFY_BATCH_SIZE']) expect(script, name).not.toContain(name)
  })
})

describe('old links to sections that moved', () => {
  const MOVED_TO_DOCS = ['api-about', 'platforms-api', 'single-verify', 'batch-verify', 'get-verify', 'nip05', 'oauth', 'other', 'rate-limits']

  async function forwarder() {
    const html = await (await get('/')).text()
    const start = html.indexOf('(function forwardMovedSectionLinks()')
    const end = html.indexOf('// Install a postMessage-based window.nostr', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return (url: string) => {
      const u = new URL(url)
      const replaced: string[] = []
      const assigned: string[] = []
      const location = { hash: u.hash, search: u.search, replace: (to: string) => { replaced.push(to) }, set href(to: string) { assigned.push(to) } }
      new Function('window', html.slice(start, end))({ location })
      return { replaced, assigned }
    }
  }

  it('sends /#check to /lookup without leaving /#check in the history', async () => {
    expect((await forwarder())(`${ORIGIN}/#check`)).toEqual({ replaced: ['/lookup'], assigned: [] })
  })

  it.each(MOVED_TO_DOCS)('sends /#%s to the same section of /docs', async (anchor) => {
    expect((await forwarder())(`${ORIGIN}/#${anchor}`)).toEqual({ replaced: [`/docs#${anchor}`], assigned: [] })
  })

  it.each([
    ['a sign-in coming back', '/?code=abc&state=def#check'],
    ['a moved docs section with a query', '/?code=abc&state=def#oauth'],
    ['another section', '/#verify-here'],
    ['a longer hash', '/#check-it'],
    ['a longer docs hash', '/#oauth-extra'],
    ['other letter case', '/#Check'],
    ['no hash', '/'],
  ])('leaves %s alone', async (_label, path) => {
    expect((await forwarder())(`${ORIGIN}${path}`)).toEqual({ replaced: [], assigned: [] })
  })

  it('runs first, before the embed bridge and the sign-in code', async () => {
    const html = await (await get('/')).text()
    const open = html.indexOf('>', html.indexOf('<script nonce=')) + 1
    const at = html.indexOf('(function forwardMovedSectionLinks()')
    expect(html.slice(open, at).replace(/\/\/.*$/gm, '').trim()).toBe('')
    expect(at).toBeLessThan(html.indexOf('installDivineEmbedBridge'))
  })

  it('is not on /lookup', async () => {
    expect(await (await get('/lookup')).text()).not.toContain('forwardMovedSectionLinks')
  })
})
