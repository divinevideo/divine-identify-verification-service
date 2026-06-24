import { describe, it, expect, vi, afterEach } from 'vitest'

import { startTikTokOAuth, handleTikTokCallback } from './tiktok'
import { oauthStateKey } from './state'
import type { OAuthState } from '../types'

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    TIKTOK_CLIENT_KEY: 'test-client-key',
    TIKTOK_CLIENT_SECRET: 'test-client-secret',
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

// Returns a CACHE_KV stub whose get() resolves the stored TikTok OAuth state.
function envWithState(state: Partial<OAuthState> = {}) {
  const stored: OAuthState = {
    platform: 'tiktok',
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

describe('startTikTokOAuth', () => {
  afterEach(() => vi.restoreAllMocks())

  it('requests both basic and profile scopes (username needs user.info.profile)', async () => {
    const env = makeEnv()
    const resp = await startTikTokOAuth(env, PUBKEY, 'https://verifier.divine.video/')

    expect(resp.status).toBe(302)
    const location = resp.headers.get('Location')!
    const scope = new URL(location).searchParams.get('scope')
    // Without user.info.profile, TikTok omits `username` and verification can never succeed.
    expect(scope).toBe('user.info.basic,user.info.profile')
  })

  it('builds the authorize URL with PKCE and the registered redirect URI', async () => {
    const env = makeEnv()
    const resp = await startTikTokOAuth(env, PUBKEY, 'https://verifier.divine.video/')

    const params = new URL(resp.headers.get('Location')!).searchParams
    expect(params.get('client_key')).toBe('test-client-key')
    expect(params.get('redirect_uri')).toBe('https://verifier.divine.video/auth/tiktok/callback')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toBeTruthy()
    expect(params.get('state')).toBeTruthy()
  })

  it('returns 503 when the client key is not configured', async () => {
    const env = makeEnv({ TIKTOK_CLIENT_KEY: undefined })
    const resp = await startTikTokOAuth(env, PUBKEY, 'https://verifier.divine.video/')
    expect(resp.status).toBe(503)
  })
})

describe('handleTikTokCallback', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exchanges the code and returns the username as identity', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
      .mockResolvedValueOnce(jsonResponse({ data: { user: { username: 'creator', display_name: 'Creator' } } }))
    vi.stubGlobal('fetch', fetchMock)

    const env = envWithState()
    const result = await handleTikTokCallback(env, 'auth-code', 'state123')

    expect(result.success).toBe(true)
    expect(result.identity).toBe('creator')
    // Verification is persisted to KV.
    expect(env.CACHE_KV.put).toHaveBeenCalled()
    // user.info request asks for the username field.
    expect(fetchMock.mock.calls[1][0]).toContain('fields=display_name,username')
  })

  it('fails when TikTok omits the username (e.g. user.info.profile scope not granted)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
      .mockResolvedValueOnce(jsonResponse({ data: { user: { display_name: 'Creator' } } }))
    vi.stubGlobal('fetch', fetchMock)

    const env = envWithState()
    const result = await handleTikTokCallback(env, 'auth-code', 'state123')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/username/i)
    expect(env.CACHE_KV.put).not.toHaveBeenCalled()
  })

  it('rejects an unknown or expired state', async () => {
    const env = makeEnv() // CACHE_KV.get resolves null
    const result = await handleTikTokCallback(env, 'auth-code', 'state123')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/state/i)
  })

  it('fails when the token exchange is rejected', async () => {
    // The handler returns at the !tokenResponse.ok check before reading the
    // body, so the body here is irrelevant — only the non-ok status matters.
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({}, false, 400))
    vi.stubGlobal('fetch', fetchMock)

    const env = envWithState()
    const result = await handleTikTokCallback(env, 'auth-code', 'state123')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/token exchange/i)
  })
})
