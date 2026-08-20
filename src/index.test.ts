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
  async function homeHtml(): Promise<string> {
    const response = await worker.fetch(
      new Request('https://verifier.divine.video/'),
      {} as never,
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
})
