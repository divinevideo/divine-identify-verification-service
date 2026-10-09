import { describe, expect, it } from 'vitest'
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

// Twitter sign-in needs all three: the start step uses the client ID and
// redirect base, and the callback's token exchange also needs the secret.
const twitterOAuthConfig = {
  TWITTER_CLIENT_ID: 'test-client-id',
  TWITTER_CLIENT_SECRET: 'test-client-secret',
  OAUTH_REDIRECT_BASE: 'https://verifier.divine.video',
}

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

  it('does not advertise TikTok in the no-posting sign-in instructions', async () => {
    const html = await homeHtml('https://verifier.divine.video/', twitterOAuthConfig)
    const marker = 'just sign in from this page'
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
    const html = await homeHtml('https://verifier.divine.video/', { ...twitterOAuthConfig, YOUTUBE_API_KEY: 'key' })
    expect(html).toContain('For Twitter/X, Bluesky, and YouTube, just sign in')
  })

  it('documents recognition of existing TikTok OAuth verifications', async () => {
    expect(await homeHtml()).toContain('Existing TikTok OAuth verifications remain recognized.')
  })

  it('documents why TikTok is unavailable through the platforms endpoint', async () => {
    expect(await homeHtml()).toContain('TikTok reports unsupported while production OAuth rollout is gated')
  })
})

describe('verifier twitter oauth gating', () => {
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

  it('points Twitter users to proof posts instead of sign-in when it is not configured', async () => {
    const html = await homeHtml()
    expect(html).toContain('For Bluesky, just sign in from this page.')
    expect(html).toContain('No posting required for Bluesky.')
    expect(html).toContain('For Twitter, GitHub, Mastodon, Telegram, Discord, and TikTok, use the advanced section')
  })

  it('describes Twitter as a sign-in platform when it is configured', async () => {
    const html = await homeHtml('https://verifier.divine.video/', twitterOAuthConfig)
    expect(html).toContain('For Twitter/X and Bluesky, just sign in from this page.')
    expect(html).toContain('No posting required for Twitter and Bluesky.')
    expect(html).toContain('For GitHub, Mastodon, Telegram, Discord, and TikTok, use the advanced section')
  })

  it('leaves TikTok out of the post-link list once its sign-in is enabled', async () => {
    const html = await homeHtml('https://verifier.divine.video/', {
      TIKTOK_CLIENT_KEY: 'test-client-key',
      TIKTOK_CLIENT_SECRET: 'test-client-secret',
      OAUTH_REDIRECT_BASE: 'https://verifier.divine.video',
      TIKTOK_OAUTH_ENABLED: 'true',
    })
    expect(html).toContain('For Twitter, GitHub, Mastodon, Telegram, and Discord, use the advanced section')
  })

  it('tells people in the sign-in card which platforms use a post link instead', async () => {
    const card = (html: string) => {
      const start = html.indexOf('Quick Connect (no posting)')
      expect(start).toBeGreaterThan(-1)
      const end = html.indexOf('id="oauth-start-btn"', start)
      expect(end).toBeGreaterThan(start)
      return html.slice(start, end)
    }
    expect(card(await homeHtml())).toContain('For Twitter, GitHub, Mastodon, Telegram, Discord, and TikTok, use Step 3 below to paste a post link instead.')
    expect(card(await homeHtml('https://verifier.divine.video/', twitterOAuthConfig))).toContain('For GitHub, Mastodon, Telegram, Discord, and TikTok, use Step 3 below to paste a post link instead.')
  })

  it('reads the post-link hint before the picker and ties it to the picker for screen readers', async () => {
    const html = await homeHtml()
    const hint = html.indexOf('id="oauth-platform-help"')
    expect(hint).toBeGreaterThan(-1)
    expect(hint).toBeLessThan(html.indexOf('<label for="oauth-platform-select"'))
    expect(html).toContain('<select id="oauth-platform-select" class="field-select" aria-describedby="oauth-platform-help">')
  })

  it('describes Step 3 as the path for platforms without Quick Connect', async () => {
    const html = await homeHtml()
    expect(html).toContain('Use this for platforms without Quick Connect, or if you would rather not sign in.')
    expect(html).not.toContain('Use this only if you do not want Quick Connect.')
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
    expect(docs).toContain('/auth/bluesky/status?pubkey=hex64&amp;identity=alice.bsky.social')
    expect(docs).toContain('before cached results and proof posts, for Bluesky.')
    expect(html).toContain('<li><strong>OAuth login</strong> (Bluesky) &mdash;')
  })

  it('documents Twitter sign-in when it is configured', async () => {
    const docs = oauthDocsSection(await homeHtml('https://verifier.divine.video/', twitterOAuthConfig))
    expect(docs).toContain('<h2>OAuth Verification (Twitter, Bluesky)</h2>')
    expect(docs).toContain('/auth/twitter/start?pubkey=hex64')
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
