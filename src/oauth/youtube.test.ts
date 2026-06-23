import { describe, it, expect, vi, afterEach } from 'vitest'

import { startYouTubeOAuth, handleYouTubeCallback } from './youtube'
import { oauthStateKey } from './state'
import type { OAuthState } from '../types'

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
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
    platform: 'youtube',
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

describe('startYouTubeOAuth', () => {
  afterEach(() => vi.restoreAllMocks())

  it('requests the youtube.readonly scope needed to read the signed-in channel', async () => {
    const env = makeEnv()
    const resp = await startYouTubeOAuth(env, PUBKEY, 'https://verifier.divine.video/')

    expect(resp.status).toBe(302)
    const scope = new URL(resp.headers.get('Location')!).searchParams.get('scope')
    expect(scope).toBe('https://www.googleapis.com/auth/youtube.readonly')
  })

  it('builds the authorize URL with PKCE and the registered redirect URI', async () => {
    const env = makeEnv()
    const resp = await startYouTubeOAuth(env, PUBKEY, 'https://verifier.divine.video/')

    const params = new URL(resp.headers.get('Location')!).searchParams
    expect(params.get('client_id')).toBe('test-client-id')
    expect(params.get('redirect_uri')).toBe('https://verifier.divine.video/auth/youtube/callback')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toBeTruthy()
    expect(params.get('state')).toBeTruthy()
  })

  it('returns 503 when the client id is not configured', async () => {
    const env = makeEnv({ GOOGLE_CLIENT_ID: undefined })
    const resp = await startYouTubeOAuth(env, PUBKEY, 'https://verifier.divine.video/')
    expect(resp.status).toBe(503)
  })
})

describe('handleYouTubeCallback', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exchanges the code and returns the channel handle (customUrl) as identity', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'UC123', snippet: { customUrl: '@creator', title: 'Creator' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    const env = envWithState()
    const result = await handleYouTubeCallback(env, 'auth-code', 'state123')

    expect(result.success).toBe(true)
    expect(result.identity).toBe('@creator')
    expect(env.CACHE_KV.put).toHaveBeenCalled()
    // Reads the authenticated user's own channel.
    expect(fetchMock.mock.calls[1][0]).toContain('part=snippet&mine=true')
  })

  it('falls back to the channel id when customUrl is absent', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'UC123', snippet: { title: 'Creator' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    const env = envWithState()
    const result = await handleYouTubeCallback(env, 'auth-code', 'state123')

    expect(result.success).toBe(true)
    expect(result.identity).toBe('UC123')
  })

  it('fails when the account has no channel', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const env = envWithState()
    const result = await handleYouTubeCallback(env, 'auth-code', 'state123')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no youtube channel/i)
    expect(env.CACHE_KV.put).not.toHaveBeenCalled()
  })

  it('rejects an unknown or expired state', async () => {
    const env = makeEnv() // CACHE_KV.get resolves null
    const result = await handleYouTubeCallback(env, 'auth-code', 'state123')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/state/i)
  })

  it('fails when the token exchange is rejected', async () => {
    // Returns at the !tokenResponse.ok check before reading the body.
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({}, false, 400))
    vi.stubGlobal('fetch', fetchMock)

    const env = envWithState()
    const result = await handleYouTubeCallback(env, 'auth-code', 'state123')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/token exchange/i)
  })
})
