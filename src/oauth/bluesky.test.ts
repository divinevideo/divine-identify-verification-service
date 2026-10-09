import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// We test the PAR nonce retry logic by calling startBlueskyOAuth with mocked
// fetch, crypto, and KV. The function lives in bluesky.ts and is exported.
// Since it does auth server discovery + PAR + redirect, we mock the full chain.

import { startBlueskyOAuth } from './bluesky'

// These tests don't exercise sign-in binding; any hash-shaped string will do.
const BINDING_HASH = 'b'.repeat(64)

// Minimal env stub with OAUTH_REDIRECT_BASE set
function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    OAUTH_REDIRECT_BASE: 'https://verifier.divine.video',
    CACHE_KV: {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    RATE_LIMIT_KV: {
      put: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  } as any
}

// Bluesky auth server discovery responses (3 fetches before PAR)
function mockDiscoveryChain() {
  return [
    // 1. resolveHandle -> DID
    {
      ok: true,
      json: async () => ({ did: 'did:plc:testuser123' }),
    },
    // 2. DID document from plc.directory
    {
      ok: true,
      json: async () => ({
        alsoKnownAs: ['at://alice.bsky.social'],
        service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.bsky.social' }],
      }),
    },
    // 3. PDS resource metadata
    {
      ok: true,
      json: async () => ({
        authorization_servers: ['https://bsky.social'],
      }),
    },
    // 4. Auth server metadata
    {
      ok: true,
      json: async () => ({
        issuer: 'https://bsky.social',
        authorization_endpoint: 'https://bsky.social/oauth/authorize',
        token_endpoint: 'https://bsky.social/oauth/token',
        pushed_authorization_request_endpoint: 'https://bsky.social/oauth/par',
      }),
    },
  ]
}

// Successful PAR response
function parSuccess() {
  return {
    ok: true,
    status: 201,
    headers: new Headers(),
    json: async () => ({ request_uri: 'urn:ietf:params:oauth:request_uri:test123' }),
  }
}

// PAR rejection with use_dpop_nonce
function parNonceRequired(nonce: string) {
  return {
    ok: false,
    status: 400,
    headers: new Headers({ 'DPoP-Nonce': nonce }),
    json: async () => ({ error: 'use_dpop_nonce' }),
    text: async () => JSON.stringify({ error: 'use_dpop_nonce' }),
  }
}

// PAR failure without nonce (real error)
function parFailed(status: number, body: string) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => ({ error: body }),
    text: async () => body,
  }
}

describe('startBlueskyOAuth - DPoP nonce retry', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('retries PAR with nonce when auth server returns DPoP-Nonce header', async () => {
    const discovery = mockDiscoveryChain()
    const nonce = 'server-nonce-abc123'
    const fetchMock = vi.fn()
      // Discovery chain (4 fetches)
      .mockResolvedValueOnce(discovery[0])
      .mockResolvedValueOnce(discovery[1])
      .mockResolvedValueOnce(discovery[2])
      .mockResolvedValueOnce(discovery[3])
      // First PAR: rejected with nonce
      .mockResolvedValueOnce(parNonceRequired(nonce))
      // Second PAR: success
      .mockResolvedValueOnce(parSuccess())

    vi.stubGlobal('fetch', fetchMock)

    const env = makeEnv()
    const resp = await startBlueskyOAuth(
      env,
      'alice.bsky.social',
      'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
      'https://verifier.divine.video/',
      BINDING_HASH,
    )

    // Should redirect to Bluesky authorization endpoint
    expect(resp.status).toBe(302)
    const location = resp.headers.get('Location')
    expect(location).toContain('bsky.social/oauth/authorize')
    expect(location).toContain('request_uri=')

    // 4 discovery + 2 PAR (initial + retry) = 6 fetches
    expect(fetchMock).toHaveBeenCalledTimes(6)

    // Verify the retry PAR request has a different DPoP header than the first
    const firstParCall = fetchMock.mock.calls[4]
    const retryParCall = fetchMock.mock.calls[5]
    expect(firstParCall[0]).toBe('https://bsky.social/oauth/par')
    expect(retryParCall[0]).toBe('https://bsky.social/oauth/par')
    expect(firstParCall[1].headers['DPoP']).not.toBe(retryParCall[1].headers['DPoP'])
  })

  it('succeeds without retry when PAR returns OK on first attempt', async () => {
    const discovery = mockDiscoveryChain()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(discovery[0])
      .mockResolvedValueOnce(discovery[1])
      .mockResolvedValueOnce(discovery[2])
      .mockResolvedValueOnce(discovery[3])
      .mockResolvedValueOnce(parSuccess())

    vi.stubGlobal('fetch', fetchMock)

    const env = makeEnv()
    const resp = await startBlueskyOAuth(
      env,
      'alice.bsky.social',
      'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
      'https://verifier.divine.video/',
      BINDING_HASH,
    )

    expect(resp.status).toBe(302)
    // 4 discovery + 1 PAR = 5 fetches (no retry)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('returns error with detail when PAR fails without nonce header', async () => {
    const discovery = mockDiscoveryChain()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(discovery[0])
      .mockResolvedValueOnce(discovery[1])
      .mockResolvedValueOnce(discovery[2])
      .mockResolvedValueOnce(discovery[3])
      .mockResolvedValueOnce(parFailed(403, 'invalid_client'))

    vi.stubGlobal('fetch', fetchMock)

    const env = makeEnv()
    const resp = await startBlueskyOAuth(
      env,
      'alice.bsky.social',
      'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
      'https://verifier.divine.video/',
      BINDING_HASH,
    )

    expect(resp.status).toBe(502)
    const body = await resp.json() as { error: string; status: number; detail: string }
    expect(body.error).toBe('Bluesky authorization request failed')
    expect(body.status).toBe(403)
    expect(body.detail).toBe('invalid_client')
  })

  it('logs only the sanitized error code and status when PAR fails with a JSON body, not the rest of it', async () => {
    const discovery = mockDiscoveryChain()
    const parBody = JSON.stringify({ error: 'invalid_request', error_description: 'login_hint alice.bsky.social was bad' })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(discovery[0])
      .mockResolvedValueOnce(discovery[1])
      .mockResolvedValueOnce(discovery[2])
      .mockResolvedValueOnce(discovery[3])
      .mockResolvedValueOnce(parFailed(400, parBody))

    vi.stubGlobal('fetch', fetchMock)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const env = makeEnv()
    const resp = await startBlueskyOAuth(
      env,
      'alice.bsky.social',
      'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
      'https://verifier.divine.video/',
      BINDING_HASH,
    )

    expect(resp.status).toBe(502)
    expect(errorSpy).toHaveBeenCalledWith('Bluesky PAR failed:', 400, 'invalid_request')
    const logged = JSON.stringify(errorSpy.mock.calls)
    expect(logged).not.toContain('login_hint')
    expect(logged).not.toContain('alice.bsky.social')
  })

  it('logs \'other\' when PAR fails with a JSON body whose error is not code-shaped', async () => {
    const discovery = mockDiscoveryChain()
    const parBody = JSON.stringify({ error: 'alice.bsky.social is bad' })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(discovery[0])
      .mockResolvedValueOnce(discovery[1])
      .mockResolvedValueOnce(discovery[2])
      .mockResolvedValueOnce(discovery[3])
      .mockResolvedValueOnce(parFailed(400, parBody))

    vi.stubGlobal('fetch', fetchMock)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const env = makeEnv()
    const resp = await startBlueskyOAuth(
      env,
      'alice.bsky.social',
      'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
      'https://verifier.divine.video/',
      BINDING_HASH,
    )

    expect(resp.status).toBe(502)
    expect(errorSpy).toHaveBeenCalledWith('Bluesky PAR failed:', 400, 'other')
    const logged = JSON.stringify(errorSpy.mock.calls)
    expect(logged).not.toContain('alice.bsky.social')
  })

  it('logs \'other\' when PAR fails with a body that is not JSON', async () => {
    const discovery = mockDiscoveryChain()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(discovery[0])
      .mockResolvedValueOnce(discovery[1])
      .mockResolvedValueOnce(discovery[2])
      .mockResolvedValueOnce(discovery[3])
      .mockResolvedValueOnce(parFailed(500, 'not json at all'))

    vi.stubGlobal('fetch', fetchMock)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const env = makeEnv()
    const resp = await startBlueskyOAuth(
      env,
      'alice.bsky.social',
      'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
      'https://verifier.divine.video/',
      BINDING_HASH,
    )

    expect(resp.status).toBe(502)
    expect(errorSpy).toHaveBeenCalledWith('Bluesky PAR failed:', 500, 'other')
  })

  it('returns error when retry with nonce also fails', async () => {
    const discovery = mockDiscoveryChain()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(discovery[0])
      .mockResolvedValueOnce(discovery[1])
      .mockResolvedValueOnce(discovery[2])
      .mockResolvedValueOnce(discovery[3])
      // First PAR: nonce required
      .mockResolvedValueOnce(parNonceRequired('nonce1'))
      // Retry: still fails
      .mockResolvedValueOnce(parFailed(400, 'invalid_dpop_proof'))

    vi.stubGlobal('fetch', fetchMock)

    const env = makeEnv()
    const resp = await startBlueskyOAuth(
      env,
      'alice.bsky.social',
      'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
      'https://verifier.divine.video/',
      BINDING_HASH,
    )

    expect(resp.status).toBe(502)
    const body = await resp.json() as { error: string; detail: string }
    expect(body.detail).toBe('invalid_dpop_proof')
    // 4 discovery + 2 PAR = 6 fetches
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('returns 503 when OAUTH_REDIRECT_BASE is not set', async () => {
    const env = makeEnv({ OAUTH_REDIRECT_BASE: undefined })
    const resp = await startBlueskyOAuth(
      env,
      'alice.bsky.social',
      'abcd1234',
      'https://verifier.divine.video/',
      BINDING_HASH,
    )

    expect(resp.status).toBe(503)
    const body = await resp.json() as { error: string }
    expect(body.error).toBe('OAuth not configured')
  })
})
