// ABOUTME: Pins how the Divine apps start a sign-in and how the verifier sends them back,
// ABOUTME: so a change (or a move to another worker) cannot silently break shipped clients.
import { describe, expect, it, vi } from 'vitest'
import type { Bindings } from '../types'
import { call, verifierAdapter as adapter } from './harness'

const PUBKEY = 'ab'.repeat(32)
const target = adapter.target
const BASE = 'https://verifier.divine.video'
const SIGNIN_ID = '0123456789abcdef0123456789abcdef'
// mobile 1.0.25+ verifier_client.dart: return_url is the app link with the sign-in id.
const RETURN_URL = `https://divine.video/app/callback?signin=${SIGNIN_ID}`
// 43 characters of base64url, as mobile signin_confirmation.dart sends.
const START_CHECK = 'G2CN_J8Es1JmsWz0QXd2Kc-4p-lCo8GCsR-tVw6vre4'

// Production runs with confirmation required, the placement unset by default.
function signInEnv(overrides: Partial<Bindings> = {}): Bindings {
  return adapter.env({
    OAUTH_REDIRECT_BASE: BASE,
    SIGNIN_CONFIRMATION: 'required',
    TWITTER_CLIENT_ID: 'synthetic-id',
    TWITTER_CLIENT_SECRET: 'synthetic-secret',
    ...overrides,
  }).env
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const DID = 'did:plc:synthetic1111111111111111'
const ISSUER = 'https://bsky.social'
const PDS = 'https://pds.example.com'
const TYPED_HANDLE = 'Synthetic.Bsky.Social'

function didDocument() {
  return json({ alsoKnownAs: [`at://${TYPED_HANDLE.toLowerCase()}`], service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] })
}

// Stubs Bluesky's handle resolution, DID document, server metadata and PAR, as the
// existing Bluesky start tests do. The state id travels inside the PAR body.
function stubBlueskyStart(capture: { stateId?: string }) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('com.atproto.identity.resolveHandle')) return json({ did: DID })
    if (url === `https://plc.directory/${DID}`) return didDocument()
    if (url === `${PDS}/.well-known/oauth-protected-resource`) return json({ authorization_servers: [ISSUER] })
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
      })
    }
    if (url === `${ISSUER}/oauth/par`) {
      if (init?.body instanceof URLSearchParams) capture.stateId = init.body.get('state') ?? undefined
      return json({ request_uri: 'urn:ietf:params:oauth:request_uri:synthetic' })
    }
    throw new Error(`Unexpected platform fetch: ${url}`)
  }))
}

function stubBlueskyCallback() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === `${ISSUER}/oauth/token`) return json({ sub: DID, access_token: 'synthetic-token' })
    if (url === `https://plc.directory/${DID}`) return didDocument()
    if (url === `${PDS}/.well-known/oauth-protected-resource`) return json({ authorization_servers: [ISSUER] })
    throw new Error(`Unexpected platform fetch: ${url}`)
  }))
}

async function startTwitter(env: Bindings): Promise<string> {
  const res = await call(target, 'POST', '/auth/twitter/start',
    { pubkey: PUBKEY, return_url: RETURN_URL, start_check: START_CHECK }, env)
  expect(res.status).toBe(200)
  const { url } = await res.json() as { url: string }
  return new URL(url).searchParams.get('state') as string
}

function twitterCallbackFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === 'https://api.twitter.com/2/oauth2/token') return json({ access_token: 'synthetic-token' })
    if (url.startsWith('https://api.twitter.com/2/users/me')) return json({ data: { id: '1', username: 'synthetic-user' } })
    throw new Error(`Unexpected platform fetch: ${url}`)
  }))
}

async function returnedTo(response: Response): Promise<URL> {
  expect(response.status).toBe(302)
  return new URL(response.headers.get('Location') as string)
}

describe('POST /auth/:platform/start (mobile verifier_client.dart)', () => {
  // mobile 1.0.25+ verifier_client.dart startSignIn: success must carry an https url.
  it('T3.1 answers 200 with an https url for a Bluesky start', async () => {
    const env = signInEnv()
    stubBlueskyStart({})
    const res = await call(target, 'POST', '/auth/bluesky/start',
      { pubkey: PUBKEY, return_url: RETURN_URL, start_check: START_CHECK, handle: 'synthetic.bsky.social' }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { url: unknown }
    expect(typeof body.url).toBe('string')
    expect(new URL(body.url as string).protocol).toBe('https:')
  })

  // mobile 1.0.25 verifier_client.dart: only a 503 is read as "sign-in off"; any other
  // status shows a generic failure.
  describe('T3.2 answers 503 when a platform sign-in is off', () => {
    const cases: [string, Partial<Bindings>][] = [
      ['twitter', {}],
      ['bluesky', { OAUTH_REDIRECT_BASE: undefined }],
      ['youtube', { YOUTUBE_API_KEY: 'synthetic-key' }],
      ['tiktok', { TIKTOK_CLIENT_KEY: 'synthetic-key', TIKTOK_CLIENT_SECRET: 'synthetic-secret', TIKTOK_OAUTH_ENABLED: 'false' }],
    ]
    it.each(cases)('%s', async (platform, overrides) => {
      const env = signInEnv({ TWITTER_CLIENT_ID: undefined, TWITTER_CLIENT_SECRET: undefined, ...overrides })
      const res = await call(target, 'POST', `/auth/${platform}/start`,
        { pubkey: PUBKEY, return_url: RETURN_URL, start_check: START_CHECK, handle: 'synthetic.bsky.social' }, env)
      expect(res.status).toBe(503)
    })
  })
})

describe('the return to the app after sign-in', () => {
  // mobile 1.0.25+ verify_connect_cubit.dart and web stripSignInCode.ts: signin is kept,
  // platform and identity are added, and the one-time code is in the fragment because
  // web's /app/callback strips it from the query.
  it('T3.3 returns to the return_url with the code in the fragment', async () => {
    const env = signInEnv()
    const stateId = await startTwitter(env)
    twitterCallbackFetch()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const location = await returnedTo(await call(target, 'GET', `/auth/twitter/callback?code=synthetic&state=${stateId}`, undefined, env))
    expect(location.origin + location.pathname).toBe('https://divine.video/app/callback')
    expect(location.searchParams.get('signin')).toBe(SIGNIN_ID)
    expect(location.searchParams.get('platform')).toBe('twitter')
    expect(location.searchParams.get('identity')).toBe('synthetic-user')
    expect(new URLSearchParams(location.hash.slice(1)).get('oauth_confirm') ?? '').not.toBe('')
    expect(location.searchParams.has('oauth_confirm')).toBe(false)
  })

  // mobile 1.0.25+ verify_connect_cubit.dart: the returned identity must equal the claimed
  // handle ignoring case, so it is the handle as typed, not the DID.
  it('T3.4 returns a Bluesky sign-in with the handle, not the DID', async () => {
    const env = signInEnv()
    const capture: { stateId?: string } = {}
    stubBlueskyStart(capture)
    const start = await call(target, 'POST', '/auth/bluesky/start',
      { pubkey: PUBKEY, return_url: RETURN_URL, start_check: START_CHECK, handle: TYPED_HANDLE }, env)
    expect(start.status).toBe(200)
    stubBlueskyCallback()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const path = `/auth/bluesky/callback?code=synthetic&state=${capture.stateId}&iss=${encodeURIComponent(ISSUER)}`
    const location = await returnedTo(await call(target, 'GET', path, undefined, env))
    const identity = location.searchParams.get('identity') as string
    expect(identity.toLowerCase()).toBe(TYPED_HANDLE.toLowerCase())
    expect(identity.startsWith('did:')).toBe(false)
    expect(location.searchParams.get('platform')).toBe('bluesky')
  })

  // mobile 1.0.25+ verify_connect_cubit.dart: oauth_error is checked for presence only.
  it('T3.5 returns a cancelled sign-in with an oauth_error parameter', async () => {
    const env = signInEnv()
    const stateId = await startTwitter(env)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const location = await returnedTo(await call(target, 'GET', `/auth/twitter/callback?error=access_denied&state=${stateId}`, undefined, env))
    expect(location.origin + location.pathname).toBe('https://divine.video/app/callback')
    expect(location.searchParams.has('oauth_error')).toBe(true)
    expect(location.searchParams.get('signin')).toBe(SIGNIN_ID)
  })
})

describe('GET /auth/:platform/start while confirmation is required (mobile 1.0.24 verifier_client.dart)', () => {
  const query = `pubkey=${PUBKEY}&return_url=${encodeURIComponent('https://divine.video/app/callback')}`

  // Today's behavior, pinned so the old app's refusal stays a refusal. The app reads only the status; no body is pinned.
  it('T3.6 refuses a plain request with 400', async () => {
    const res = await call(target, 'GET', `/auth/twitter/start?${query}`, undefined, signInEnv())
    expect(res.status).toBe(400)
  })

  it('T3.6 sends a browser navigation back to the return_url with oauth_error', async () => {
    const res = await call(target, 'GET', `/auth/twitter/start?${query}`, undefined, signInEnv(), { 'sec-fetch-mode': 'navigate' })
    const location = await returnedTo(res)
    expect(location.origin + location.pathname).toBe('https://divine.video/app/callback')
    expect(location.searchParams.has('oauth_error')).toBe(true)
  })
})
