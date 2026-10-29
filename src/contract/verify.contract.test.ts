// ABOUTME: Pins what the Divine apps read from the verify endpoints, so a change
// ABOUTME: (or a move to another worker) cannot silently break shipped clients.
import { describe, expect, it, vi } from 'vitest'
import { call, verifierAdapter as adapter } from './harness'

const PUBKEY = 'ab'.repeat(32)
const OTHER_PUBKEY = 'cd'.repeat(32)
const target = adapter.target

function stubFetch(handler: () => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async () => handler()))
}

// mobile 1.0.24-1.0.26 verification_result.dart: platform, identity and verified are
// hard casts, checked_at is cast `as int`, error and code are String? (a wrong type throws).
function expectAppShape(result: Record<string, unknown>) {
  expect(typeof result.platform).toBe('string')
  expect(typeof result.identity).toBe('string')
  expect(typeof result.verified).toBe('boolean')
  expect(Number.isInteger(result.checked_at)).toBe(true)
  for (const field of ['error', 'code']) {
    if (field in result) expect(typeof result[field]).toBe('string')
  }
  // mobile verification_result.dart: cached is a bool and canonical_* are strings when present.
  if ('cached' in result) expect(typeof result.cached).toBe('boolean')
  for (const field of ['canonical_identity', 'canonical_proof']) {
    if (field in result) expect(typeof result[field]).toBe('string')
  }
}

async function results(response: Response): Promise<Record<string, unknown>[]> {
  expect(response.status).toBe(200)
  const body = await response.json() as { results: Record<string, unknown>[] }
  return body.results
}

describe('POST /verify (mobile verifier_client.dart)', () => {
  // mobile 1.0.26 identity_claims_repository.dart: results are matched back to claims.
  it('T1.1 answers 200 with one result per claim', async () => {
    const { env } = adapter.env()
    stubFetch(() => new Response('{}', { status: 404 }))
    const claims = [
      { pubkey: PUBKEY, platform: 'github', identity: 'synthetic-one', proof: 'aaa111' },
      { pubkey: PUBKEY, platform: 'github', identity: 'synthetic-two', proof: 'bbb222' },
      { pubkey: PUBKEY, platform: 'github', identity: 'synthetic-three', proof: 'ccc333' },
    ]
    const out = await results(await call(target, 'POST', '/verify', { claims }, env))
    // mobile matches on platform:identity, not position, so compare as a set.
    expect(out).toHaveLength(claims.length)
    const answered = new Set(out.map(r => `${r.platform}:${String(r.identity).toLowerCase()}`))
    for (const c of claims) expect(answered.has(`${c.platform}:${c.identity}`)).toBe(true)
  })

  // mobile 1.0.26 verification_result.dart: one result with a missing or non-integer
  // checked_at (or missing platform, identity, verified) fails the whole batch.
  it('T1.2 gives every result in a mixed batch the shape the app hard-casts', async () => {
    const { env } = adapter.env()
    await adapter.seedSignIn(env, { platform: 'twitter', identity: 'synthetic-signin', pubkey: PUBKEY })
    await adapter.exhaustRateLimit(env, 'pubkey', OTHER_PUBKEY)
    stubFetch(() => new Response('{}', { status: 404 }))
    const out = await results(await call(target, 'POST', '/verify', {
      claims: [
        { pubkey: PUBKEY, platform: 'twitter', identity: 'synthetic-signin', proof: 'oauth' },
        { pubkey: PUBKEY, platform: 'github', identity: 'synthetic-user', proof: 'abc123' },
        { pubkey: PUBKEY, platform: 'unsupported', identity: 'synthetic-user', proof: 'abc123' },
        { pubkey: OTHER_PUBKEY, platform: 'github', identity: 'synthetic-limited', proof: 'abc123' },
      ],
    }, env))
    expect(out).toHaveLength(4)
    for (const result of out) expectAppShape(result)
    expect(out[0]).toMatchObject({ verified: true })
    expect(out[1]).toMatchObject({ verified: false })
    expect(out[2]).toMatchObject({ verified: false })
    expect(out[3]).toMatchObject({ verified: false, code: 'temporarily_unavailable' })
  })

  // mobile 1.0.26 identity_claims_repository.dart: results are matched on
  // platform:identity (lowercased) of what the app sent, never the tidy form.
  it('T1.3 echoes identity exactly as sent, with the tidy form only in canonical_identity', async () => {
    const { env } = adapter.env()
    await adapter.seedSignIn(env, { platform: 'twitter', identity: 'Synthetic-User', pubkey: PUBKEY })
    await adapter.seedCachedVerified(env, { platform: 'mastodon', identity: 'mastodon.social/@user', proof: '123456', pubkey: PUBKEY })
    const out = await results(await call(target, 'POST', '/verify', {
      claims: [
        { pubkey: PUBKEY, platform: 'twitter', identity: '@Synthetic-User', proof: 'oauth' },
        { pubkey: PUBKEY, platform: 'mastodon', identity: '@user@mastodon.social', proof: '123456' },
      ],
    }, env))
    expect(out[0]).toMatchObject({ verified: true, identity: '@Synthetic-User', canonical_identity: 'Synthetic-User' })
    expect(out[1]).toMatchObject({ verified: true, identity: '@user@mastodon.social', canonical_identity: 'mastodon.social/@user' })
  })

  // mobile identity_claim.dart: a Bluesky claim may be sent with proof "" (sign-in only).
  it('T1.4 accepts a Bluesky claim with an empty proof', async () => {
    const { env } = adapter.env()
    stubFetch(() => new Response('{}', { status: 404 }))
    const claim = { pubkey: PUBKEY, platform: 'bluesky', identity: 'synthetic.bsky.social', proof: '' }
    const batch = await results(await call(target, 'POST', '/verify', { claims: [claim] }, env))
    expect(batch[0]).toMatchObject({ platform: 'bluesky', identity: 'synthetic.bsky.social', verified: false })
    // A rejected claim is a 400 on the single endpoint; this one is answered.
    const single = await call(target, 'POST', '/verify/single', claim, env)
    expect(single.status).toBe(200)
  })
})

for (const path of ['/verify/single', '/api/verify']) {
  // mobile verifier_client.dart (single) and divine-web useExternalIdentities.ts (/api/verify):
  // flat { platform, identity, proof, pubkey } in, one result out.
  describe(`POST ${path}`, () => {
    const claim = { platform: 'github', identity: 'synthetic-user', proof: 'abc123', pubkey: PUBKEY }

    it('T1.5 takes a flat claim and returns one result with the app shape', async () => {
      const { env } = adapter.env()
      stubFetch(() => new Response('{}', { status: 404 }))
      const response = await call(target, 'POST', path, claim, env)
      expect(response.status).toBe(200)
      const result = await response.json() as Record<string, unknown>
      expectAppShape(result)
      // web reads verified (truthy), error (shown to people) and code (string only).
      expect(result.verified).toBe(false)
      expect(typeof result.error).toBe('string')
    })

    // mobile verify_connect_cubit.dart and web useExternalIdentities.ts both branch on this exact string.
    it('T1.6 answers a platform outage as temporarily_unavailable and not verified', async () => {
      const { env } = adapter.env()
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('platform down') }))
      const response = await call(target, 'POST', path, claim, env)
      expect(response.status).toBe(200)
      const result = await response.json() as Record<string, unknown>
      expect(result).toMatchObject({ verified: false, code: 'temporarily_unavailable' })
      expectAppShape(result)
    })
  })
}

// divine-web LinkedAccounts.tsx and LinkedAccountsSettingsPage.tsx: people open this as a plain link.
describe('GET /verify/:platform/:identity/:proof', () => {
  const path = `/verify/github/synthetic-user/abc123?pubkey=${PUBKEY}`

  it('T1.7 answers HTML for a browser and the app shape for format=json', async () => {
    const { env } = adapter.env()
    stubFetch(() => new Response('{}', { status: 404 }))
    const html = await call(target, 'GET', path, undefined, env, { Accept: 'text/html' })
    expect(html.status).toBe(200)
    expect(html.headers.get('Content-Type')).toContain('text/html')

    const json = await call(target, 'GET', `${path}&format=json`, undefined, env)
    expect(json.status).toBe(200)
    expectAppShape(await json.json() as Record<string, unknown>)
  })
})
