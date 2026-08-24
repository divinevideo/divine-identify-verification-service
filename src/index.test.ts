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

describe('verifier tiktok oauth gating', () => {
  async function homeHtml(url = 'https://verifier.divine.video/', env = {}): Promise<string> {
    const response = await worker.fetch(
      new Request(url),
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
      await homeHtml('https://verifier.divine.video/?tiktok_oauth_review=1'),
      'oauth-platform-select',
    )
    expect(oauthSelect).toContain('value="tiktok"')
  })

  it('exposes TikTok OAuth when the production rollout flag is enabled', async () => {
    const oauthSelect = sliceSelect(
      await homeHtml('https://verifier.divine.video/', { TIKTOK_OAUTH_ENABLED: 'true' }),
      'oauth-platform-select',
    )
    expect(oauthSelect).toContain('value="tiktok"')
  })

  it('preserves the app-review query through sign-in redirects', async () => {
    const html = await homeHtml('https://verifier.divine.video/?tiktok_oauth_review=1')
    expect(html).toContain('window.location.pathname + window.location.search;')
    expect(html).toContain("window.location.pathname + window.location.search + '#verify-here'")
  })

  it('does not advertise TikTok in the no-posting sign-in instructions', async () => {
    const html = await homeHtml()
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
    const html = await homeHtml('https://verifier.divine.video/', { YOUTUBE_API_KEY: 'key' })
    expect(html).toContain('For Twitter/X, Bluesky, and YouTube, just sign in')
  })

  it('documents recognition of existing TikTok OAuth verifications', async () => {
    expect(await homeHtml()).toContain('Existing TikTok OAuth verifications remain recognized.')
  })

  it('documents why TikTok is unavailable through the platforms endpoint', async () => {
    expect(await homeHtml()).toContain('TikTok reports unsupported while production OAuth rollout is gated')
  })
})
