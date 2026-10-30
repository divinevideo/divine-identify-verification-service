import { describe, expect, it, vi } from 'vitest'
import worker from './index'

describe('verifier cors', () => {
  it('uses wildcard cors on preflight and reflects requested headers', async () => {
    const response = await worker.fetch(new Request('https://verifier.divine.video/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.divine.video',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Content-Type,Authorization,sentry-trace,x-client-version',
      },
    }), {} as never)

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,PUT,DELETE,OPTIONS')
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type,Authorization,sentry-trace,x-client-version')
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400')
  })

  it('keeps public routes open for arbitrary origins', async () => {
    const response = await worker.fetch(new Request('https://verifier.divine.video/health', {
      headers: {
        Origin: 'https://evil.example',
      },
    }), {} as never)

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})

describe('verifier health', () => {
  const healthWith = async (env: Record<string, unknown>) => {
    const response = await worker.fetch(new Request('https://verifier.divine.video/health'), env as never)
    expect(response.status).toBe(200)
    return (await response.json() as { signin_confirmation?: string }).signin_confirmation
  }

  it('reports whether unconfirmed sign-ins count, as the service reads its setting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await healthWith({})).toBe('optional')
      expect(await healthWith({ SIGNIN_CONFIRMATION: 'optional' })).toBe('optional')
      expect(await healthWith({ SIGNIN_CONFIRMATION: ' Required ' })).toBe('required')
      expect(await healthWith({ SIGNIN_CONFIRMATION: 'requird' })).toBe('required')
    } finally {
      warn.mockRestore()
    }
  })

  it('documents the mode it reports on the page', async () => {
    const response = await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)
    const html = await response.text()
    expect(html).toContain('<code>signin_confirmation</code>')
  })
})

describe('verifier browser-signer login', () => {
  it('signs the login event for the verifier\'s own login endpoint, not login.divine.video', async () => {
    const response = await worker.fetch(
      new Request('https://verifier.divine.video/'),
      {} as never,
    )
    const html = await response.text()
    const start = html.indexOf('async function connectBrowserSigner()')
    expect(start).toBeGreaterThan(-1)
    const body = html.slice(start, html.indexOf('async function startKeycastLogin()', start))
    // NIP-98: the u tag must equal the URL the event is sent to, which is the
    // verifier's own endpoint, not login.divine.video's.
    expect(body).toContain("const loginUrl = API + '/auth/nostr/login';")
    expect(body).not.toContain('/api/auth/login')
    // The URL that is signed and the URL that is requested must be the same value.
    expect(body).toContain("['u', loginUrl]")
    expect(body).toContain('fetch(loginUrl')
  })
})

describe('verifier footer', () => {
  it('exposes visible privacy and terms links (required for TikTok review)', async () => {
    const response = await worker.fetch(
      new Request('https://verifier.divine.video/'),
      {} as never,
    )
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('https://divine.video/privacy')
    expect(html).toContain('https://divine.video/terms')
  })
})

async function homeHtml(
  url = 'https://verifier.divine.video/',
  env = {},
  headers: HeadersInit = {},
): Promise<string> {
  const response = await worker.fetch(
    new Request(url, { headers }),
    env as never,
  )
  expect(response.status).toBe(200)
  return response.text()
}

function sliceSelect(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`)
  expect(start).toBeGreaterThan(-1)
  const end = html.indexOf('</select>', start)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

// Where each platform pill links to, by platform.
function pillTargets(html: string): Record<string, string> {
  const pills = [...html.matchAll(/<a class="platform-pill" href="#([a-z-]+)" data-platform="([a-z]+)"/g)]
  return Object.fromEntries(pills.map(([, target, platform]) => [platform, target]))
}

function platformTableRow(html: string, code: string): string {
  const marker = `<td><code>${code}</code></td>`
  const idx = html.indexOf(marker)
  expect(idx).toBeGreaterThan(-1)
  return html.slice(html.lastIndexOf('<tr>', idx), html.indexOf('</tr>', idx))
}

function oauthDocsSection(html: string): string {
  const start = html.indexOf('<section id="oauth">')
  expect(start).toBeGreaterThan(-1)
  return html.slice(start, html.indexOf('</section>', start))
}

// Twitter sign-in needs all three: the start step uses the client ID and
// redirect base, and the callback's token exchange also needs the secret.
const twitterOAuthConfig = {
  TWITTER_CLIENT_ID: 'test-client-id',
  TWITTER_CLIENT_SECRET: 'test-client-secret',
  OAUTH_REDIRECT_BASE: 'https://verifier.divine.video',
}

// YouTube shows on the page with its API key; its sign-in also needs the
// Google client ID and secret, and the redirect base.
const youtubeSignInConfig = {
  YOUTUBE_API_KEY: 'test-api-key',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  OAUTH_REDIRECT_BASE: 'https://verifier.divine.video',
}

describe('verifier youtube sign-in gating', () => {
  const youtubeKeyOnly = { YOUTUBE_API_KEY: 'test-api-key' }

  it('offers YouTube only as a post link when just its API key is set', async () => {
    const html = await homeHtml('https://verifier.divine.video/', youtubeKeyOnly)
    expect(sliceSelect(html, 'oauth-platform-select')).not.toContain('value="youtube"')
    expect(sliceSelect(html, 'proof-platform-select')).toContain('value="youtube"')
    expect(pillTargets(html).youtube).toBe('link-with-post')
    expect(platformTableRow(html, 'youtube')).toContain('<td>No</td>')
    expect(oauthDocsSection(html)).not.toContain('/auth/youtube/')
    expect(html).toContain('For Bluesky, sign in to it from this page. For Twitter, GitHub, Mastodon, Telegram, Discord, YouTube, and TikTok, post your npub there, then paste the link to that post.')
  })

  it('offers YouTube sign-in when it is fully configured', async () => {
    const html = await homeHtml('https://verifier.divine.video/', youtubeSignInConfig)
    expect(sliceSelect(html, 'oauth-platform-select')).toContain('value="youtube"')
    expect(pillTargets(html).youtube).toBe('quick-connect')
    expect(platformTableRow(html, 'youtube')).toContain('<td>Yes</td>')
    expect(oauthDocsSection(html)).toContain('POST https://verifier.divine.video/auth/youtube/start  {"pubkey":"hex64","start_check":"…"}')
    expect(html).toContain('For Bluesky and YouTube, sign in to it from this page. For Twitter, GitHub, Mastodon, Telegram, Discord, and TikTok, post your npub there, then paste the link to that post.')
  })

  it.each(Object.keys(youtubeSignInConfig).filter(key => key !== 'YOUTUBE_API_KEY'))('keeps YouTube sign-in hidden without %s', async (missing) => {
    const partial = Object.fromEntries(Object.entries(youtubeSignInConfig).filter(([key]) => key !== missing))
    const html = await homeHtml('https://verifier.divine.video/', partial)
    expect(sliceSelect(html, 'oauth-platform-select')).not.toContain('value="youtube"')
    expect(pillTargets(html).youtube).toBe('link-with-post')
  })

  // /platforms leaves YouTube out without its API key, so the page does too.
  it('leaves YouTube off the page without its API key, even with sign-in configured', async () => {
    const { YOUTUBE_API_KEY: _key, ...googleOnly } = youtubeSignInConfig
    const html = await homeHtml('https://verifier.divine.video/', googleOnly)
    expect(html).not.toContain('value="youtube"')
    expect(pillTargets(html).youtube).toBeUndefined()
  })
})

describe('verifier tiktok oauth gating', () => {
  const tiktokOAuthConfig = {
    TIKTOK_CLIENT_KEY: 'test-client-key',
    TIKTOK_CLIENT_SECRET: 'test-client-secret',
    OAUTH_REDIRECT_BASE: 'https://verifier.divine.video',
  }

  it('hides TikTok from the OAuth picker while its OAuth app is unapproved', async () => {
    const oauthSelect = sliceSelect(await homeHtml(), 'oauth-platform-select')
    expect(oauthSelect).not.toContain('value="tiktok"')
  })

  it('keeps TikTok in the proof-post picker', async () => {
    const proofSelect = sliceSelect(await homeHtml(), 'proof-platform-select')
    expect(proofSelect).toContain('value="tiktok"')
  })

  it('exposes TikTok OAuth for the app-review URL', async () => {
    const oauthSelect = sliceSelect(
      await homeHtml('https://verifier.divine.video/?tiktok_oauth_review=1', tiktokOAuthConfig),
      'oauth-platform-select',
    )
    expect(oauthSelect).toContain('value="tiktok"')
  })

  it('exposes TikTok OAuth when the production rollout flag is enabled', async () => {
    const oauthSelect = sliceSelect(
      await homeHtml('https://verifier.divine.video/', {
        ...tiktokOAuthConfig,
        TIKTOK_OAUTH_ENABLED: 'true',
      }),
      'oauth-platform-select',
    )
    expect(oauthSelect).toContain('value="tiktok"')
  })

  it('keeps TikTok hidden when rollout is enabled without complete OAuth configuration', async () => {
    const oauthSelect = sliceSelect(
      await homeHtml('https://verifier.divine.video/', { TIKTOK_OAUTH_ENABLED: 'true' }),
      'oauth-platform-select',
    )
    expect(oauthSelect).not.toContain('value="tiktok"')
  })

  it('preserves app-review access across redirect callbacks with a cookie', async () => {
    const response = await worker.fetch(
      new Request('https://verifier.divine.video/?tiktok_oauth_review=1'),
      tiktokOAuthConfig as never,
    )
    const setCookie = response.headers.get('set-cookie')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Max-Age=3600')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Secure')
    const cookie = setCookie?.split(';', 1)[0]
    expect(cookie).toBe('tiktok_oauth_review=1')

    const html = await homeHtml(
      'https://verifier.divine.video/',
      tiktokOAuthConfig,
      { Cookie: cookie as string },
    )
    expect(sliceSelect(html, 'oauth-platform-select')).toContain('value="tiktok"')
  })

  it('does not set a reviewer cookie on ordinary landing requests', async () => {
    const response = await worker.fetch(
      new Request('https://verifier.divine.video/'),
      {} as never,
    )
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toBe('Cookie')
  })

  it('tells the browser not to send the page address to other sites', async () => {
    const response = await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('does not advertise TikTok in the no-posting sign-in instructions', async () => {
    const html = await homeHtml('https://verifier.divine.video/', twitterOAuthConfig)
    const marker = 'sign in to it from this page'
    const idx = html.indexOf(marker)
    expect(idx).toBeGreaterThan(-1)
    const sentence = html.slice(html.lastIndexOf('>', idx) + 1, idx + marker.length)
    expect(sentence).toContain('Twitter')
    expect(sentence).not.toContain('TikTok')
  })

  it('does not advertise TikTok OAuth in the supported-platform table', async () => {
    const html = await homeHtml()
    const marker = '<code>tiktok</code>'
    const idx = html.indexOf(marker)
    expect(idx).toBeGreaterThan(-1)
    const row = html.slice(html.lastIndexOf('<tr>', idx), html.indexOf('</tr>', idx))
    expect(row).toContain('<td>No</td>')
    expect(row).not.toContain('<td>Yes</td>')
  })

  it('renders a grammatical Quick Connect list', async () => {
    const html = await homeHtml('https://verifier.divine.video/', { ...twitterOAuthConfig, ...youtubeSignInConfig })
    expect(html).toContain('For Twitter/X, Bluesky, and YouTube, sign in to it from this page.')
  })

  it('documents recognition of existing TikTok OAuth verifications', async () => {
    expect(await homeHtml()).toContain('Existing TikTok OAuth verifications remain recognized.')
  })

  it('documents the platforms endpoint without a TikTok unsupported caveat', async () => {
    const html = await homeHtml()
    expect(html).not.toContain('TikTok reports unsupported')
    expect(html).toContain('<p>List platforms currently available to clients. Twitter/X, Bluesky, YouTube (when listed), and TikTok each include an <code>oauth</code> field')
  })
})

describe('verifier twitter oauth gating', () => {
  it('hides Twitter from the sign-in picker when Twitter sign-in is not configured', async () => {
    const oauthSelect = sliceSelect(await homeHtml(), 'oauth-platform-select')
    expect(oauthSelect).not.toContain('value="twitter"')
    expect(oauthSelect).toContain('value="bluesky"')
  })

  it('keeps Twitter in the proof-post picker', async () => {
    const proofSelect = sliceSelect(await homeHtml(), 'proof-platform-select')
    expect(proofSelect).toContain('value="twitter"')
  })

  it('offers Twitter sign-in when it is fully configured', async () => {
    const oauthSelect = sliceSelect(await homeHtml('https://verifier.divine.video/', twitterOAuthConfig), 'oauth-platform-select')
    expect(oauthSelect).toContain('value="twitter"')
  })

  it.each(Object.keys(twitterOAuthConfig))('keeps Twitter sign-in hidden without %s', async (missing) => {
    const partial = Object.fromEntries(Object.entries(twitterOAuthConfig).filter(([key]) => key !== missing))
    const oauthSelect = sliceSelect(await homeHtml('https://verifier.divine.video/', partial), 'oauth-platform-select')
    expect(oauthSelect).not.toContain('value="twitter"')
  })

  it('leaves TikTok out of the post-link list once its sign-in is enabled', async () => {
    const html = await homeHtml('https://verifier.divine.video/', {
      TIKTOK_CLIENT_KEY: 'test-client-key',
      TIKTOK_CLIENT_SECRET: 'test-client-secret',
      OAUTH_REDIRECT_BASE: 'https://verifier.divine.video',
      TIKTOK_OAUTH_ENABLED: 'true',
    })
    expect(html).toContain('For Twitter, GitHub, Mastodon, Telegram, and Discord, post your npub there')
  })

  it('tells people in the sign-in card which platforms use a post link instead', async () => {
    const card = (html: string) => {
      const start = html.indexOf('id="quick-connect"')
      expect(start).toBeGreaterThan(-1)
      const end = html.indexOf('id="oauth-start-btn"', start)
      expect(end).toBeGreaterThan(start)
      return html.slice(start, end)
    }
    expect(card(await homeHtml())).toContain('For Twitter, GitHub, Mastodon, Telegram, Discord, and TikTok, <a href="#link-with-post">link with a post instead</a>.')
    expect(card(await homeHtml('https://verifier.divine.video/', twitterOAuthConfig))).toContain('For GitHub, Mastodon, Telegram, Discord, and TikTok, <a href="#link-with-post">link with a post instead</a>.')
  })

  it('reads the post-link hint before the picker and ties it to the picker for screen readers', async () => {
    const html = await homeHtml()
    const hint = html.indexOf('id="oauth-platform-help"')
    expect(hint).toBeGreaterThan(-1)
    expect(hint).toBeLessThan(html.indexOf('<label for="oauth-platform-select"'))
    expect(html).toContain('<select id="oauth-platform-select" class="field-select" aria-describedby="oauth-platform-help">')
  })

  it('marks Twitter sign-in as unavailable in the supported-platform table', async () => {
    expect(platformTableRow(await homeHtml(), 'twitter')).toContain('<td>No</td>')
    expect(platformTableRow(await homeHtml('https://verifier.divine.video/', twitterOAuthConfig), 'twitter')).toContain('<td>Yes</td>')
  })

  it('leaves Twitter out of the sign-in API docs when it is not configured', async () => {
    const html = await homeHtml()
    const docs = oauthDocsSection(html)
    expect(docs).toContain('<h2>OAuth Verification (Bluesky)</h2>')
    expect(docs).not.toContain('/auth/twitter/')
    expect(docs).toContain('/auth/bluesky/status?pubkey=hex64&amp;identity=example.bsky.social')
    expect(docs).toContain('before cached results and proof posts, for Bluesky.')
    expect(html).toContain('<li><strong>OAuth login</strong> (Bluesky) &mdash;')
  })

  it('documents Twitter sign-in when it is configured', async () => {
    const docs = oauthDocsSection(await homeHtml('https://verifier.divine.video/', twitterOAuthConfig))
    expect(docs).toContain('<h2>OAuth Verification (Twitter, Bluesky)</h2>')
    expect(docs).toContain('POST https://verifier.divine.video/auth/twitter/start  {"pubkey":"hex64","start_check":"…"}')
  })

  it('documents the sign-in start as a POST with a start check, and the confirm step', async () => {
    const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), { OAUTH_REDIRECT_BASE: 'https://verifier.divine.video', TWITTER_CLIENT_ID: 'x', TWITTER_CLIENT_SECRET: 'y' } as never)).text()
    expect(html).toContain('POST https://verifier.divine.video/auth/bluesky/start')
    expect(html).toContain('POST https://verifier.divine.video/auth/confirm')
    expect(html).not.toContain('GET https://verifier.divine.video/auth/bluesky/start?')
  })

  it('shows the full sign-in start and confirm requests, with their answers and error codes, as the README does', async () => {
    const docs = oauthDocsSection(await homeHtml())
    expect(docs).toContain(`POST https://verifier.divine.video/auth/bluesky/start
Content-Type: application/json

{"pubkey":"&lt;64 hex&gt;","return_url":"https://verifier.divine.video/?signin=&lt;id&gt;","handle":"example.bsky.social","start_check":"&lt;base64url(sha256('divine-signin-start:' + secret))&gt;"}</pre>`)
    expect(docs).toContain('<p>The answer is <code>{"url":"https://…"}</code>, the provider page to open.</p>')
    expect(docs).toContain(`<pre>POST https://verifier.divine.video/auth/confirm
Content-Type: application/json

{"code":"&lt;code&gt;","start_secret":"&lt;secret&gt;","event":{…signed kind 10011…}}</pre>`)
    // The answer has no spaces, so it may break anywhere to fit a phone screen.
    expect(docs).toContain('<p>The answer is <code style="overflow-wrap:anywhere;">{"linked":true,"platform":"bluesky","identity":"example.bsky.social"}</code>. The client then publishes the same event to relays. Errors carry a <code>code</code>:</p>')
    expect(docs).toContain(`<ul>
        <li><code>invalid_request</code> (400: a malformed <code>code</code> or <code>start_secret</code>);</li>
        <li><code>signin_not_found</code> (expired or not visible yet; retry briefly);</li>
        <li><code>signin_used</code>;</li>
        <li><code>signin_wrong_account</code>;</li>
        <li><code>signin_not_yours</code>;</li>
        <li><code>signin_claim_mismatch</code>;</li>
        <li><code>invalid_event</code>.</li>
      </ul>`)
  })

  it('says how the sign-in returns its code, where the code goes, and when a sign-in counts', async () => {
    const docs = oauthDocsSection(await homeHtml())
    expect(docs).toContain("The sign-in returns to <code>return_url</code> (the verifier page, or the Divine app's return address) with a one-time code after the <code>#</code>.")
    expect(docs).toContain('The link counts once the account owner sends that code, the start secret and their signed linked-accounts list to <code>/auth/confirm</code>.')
    expect(docs).toContain('A sign-in counts only after you confirm it by publishing; a confirmed Bluesky sign-in stays verified for 30 days or until it is unlinked, as long as the handle still points to the same account.')
  })

  it('documents YouTube and TikTok sign-in starts as POSTs with a start check when they are on', async () => {
    const docs = oauthDocsSection(await homeHtml('https://verifier.divine.video/', { ...twitterOAuthConfig, ...youtubeSignInConfig, TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's', TIKTOK_OAUTH_ENABLED: 'true' }))
    // The other platforms follow the full Bluesky example after a blank line.
    expect(docs).toContain(`secret))&gt;"}\n\nPOST https://verifier.divine.video/auth/twitter/start  {"pubkey":"hex64","start_check":"…"}\nPOST https://verifier.divine.video/auth/youtube/start`)
    expect(docs).toContain('POST https://verifier.divine.video/auth/youtube/start  {"pubkey":"hex64","start_check":"…"}')
    expect(docs).toContain('POST https://verifier.divine.video/auth/tiktok/start  {"pubkey":"hex64","start_check":"…"}')
    expect(docs).not.toContain('/start?pubkey=')
  })

  it('gives the hashing rule for the start check and the binding, as the README does', async () => {
    const docs = oauthDocsSection(await homeHtml())
    expect(docs).toContain(`"start_check":"&lt;base64url(sha256('divine-signin-start:' + secret))&gt;"`)
    expect(docs).toContain("The new claim's tag carries a fourth value, <code>base64url(sha256('divine-signin-confirm:' + code + ':' + start_check))</code>.")
    expect(docs).toContain('keeps a random start secret (32 random bytes written as 43 base64url characters), sends its hash as <code>start_check</code>')
    expect(docs).toContain('Both hashes in this flow (the start check and the binding) are SHA-256 over the UTF-8 text shown, meaning the 43-character strings and not the raw bytes, written as base64url without padding.')
  })
})

describe('the two ways to link an account', () => {
  const tiktokOAuthOn = {
    TIKTOK_CLIENT_KEY: 'test-client-key',
    TIKTOK_CLIENT_SECRET: 'test-client-secret',
    OAUTH_REDIRECT_BASE: 'https://verifier.divine.video',
    TIKTOK_OAUTH_ENABLED: 'true',
  }

  // Each card runs from its id to the next card's id, in page order.
  function between(html: string, from: string, to: string): string {
    const start = html.indexOf(from)
    const end = html.indexOf(to, start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return html.slice(start, end)
  }
  const postCard = (html: string) => between(html, 'id="link-with-post"', 'id="quick-connect"')
  const quickConnectCard = (html: string) => between(html, 'id="quick-connect"', 'id="publish-step"')
  const publishCard = (html: string) => between(html, 'id="publish-step"', '</section>')
  const howToGetVerified = (html: string) => between(html, '<section id="how-to-verify">', '</section>')

  it('sends each platform pill to the way it can be linked today', async () => {
    expect(pillTargets(await homeHtml())).toEqual({
      twitter: 'link-with-post',
      github: 'link-with-post',
      bluesky: 'quick-connect',
      mastodon: 'link-with-post',
      telegram: 'link-with-post',
      discord: 'link-with-post',
      tiktok: 'link-with-post',
    })
  })

  it('sends Twitter, TikTok and YouTube pills to Quick Connect once their sign-in is set up', async () => {
    const targets = pillTargets(await homeHtml('https://verifier.divine.video/', { ...twitterOAuthConfig, ...tiktokOAuthOn, ...youtubeSignInConfig }))
    expect(targets.twitter).toBe('quick-connect')
    expect(targets.tiktok).toBe('quick-connect')
    expect(targets.youtube).toBe('quick-connect')
    expect(targets.github).toBe('link-with-post')
  })

  it.each([
    ['by default', {}],
    ['with every sign-in set up', { ...twitterOAuthConfig, ...tiktokOAuthOn, ...youtubeSignInConfig }],
  ])('only picks a platform the target card offers (%s)', async (_label, env) => {
    const html = await homeHtml('https://verifier.divine.video/', env)
    const targets = Object.entries(pillTargets(html))
    expect(targets.length).toBeGreaterThan(0)
    for (const [platform, target] of targets) {
      const select = sliceSelect(html, target === 'quick-connect' ? 'oauth-platform-select' : 'proof-platform-select')
      expect(select).toContain(`value="${platform}"`)
    }
  })

  it('names the platform and the way to link it for screen readers', async () => {
    const html = await homeHtml()
    expect(html).toContain('<a class="platform-pill" href="#quick-connect" data-platform="bluesky" aria-label="Link Bluesky by signing in">')
    expect(html).toContain('<a class="platform-pill" href="#link-with-post" data-platform="twitter" aria-label="Link Twitter / X with a post">')
  })

  it('puts each picker in the card its pills link to', async () => {
    const html = await homeHtml()
    expect(postCard(html)).toContain('id="proof-platform-select"')
    expect(quickConnectCard(html)).toContain('id="oauth-platform-select"')
  })

  // The two choices sit under the Step 2 heading, so screen-reader heading
  // navigation reads them as part of that step.
  it('titles both choices one level below the Step 2 heading', async () => {
    const html = await homeHtml()
    expect(between(html, 'Link your account. Pick one.', 'id="link-with-post"')).toContain('</h3>')
    expect(postCard(html)).toContain('<h4>Link with a post</h4>')
    expect(quickConnectCard(html)).toContain('<h4>Sign in, no posting</h4>')
  })

  // Post first while sign-in covers only Bluesky (#83).
  it('shows linking with a post before Quick Connect', async () => {
    const html = await homeHtml()
    expect(html.indexOf('id="link-with-post"')).toBeLessThan(html.indexOf('id="quick-connect"'))
  })

  it('shows the post form open, not folded away', async () => {
    const html = await homeHtml()
    expect(html).not.toContain('id="advanced-proof"')
    expect(postCard(html)).not.toContain('<details')
    expect(postCard(html)).toContain('Works for every platform.')
  })

  it('gives Publish its own step after both ways to link', async () => {
    const html = await homeHtml()
    expect(postCard(html)).not.toContain('id="publish-kind0-btn"')
    expect(publishCard(html)).toContain('id="publish-kind0-btn"')
    expect(publishCard(html)).toContain('id="publish-status"')
    expect(publishCard(html)).toContain('Nothing shows on your profile until you publish.')
  })

  it('says publishing needs you to be signed in', async () => {
    expect(publishCard(await homeHtml())).toContain('Needs you to be signed in (Step 1).')
  })

  it.each([
    ['by default', {}, 'For Bluesky, sign in to it from this page. For Twitter, GitHub, Mastodon, Telegram, Discord, and TikTok, post your npub there, then paste the link to that post.'],
    ['with Twitter sign-in set up', twitterOAuthConfig, 'For Twitter/X and Bluesky, sign in to it from this page. For GitHub, Mastodon, Telegram, Discord, and TikTok, post your npub there, then paste the link to that post.'],
  ])('describes both ways to link, then Publish, in How to Get Verified (%s)', async (_label, env, linkStep) => {
    const section = howToGetVerified(await homeHtml('https://verifier.divine.video/', env))
    expect(section).toContain(linkStep)
    expect(section).toContain('Press Publish to add the link to your profile.')
    expect(section).not.toContain('advanced section')
  })
})

// Most people verifying have a Divine login, so Step 1 leads with it and
// offers a Nostr signer as the alternative (#83).
describe('signing in with a Divine login first', () => {
  function step1(html: string): string {
    const start = html.indexOf('<span class="step-pill">Step 1</span>')
    const end = html.indexOf('<span class="step-pill verify-step-gap">Step 2</span>', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return html.slice(start, end)
  }

  // The markup inside the div with this id, up to its matching </div>.
  function divBody(html: string, id: string): string {
    const open = html.indexOf(`<div id="${id}">`)
    expect(open).toBeGreaterThan(-1)
    const tags = /<div\b|<\/div>/g
    tags.lastIndex = open + 1
    let depth = 1
    for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
      depth += tag[0] === '</div>' ? -1 : 1
      if (depth === 0) return html.slice(open, tag.index)
    }
    throw new Error(`no closing </div> for ${id}`)
  }

  it('wraps Step 1\'s sign-in options so the Divine app can hide them once signed in', async () => {
    const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)).text()
    const options = divBody(html, 'step1-signin-options')
    expect(options).toContain('<p>Use the login you use for Divine. Already use a Nostr signer? Connect it instead.</p>')
    expect(options).toContain('id="connect-keycast-btn"')
    expect(options).toContain('id="connect-nostr-btn"')
    expect(options).toContain('id="verify-pubkey-input"')
    expect(options).not.toContain('id="signer-session-summary"')
  })

  it('wraps the remote signer options too, after the signed-in summary', async () => {
    const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)).text()
    const remote = divBody(html, 'step1-remote-signer-options')
    expect(remote).toContain('id="remote-signer-details"')
    expect(remote).toContain('</details>')
    expect(remote).not.toContain('id="signer-session-summary"')
    expect(remote).not.toContain('id="verify-login-status"')
    // In a browser the summary sits under the account box, above the remote signer options.
    const summary = html.indexOf('id="signer-session-summary"')
    expect(summary).toBeGreaterThan(html.indexOf('<div id="step1-signin-options">'))
    expect(summary).toBeLessThan(html.indexOf('<div id="step1-remote-signer-options">'))
  })

  it('leads Step 1 with the Divine login', async () => {
    const card = step1(await homeHtml())
    expect(card).toContain('<h3 style="margin-top:0;">Sign in with your Divine login</h3>')
    expect(card).toContain('<p>Use the login you use for Divine. Already use a Nostr signer? Connect it instead.</p>')
  })

  it('offers the Divine login first, as the main button, and a Nostr extension second', async () => {
    const card = step1(await homeHtml())
    const divine = card.indexOf('<button id="connect-keycast-btn" class="verify-btn verify-btn-primary" type="button">Sign in with Divine login</button>')
    const nostr = card.indexOf('<button id="connect-nostr-btn" class="verify-btn" type="button">Use a Nostr extension</button>')
    expect(divine).toBeGreaterThan(-1)
    expect(nostr).toBeGreaterThan(divine)
  })

  it('has no link in Step 1 that opens in a new tab', async () => {
    const card = step1(await homeHtml())
    // Any spelling of the attribute: quoted or not, any case, spaces around "=".
    expect(card).not.toMatch(/target\s*=\s*["']?_blank/i)
  })

  it('labels the account field for signing in', async () => {
    const card = step1(await homeHtml())
    expect(card).toContain('<label for="verify-pubkey-input" class="field-label">Your Divine account (filled in when you sign in)</label>')
    expect(card).toContain('<summary>Remote signer options: bunker and Nostr Connect</summary>')
  })

  it('Step 1 has no paste-your-account option: the account box is filled only by signing in', async () => {
    const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)).text()
    expect(html).not.toContain('Paste your Divine address or npub')
    expect(html).not.toContain('TODO(#113)')
    expect(html).toMatch(/<input id="verify-pubkey-input"[^>]*readonly/)
  })

  it('tells people to sign in in the Verify Here intro and How to Get Verified', async () => {
    const html = await homeHtml()
    expect(html).toContain('<p class="verify-lead">Sign in, link your account one of two ways, then publish.</p>')
    expect(html).toContain(`<h4>Sign in</h4>
          <p>Use your Divine login, or connect your Nostr signer, in <a href="#verify-here">Verify Here</a>. You need it to add the link to your profile.</p>`)
  })

  // The page's messages to the person name the Divine login first too, and
  // say "sign in" rather than "connect a signer".
  it('says "sign in" in its messages to the person', async () => {
    const html = await homeHtml()
    for (const old of [
      'Connect your Nostr signer', 'connect a signer', 'Connect a signer', 'connected signer', 'Requires a signer session',
      'Please sign in with Nostr first', 'A signer session is required to publish', 'signed-in signer key',
      "'Connected with login.divine.video.'", "'Reconnected login.divine.video signer session.'",
      "'Opening secure login.divine.video...'", "'Finishing login.divine.video session...'",
      "'Could not connect login.divine.video.'", "'Could not open login.divine.video.'",
      "'Signed in with your browser signer.'", "'Requesting signature from your browser signer...'",
      'session expired. Connect again.', "'Sign in first (Step 1), or paste your account.'", 'browser signer key',
      "throw new Error('Sign in first (Verify Here, Step 1), or paste your account there.');",
      "throw new Error('The account you typed does not match the account you signed in with.');",
    ]) expect(html).not.toContain(old)
    for (const now of [
      "throw new Error('The account in Step 1 does not match the account you signed in with.');",
      "throw new Error('You need to be signed in to publish. Sign in with your Divine login, or connect your Nostr signer, in Step 1.');",
      "container.textContent = 'Sign in first (Verify Here, Step 1) to see your linked accounts.';",
      "throw new Error('Sign in first (Verify Here, Step 1).');",
      '<p>View and remove your linked identity verifications. You need to be signed in (Verify Here, Step 1).</p>',
      "'Signed in with your Divine login.'", "'Signed in again with your Divine login.'",
      "'Opening your Divine login...'", "'Finishing your Divine login...'",
      "'Could not sign in with your Divine login.'", "'Could not open your Divine login.'",
      "if (source === 'keycast') return 'your Divine login';",
      "if (source === 'browser') return 'your Nostr extension';",
      "throw new Error('Your Divine login has expired. Sign in again.');",
    ]) expect(html).toContain(now)
  })
})

// Example accounts on the page must not belong to anyone, so they use the
// reserved name "example" (GitHub's own "octocat" is fine).
describe('example accounts on the page', () => {
  it.each([
    ['by default', {}],
    ['with every sign-in set up', { ...twitterOAuthConfig, ...youtubeSignInConfig, TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's', TIKTOK_OAUTH_ENABLED: 'true' }],
  ])('leaves none of the old sample names on the page (%s)', async (_label, env) => {
    const html = await homeHtml('https://verifier.divine.video/', env)
    expect(html).not.toMatch(/alice/i)
    expect(html).not.toMatch(/\bjack\b/i)
  })

  it('shows the reserved example names in the fields people fill in', async () => {
    const html = await homeHtml()
    expect(html).toContain('<input id="verify-pubkey-input" class="field-input" type="text" readonly placeholder="Filled in when you sign in">')
    expect(html).toContain('<input id="lookup-input" type="text" class="lookup-input" placeholder="example@divine.video or npub1...">')
    expect(html).toContain('<input id="oauth-bluesky-handle-input" class="field-input" type="text" placeholder="example.bsky.social">')
    expect(html).toContain("identityInput.placeholder = 'mastodon.social/@example';")
    expect(html).toContain("throw new Error('Enter your Bluesky handle (example: example.bsky.social).');")
    expect(html).toContain("identityInput.placeholder = 'example';")
    expect(html).toContain("proofInput.placeholder = 'https://x.com/example/status/123... or 123...';")
  })
})

describe('TikTok in the API docs', () => {
  it('lists the proof forms the verifier accepts', async () => {
    const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)).text()
    expect(html).toContain('<td><code>tiktok</code></td><td>Username (without @)</td><td>Video or photo link, share link, or post number</td>')
  })

  it('tells people the TikTok proof can be a share link', async () => {
    const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)).text()
    expect(html).toContain("proofLabel.textContent = 'Post link or post number';")
    expect(html).toContain("proofInput.placeholder = 'Post link, share link, or post number';")
    expect(html).toContain("helper.textContent = 'Paste a TikTok video or photo link, a share link, or the post number.';")
  })
})

describe('response fields in the API docs', () => {
  it('documents canonical_proof in the response fields', async () => {
    const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)).text()
    expect(html).toContain('<tr><td><code>canonical_proof</code></td><td>string?</td>')
  })

  it('documents canonical_identity in the response fields', async () => {
    const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)).text()
    expect(html).toContain('<tr><td><code>canonical_identity</code></td><td>string?</td>')
  })

  it('says canonical_proof also reports a pasted link reduced to its post', async () => {
    const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)).text()
    expect(html).toContain('a pasted post link was reduced to the part the check uses')
  })

  it('says a /platforms entry is unsupported when this deployment cannot check its proof posts', async () => {
    expect(await homeHtml()).toContain("Each entry's <code>supported</code> is <code>false</code> when this deployment can't check that platform's proof posts, such as Discord without its bot token.")
  })

  it('says canonical_identity also reports a tidied account', async () => {
    const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)).text()
    expect(html).toContain('the account as sent was tidied (for example a leading @ removed, or a Mastodon handle sent as <code>@user@server</code> returned as <code>server/@user</code>)')
  })
})

describe('favicon', () => {
  // App directories derive an entry's icon as `${origin}/favicon.ico`, so a 404
  // here surfaced as a failed image load in clients rather than as a missing
  // icon. The directory renders the fetched image directly, so it must be the
  // real Divine mark: a transparent pixel would stop the 404 but leave the tile
  // blank.
  it('serves the Divine icon so the directory tile is not blank', async () => {
    const response = await worker.fetch(
      new Request('https://verifier.divine.video/favicon.ico'),
      {} as never,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')

    const bytes = new Uint8Array(await response.arrayBuffer())
    // PNG signature, and larger than a 1x1 placeholder pixel would ever be, so
    // the test fails if the icon regresses to a blank stand-in.
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(bytes.byteLength).toBeGreaterThan(1000)
  })
})

describe('verifier proof-post form', () => {
  // The landing page tidies what the user typed before it calls the API, and
  // that code ships inline in the page. Lift the normaliser out of the served
  // page and run it the way the browser would, rather than reading its text.
  async function browserNormalizer(): Promise<
    (platform: string, identity: string, proof: string) => { identity: string; proof: string }
  > {
    const response = await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)
    expect(response.status).toBe(200)
    const html = await response.text()
    const start = html.indexOf('function tryMakeUrl(')
    expect(start).toBeGreaterThan(-1)
    const end = html.indexOf('async function startOAuthVerification(', start)
    expect(end).toBeGreaterThan(start)
    return new Function(`${html.slice(start, end)}\nreturn normalizeProofInputs;`)()
  }

  it.each(['video', 'photo'])('fills in the TikTok account and post number from a pasted %s link', async (kind) => {
    const normalize = await browserNormalizer()
    expect(normalize('tiktok', '', `https://www.tiktok.com/@alice/${kind}/7123456789012345678?_r=1`)).toEqual({
      identity: 'alice',
      proof: '7123456789012345678',
    })
  })

  it('fills in the account and proof ID from a pasted gist link', async () => {
    const normalize = await browserNormalizer()
    expect(normalize('github', '', 'https://gist.github.com/octocat/abc123')).toEqual({
      identity: 'octocat',
      proof: 'abc123',
    })
  })

  it('fills in the Telegram channel and post from a pasted preview-page link', async () => {
    const normalize = await browserNormalizer()
    expect(normalize('telegram', '', 'https://t.me/s/alicechannel/45')).toEqual({
      identity: 'alicechannel',
      proof: 'alicechannel/45',
    })
  })

  it('drops a leading @ from the channel in a pasted Telegram link', async () => {
    const normalize = await browserNormalizer()
    expect(normalize('telegram', '', 'https://t.me/@alicechannel/45')).toEqual({
      identity: 'alicechannel',
      proof: 'alicechannel/45',
    })
  })

  it('does not take the preview path for a Telegram account when the link names no post', async () => {
    const normalize = await browserNormalizer()
    expect(normalize('telegram', '', 'https://t.me/s/alicechannel')).toEqual({ identity: '', proof: 'https://t.me/s/alicechannel' })
  })

  // The verifier is the only place a Discord message link is parsed. It needs
  // the whole link, channel included, so the page must not shorten it to an ID
  // or otherwise rewrite it on the way to the API.
  const messageLink = (host: string) =>
    `https://${host}/channels/1234567890123456789/2345678901234567890/3456789012345678901`

  it.each([
    messageLink('discord.com'),
    messageLink('canary.discord.com'),
    messageLink('ptb.discord.com'),
    messageLink('discordapp.com'),
    `${messageLink('discord.com')}?ref=copy`,
  ])('hands %s to the verifier exactly as pasted', async (link) => {
    const normalize = await browserNormalizer()
    expect(normalize('discord', 'alice', `  ${link}  `)).toEqual({ identity: 'alice', proof: link })
  })
})
