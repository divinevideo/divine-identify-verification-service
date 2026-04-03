import { describe, expect, it } from 'vitest'
import worker from './index'

describe('verifier cors', () => {
  it('echoes app origin on preflight', async () => {
    const response = await worker.fetch(new Request('https://verifier.divine.video/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.divine.video',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Content-Type,Authorization,X-Requested-With',
      },
    }), {} as never)

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.divine.video')
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS')
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization, X-Requested-With')
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400')
    expect(response.headers.get('Vary')).toContain('Origin')
  })

  it('echoes preview origin on actual responses', async () => {
    const response = await worker.fetch(new Request('https://verifier.divine.video/health', {
      headers: {
        Origin: 'https://pr-123.openvine-app.pages.dev',
      },
    }), {} as never)

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://pr-123.openvine-app.pages.dev')
    expect(response.headers.get('Vary')).toContain('Origin')
  })

  it('does not allow unknown origins', async () => {
    const response = await worker.fetch(new Request('https://verifier.divine.video/health', {
      headers: {
        Origin: 'https://evil.example',
      },
    }), {} as never)

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
