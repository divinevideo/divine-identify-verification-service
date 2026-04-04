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
