// ABOUTME: Drives a real Twitter sign-in start and callback for the contract suite, so a
// ABOUTME: test holds a pending sign-in with the one-time code the service issued.
import { expect, vi } from 'vitest'
import type { Bindings } from '../types'
import { call, verifierAdapter } from './harness'

export const SIGNIN_ID = '0123456789abcdef0123456789abcdef'
// mobile 1.0.25+ verifier_client.dart: return_url is the app link with the sign-in id.
export const RETURN_URL = `https://divine.video/app/callback?signin=${SIGNIN_ID}`

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** POST /auth/twitter/start; answers the state id from the provider-facing url. */
export async function startTwitter(env: Bindings, pubkey: string, startCheck: string): Promise<string> {
  const res = await call(verifierAdapter.target, 'POST', '/auth/twitter/start',
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
export async function finishTwitter(env: Bindings, stateId: string): Promise<URL> {
  stubTwitterCallback()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const res = await call(verifierAdapter.target, 'GET', `/auth/twitter/callback?code=synthetic&state=${stateId}`, undefined, env)
  expect(res.status).toBe(302)
  return new URL(res.headers.get('Location') as string)
}
