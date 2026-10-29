// ABOUTME: Shared sign-in setups for the contract suite, and a driver for a real Twitter
// ABOUTME: sign-in start and callback, so a test holds the one-time code the service issued.
import { expect, vi } from 'vitest'
import { adapter } from './adapter'
import { BASE_URL, call, type ContractConfig, type TargetEnv } from './harness'

export const SIGNIN_ID = '0123456789abcdef0123456789abcdef'
// mobile 1.0.25+ verifier_client.dart: return_url is the app link with the sign-in id.
export const RETURN_URL = `https://divine.video/app/callback?signin=${SIGNIN_ID}`

export type SignInPlatform = 'twitter' | 'bluesky' | 'youtube' | 'tiktok'

/**
 * For each sign-in platform, a configuration with its sign-in on and one with it
 * off. /platforms reports oauth from the same table that start is tested with,
 * so the two endpoints cannot disagree unnoticed. The off setups are the ones
 * production can be in: TikTok keys set with the switch off, YouTube with only
 * its proof-check key.
 */
export const SIGNIN_SETUPS: Record<SignInPlatform, { on: ContractConfig; off: ContractConfig }> = {
  twitter: {
    on: { OAUTH_REDIRECT_BASE: BASE_URL, TWITTER_CLIENT_ID: 'synthetic-id', TWITTER_CLIENT_SECRET: 'synthetic-secret' },
    off: { OAUTH_REDIRECT_BASE: BASE_URL },
  },
  bluesky: {
    on: { OAUTH_REDIRECT_BASE: BASE_URL },
    off: {},
  },
  youtube: {
    on: {
      OAUTH_REDIRECT_BASE: BASE_URL, YOUTUBE_API_KEY: 'synthetic-key',
      GOOGLE_CLIENT_ID: 'synthetic-id', GOOGLE_CLIENT_SECRET: 'synthetic-secret',
    },
    off: { OAUTH_REDIRECT_BASE: BASE_URL, YOUTUBE_API_KEY: 'synthetic-key' },
  },
  tiktok: {
    on: {
      OAUTH_REDIRECT_BASE: BASE_URL, TIKTOK_CLIENT_KEY: 'synthetic-key',
      TIKTOK_CLIENT_SECRET: 'synthetic-secret', TIKTOK_OAUTH_ENABLED: 'true',
    },
    off: {
      OAUTH_REDIRECT_BASE: BASE_URL, TIKTOK_CLIENT_KEY: 'synthetic-key',
      TIKTOK_CLIENT_SECRET: 'synthetic-secret', TIKTOK_OAUTH_ENABLED: 'false',
    },
  },
}

/** Production runs with confirmation required; Twitter sign-in is on unless overridden. */
export function signInEnv(config: ContractConfig = {}): TargetEnv {
  return adapter.env({ ...SIGNIN_SETUPS.twitter.on, SIGNIN_CONFIRMATION: 'required', ...config }).env
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** POST /auth/twitter/start; answers the state id from the provider-facing url. */
export async function startTwitter(env: TargetEnv, pubkey: string, startCheck: string): Promise<string> {
  const res = await call(adapter.target, 'POST', '/auth/twitter/start',
    { pubkey, return_url: RETURN_URL, start_check: startCheck }, env)
  expect(res.status).toBe(200)
  const { url } = await res.json() as { url: string }
  return new URL(url).searchParams.get('state') as string
}

/** Stubs the provider so a Twitter callback signs in as `synthetic-user`. */
export function stubTwitterCallback() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === 'https://api.twitter.com/2/oauth2/token') return json({ access_token: 'synthetic-token' })
    if (url.startsWith('https://api.twitter.com/2/users/me')) return json({ data: { id: '1', username: 'synthetic-user' } })
    throw new Error(`Unexpected platform fetch: ${url}`)
  }))
}

/** Finishes the sign-in through the real callback; answers the redirect back to the app. */
export async function finishTwitter(env: TargetEnv, stateId: string): Promise<URL> {
  stubTwitterCallback()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const res = await call(adapter.target, 'GET', `/auth/twitter/callback?code=synthetic&state=${stateId}`, undefined, env)
  expect(res.status).toBe(302)
  return new URL(res.headers.get('Location') as string)
}
