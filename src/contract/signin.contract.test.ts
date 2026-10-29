// ABOUTME: Pins how the Divine apps start a sign-in and how the verifier sends them back,
// ABOUTME: so a change (or a move to another worker) cannot silently break shipped clients.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { adapter } from './adapter'
import { call, type ContractConfig, type TargetEnv } from './harness'
import {
  RETURN_URL, SIGNIN_ID, SIGNIN_SETUPS, type SignInPlatform, signInEnv,
  startTwitter as startTwitterWith, stubTwitterCallback,
} from './signin-driver'

const PUBKEY = 'ab'.repeat(32)
const target = adapter.target
// 43 characters of base64url, as mobile signin_confirmation.dart sends.
const START_CHECK = 'G2CN_J8Es1JmsWz0QXd2Kc-4p-lCo8GCsR-tVw6vre4'

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

const startTwitter = (env: TargetEnv) => startTwitterWith(env, PUBKEY, START_CHECK)

async function returnedTo(response: Response): Promise<URL> {
  expect(response.status).toBe(302)
  return new URL(response.headers.get('Location') as string)
}

const SIGNIN_PLATFORMS = Object.keys(SIGNIN_SETUPS) as SignInPlatform[]

function startBody(platform: SignInPlatform) {
  return {
    pubkey: PUBKEY, return_url: RETURN_URL, start_check: START_CHECK,
    ...(platform === 'bluesky' ? { handle: 'synthetic.bsky.social' } : {}),
  }
}

describe('POST /auth/:platform/start (mobile verifier_client.dart)', () => {
  // mobile 1.0.25+ verifier_client.dart startSignIn: success must carry an https url. The
  // setups are the ones /platforms reports oauth true for (platforms.contract.test.ts T2.7).
  it.each(SIGNIN_PLATFORMS)('T3.1 answers 200 with an https url when %s sign-in is on', async (platform) => {
    const env = adapter.env({ SIGNIN_CONFIRMATION: 'required', ...SIGNIN_SETUPS[platform].on }).env
    if (platform === 'bluesky') stubBlueskyStart({})
    const res = await call(target, 'POST', `/auth/${platform}/start`, startBody(platform), env)
    expect(res.status).toBe(200)
    const body = await res.json() as { url: unknown }
    expect(typeof body.url).toBe('string')
    expect(new URL(body.url as string).protocol).toBe('https:')
  })

  // mobile 1.0.25 verifier_client.dart: only a 503 is read as "sign-in off"; any other
  // status shows a generic failure. The setups are the ones /platforms reports oauth false for.
  it.each(SIGNIN_PLATFORMS)('T3.2 answers 503 when %s sign-in is off', async (platform) => {
    const env = adapter.env({ SIGNIN_CONFIRMATION: 'required', ...SIGNIN_SETUPS[platform].off }).env
    const res = await call(target, 'POST', `/auth/${platform}/start`, startBody(platform), env)
    expect(res.status).toBe(503)
  })
})

describe('the return to the app after sign-in', () => {
  // mobile 1.0.25+ verify_connect_cubit.dart and web stripSignInCode.ts: signin is kept,
  // platform and identity are added, and the one-time code is in the fragment because
  // web's /app/callback strips it from the query.
  // Production sets SIGNIN_CODE_PLACEMENT = "fragment" (wrangler.toml); unset means the same.
  const placements: [string, ContractConfig][] = [
    ['unset', {}],
    ['"fragment", as production sets it', { SIGNIN_CODE_PLACEMENT: 'fragment' }],
  ]
  it.each(placements)('T3.3 returns to the return_url with the code in the fragment, placement %s', async (_name, config) => {
    const env = signInEnv(config)
    const stateId = await startTwitter(env)
    stubTwitterCallback()
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
  // The refusal is logged; keep the expected line out of the test output.
  beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}) })

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
