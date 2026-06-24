import { describe, it, expect, vi, afterEach } from 'vitest'

import { startTwitterOAuth, handleTwitterCallback } from './twitter'
import { oauthStateKey } from './state'
import type { OAuthState } from '../types'

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    TWITTER_CLIENT_ID: 'test-client-id',
    TWITTER_CLIENT_SECRET: 'test-client-secret',
    OAUTH_REDIRECT_BASE: 'https://verifier.divine.video',
    CACHE_KV: {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as any
}

const PUBKEY = 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234'

function envWithState(state: Partial<OAuthState> = {}) {
  const stored: OAuthState = {
    platform: 'twitter',
    pubkey: PUBKEY,
    codeVerifier: 'test-verifier',
    returnUrl: 'https://verifier.divine.video/',
    createdAt: 1_700_000_000_000,
    ...state,
  }
  const get = vi.fn(async (key: string) =>
    key === oauthStateKey('state123') ? JSON.stringify(stored) : null,
  )
  return makeEnv({
    CACHE_KV: {
      put: vi.fn().mockResolvedValue(undefined),
      get,
      delete: vi.fn().mockResolvedValue(undefined),
    },
  })
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response
}

describe('startTwitterOAuth', () => {
  afterEach(() => vi.restoreAllMocks())

  it('requests the users.read scope that grants username on /2/users/me', async () => {
    const env = makeEnv()
    const resp = await startTwitterOAuth(env, PUBKEY, 'https://verifier.divine.video/')

    expect(resp.status).toBe(302)
    const scope = new URL(resp.headers.get('Location')!).searchParams.get('scope')
    // /2/users/me requires tweet.read + users.read; `username` is a default field once granted.
    expect(scope).toBe('users.read tweet.read')
  })

  it('builds the authorize URL with PKCE and the registered redirect URI', async () => {
    const env = makeEnv()
    const resp = await startTwitterOAuth(env, PUBKEY, 'https://verifier.divine.video/')

    const params = new URL(resp.headers.get('Location')!).searchParams
    expect(params.get('client_id')).toBe('test-client-id')
    expect(params.get('redirect_uri')).toBe('https://verifier.divine.video/auth/twitter/callback')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toBeTruthy()
    expect(params.get('state')).toBeTruthy()
  })

  it('returns 503 when the client id is not configured', async () => {
    const env = makeEnv({ TWITTER_CLIENT_ID: undefined })
    const resp = await startTwitterOAuth(env, PUBKEY, 'https://verifier.divine.video/')
    expect(resp.status).toBe(503)
  })
})

describe('handleTwitterCallback', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exchanges the code and returns the username as identity', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
      // Mixed-case username proves the stored KEY is lowercased while the stored
      // PAYLOAD keeps the raw handle — if `.toLowerCase()` were dropped, the key
      // assertion below would fail.
      .mockResolvedValueOnce(jsonResponse({ data: { id: '123', username: 'CreatorX' } }))
    vi.stubGlobal('fetch', fetchMock)

    const env = envWithState()
    const result = await handleTwitterCallback(env, 'auth-code', 'state123')

    expect(result.success).toBe(true)
    expect(result.identity).toBe('CreatorX')
    // Single-use OAuth state must be consumed (replay protection).
    expect(env.CACHE_KV.delete).toHaveBeenCalledWith(oauthStateKey('state123'))
    // Stored key lowercases the identity; the stored payload keeps the raw handle.
    const [key, value] = env.CACHE_KV.put.mock.calls[0]
    expect(key).toBe(`oauth_verified:twitter:creatorx:${PUBKEY}`)
    expect(JSON.parse(value)).toMatchObject({
      platform: 'twitter', identity: 'CreatorX', pubkey: PUBKEY, verified: true, method: 'oauth',
    })
    // Reads identity from the /2/users/me endpoint.
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.twitter.com/2/users/me')
  })

  it('fails when Twitter omits the username', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: '123' } }))
    vi.stubGlobal('fetch', fetchMock)

    const env = envWithState()
    const result = await handleTwitterCallback(env, 'auth-code', 'state123')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/username/i)
    expect(env.CACHE_KV.put).not.toHaveBeenCalled()
  })

  it('rejects an unknown or expired state', async () => {
    const env = makeEnv() // CACHE_KV.get resolves null
    const result = await handleTwitterCallback(env, 'auth-code', 'state123')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/state/i)
  })

  it('fails when the token exchange is rejected', async () => {
    // Returns at the !tokenResponse.ok check before reading the body.
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({}, false, 400))
    vi.stubGlobal('fetch', fetchMock)

    const env = envWithState()
    const result = await handleTwitterCallback(env, 'auth-code', 'state123')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/token exchange/i)
  })

  it('rejects state that was stored for a different platform', async () => {
    // Guards against cross-platform OAuth state confusion (the state.platform check).
    const env = envWithState({ platform: 'youtube' })
    const result = await handleTwitterCallback(env, 'auth-code', 'state123')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/state/i)
    expect(env.CACHE_KV.put).not.toHaveBeenCalled()
  })

  it('fails when the token response has no access_token', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ token_type: 'bearer' }))
    vi.stubGlobal('fetch', fetchMock)
    const env = envWithState()
    const result = await handleTwitterCallback(env, 'auth-code', 'state123')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/access token/i)
    // The user-info request is never reached.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails when the user-info fetch fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
      .mockResolvedValueOnce(jsonResponse({}, false, 500))
    vi.stubGlobal('fetch', fetchMock)
    const env = envWithState()
    const result = await handleTwitterCallback(env, 'auth-code', 'state123')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/user info/i)
    expect(env.CACHE_KV.put).not.toHaveBeenCalled()
  })
})
