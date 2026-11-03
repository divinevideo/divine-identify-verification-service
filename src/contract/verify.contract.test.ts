// ABOUTME: Pins what the Divine apps read from the verify endpoints, so a change
// ABOUTME: (or a move to another worker) cannot silently break shipped clients.
import { describe, expect, it, vi } from 'vitest'
import { bech32 } from '@scure/base'
import { hexToBytes } from '@noble/curves/utils.js'
import { adapter } from './adapter'
import { call, type TargetEnv } from './harness'
import { expectAppShape } from './app-shape'

const PUBKEY = 'ab'.repeat(32)
const OTHER_PUBKEY = 'cd'.repeat(32)
const target = adapter.target

function stubFetch(handler: () => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async () => handler()))
}

// An outage is logged as a warning; keep the expected line out of the test output.
function platformDown() {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('platform down') }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
}

// Bluesky's handle lookup answers this account; any other request throws, as the README says.
function blueskyResolvesTo(did: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/xrpc/com.atproto.identity.resolveHandle?')) return Response.json({ did })
    throw new Error(`unexpected request: ${url}`)
  }))
}

// A Bluesky sign-in as production saves it: under the handle and the account's DID, each
// carrying that DID and the handle.
async function seedBlueskySignIn(env: TargetEnv, handle: string, did: string) {
  for (const identity of [handle, did]) {
    await adapter.seedSignIn(env, { platform: 'bluesky', identity, pubkey: PUBKEY, account_id: did, handle })
  }
}

// Production runs sign-in confirmation as required, which decides whether a sign-in link counts.
// Tests with a sign-in link in the batch run in that mode.
function verifyEnv(config: Parameters<typeof adapter.env>[0] = {}) {
  return adapter.env({ SIGNIN_CONFIRMATION: 'required', ...config })
}

async function results(response: Response): Promise<Record<string, unknown>[]> {
  expect(response.status).toBe(200)
  const body = await response.json() as { results: Record<string, unknown>[] }
  return body.results
}

// mobile matches results to claims by platform:identity, not position.
function answerFor(out: Record<string, unknown>[], identity: string): Record<string, unknown> | undefined {
  return out.find(r => r.identity === identity)
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
    const { env } = verifyEnv()
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
    // Matched on platform:identity, as the app does, not by position.
    const byKey = (key: string) => out.find(r => `${r.platform}:${r.identity}` === key)
    expect(byKey('twitter:synthetic-signin')).toMatchObject({ verified: true })
    expect(byKey('github:synthetic-user')).toMatchObject({ verified: false })
    expect(byKey('unsupported:synthetic-user')).toMatchObject({ verified: false })
    expect(byKey('github:synthetic-limited')).toMatchObject({ verified: false, code: 'temporarily_unavailable' })
  })

  // mobile 1.0.24 identity_claims_repository.dart and 1.0.25-1.0.27 verification_result.dart:
  // code temporarily_unavailable is inconclusive, so the batch writes no verdicts and a
  // known-good claim keeps its badge. A per-platform rate limit is that kind of retry.
  it('T1.2 answers a per-platform rate limit as temporarily_unavailable, with the app shape', async () => {
    const { env } = adapter.env()
    await adapter.exhaustRateLimit(env, 'platform', 'github')
    stubFetch(() => new Response('{}', { status: 404 }))
    const out = await results(await call(target, 'POST', '/verify', {
      claims: [{ pubkey: PUBKEY, platform: 'github', identity: 'synthetic-platform-limited', proof: 'abc123' }],
    }, env))
    expect(out).toHaveLength(1)
    expectAppShape(out[0])
    expect(out[0]).toMatchObject({ platform: 'github', identity: 'synthetic-platform-limited', verified: false, code: 'temporarily_unavailable' })
  })

  // mobile 1.0.24-1.0.27 (same files as above): any code but temporarily_unavailable makes
  // verified false a definite no, so a known-good claim loses its badge. A sign-in link that
  // no longer counts must be that. No app reads which code it is, so only that is pinned.
  it('T1.2 answers a sign-in link with no counted record as a definite no', async () => {
    const { env } = verifyEnv()
    const out = await results(await call(target, 'POST', '/verify', {
      claims: [{ pubkey: PUBKEY, platform: 'twitter', identity: '@Synthetic-Lapsed', proof: 'oauth' }],
    }, env))
    expect(out).toHaveLength(1)
    expectAppShape(out[0])
    expect(out[0]).toMatchObject({ platform: 'twitter', identity: '@Synthetic-Lapsed', verified: false })
    expect(out[0].code).not.toBe('temporarily_unavailable')
  })

  // mobile 1.0.24-1.0.27 (same files as above): a Bluesky handle that now points to another
  // account is a definite no, not a retry.
  it('T1.2 answers a signed-in Bluesky handle that now points elsewhere as a definite no', async () => {
    const { env } = verifyEnv()
    await seedBlueskySignIn(env, 'synthetic.bsky.social', 'did:plc:syntheticlinked')
    // Bluesky now resolves the handle to a different account.
    blueskyResolvesTo('did:plc:syntheticother')
    const out = await results(await call(target, 'POST', '/verify', {
      claims: [{ pubkey: PUBKEY, platform: 'bluesky', identity: 'synthetic.bsky.social', proof: '' }],
    }, env))
    expect(out).toHaveLength(1)
    expectAppShape(out[0])
    expect(out[0]).toMatchObject({ platform: 'bluesky', identity: 'synthetic.bsky.social', verified: false })
    expect(out[0].code).not.toBe('temporarily_unavailable')
  })

  // mobile 1.0.26 identity_claims_repository.dart: results are matched on
  // platform:identity (lowercased) of what the app sent, never the tidy form.
  it('T1.3 echoes identity exactly as sent, with the tidy form only in canonical_identity', async () => {
    const { env } = verifyEnv()
    await adapter.seedSignIn(env, { platform: 'twitter', identity: 'Synthetic-User', pubkey: PUBKEY })
    await adapter.seedSignIn(env, { platform: 'twitter', identity: 'Synthetic-Spaced', pubkey: PUBKEY })
    await adapter.seedCachedVerified(env, { platform: 'mastodon', identity: 'mastodon.social/@synthetic-user', proof: '123456', pubkey: PUBKEY })
    const out = await results(await call(target, 'POST', '/verify', {
      claims: [
        { pubkey: PUBKEY, platform: 'twitter', identity: '@Synthetic-User', proof: 'oauth' },
        { pubkey: PUBKEY, platform: 'mastodon', identity: '@synthetic-user@mastodon.social', proof: '123456' },
        // Surrounding spaces pass the app's isServerValid, so they can be sent.
        { pubkey: PUBKEY, platform: 'twitter', identity: ' Synthetic-Spaced ', proof: 'oauth' },
      ],
    }, env))
    expect(answerFor(out, '@Synthetic-User')).toMatchObject({ verified: true, canonical_identity: 'Synthetic-User' })
    expect(answerFor(out, '@synthetic-user@mastodon.social')).toMatchObject({ verified: true, canonical_identity: 'mastodon.social/@synthetic-user' })
    expect(answerFor(out, ' Synthetic-Spaced ')).toMatchObject({ verified: true, canonical_identity: 'Synthetic-Spaced' })
  })

  // mobile 1.0.26 identity_claim.dart isServerValid: a Bluesky claim may be sent with proof "" or
  // whitespace (sign-in only). It must be answered from the sign-in, not rejected as invalid.
  it.each(['', '  '])('T1.4 verifies a signed-in Bluesky claim sent with proof %j', async (proof) => {
    const { env } = verifyEnv()
    await seedBlueskySignIn(env, 'synthetic.bsky.social', 'did:plc:syntheticlinked')
    blueskyResolvesTo('did:plc:syntheticlinked')
    const claim = { pubkey: PUBKEY, platform: 'bluesky', identity: 'synthetic.bsky.social', proof }
    const batch = await results(await call(target, 'POST', '/verify', { claims: [claim] }, env))
    expect(batch[0]).toMatchObject({ platform: 'bluesky', identity: 'synthetic.bsky.social', verified: true })
    expectAppShape(batch[0])
    // A rejected claim is a 400 on the single endpoint; this one is answered.
    const single = await call(target, 'POST', '/verify/single', claim, env)
    expect(single.status).toBe(200)
    expect(await single.json()).toMatchObject({ verified: true })
  })

  // mobile 1.0.24-1.0.27 (same files as T1.2): a definite no drops the badge, so a handle lookup
  // Bluesky can't answer must not turn a signed-in claim into one.
  it('T1.4 keeps a signed-in Bluesky claim verified when Bluesky cannot be asked', async () => {
    const { env } = verifyEnv()
    await seedBlueskySignIn(env, 'synthetic.bsky.social', 'did:plc:syntheticlinked')
    // The environment's fetch throws on every request.
    const batch = await results(await call(target, 'POST', '/verify', {
      claims: [{ pubkey: PUBKEY, platform: 'bluesky', identity: 'synthetic.bsky.social', proof: '' }],
    }, env))
    expect(batch[0]).toMatchObject({ platform: 'bluesky', identity: 'synthetic.bsky.social', verified: true })
    expectAppShape(batch[0])
  })

  // mobile 1.0.24 identity_claims_repository.dart and 1.0.25-1.0.27 verification_result.dart: code
  // temporarily_unavailable makes a batch result inconclusive; without it, verified false is a
  // confirmed negative the app records.
  it('T1.6 answers a platform outage in the batch as temporarily_unavailable and not verified', async () => {
    const { env } = adapter.env()
    platformDown()
    const out = await results(await call(target, 'POST', '/verify', {
      claims: [{ pubkey: PUBKEY, platform: 'github', identity: 'synthetic-user', proof: 'abc123' }],
    }, env))
    expect(out[0]).toMatchObject({ verified: false, code: 'temporarily_unavailable' })
    expectAppShape(out[0])
  })
})

for (const path of ['/verify/single', '/api/verify']) {
  // mobile 1.0.24-1.0.27 verifier_client.dart (single) and divine-web useExternalIdentities.ts
  // (/api/verify): flat { platform, identity, proof, pubkey } in, one result out.
  describe(`POST ${path}`, () => {
    const claim = { platform: 'github', identity: 'synthetic-user', proof: 'abc123', pubkey: PUBKEY }

    // mobile 1.0.24-1.0.27 verification_result.dart: the same hard casts as a batch result.
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

    // mobile 1.0.24-1.0.27 verify_connect_cubit.dart and web useExternalIdentities.ts both branch on this exact string.
    it('T1.6 answers a platform outage as temporarily_unavailable and not verified', async () => {
      const { env } = adapter.env()
      platformDown()
      const response = await call(target, 'POST', path, claim, env)
      expect(response.status).toBe(200)
      const result = await response.json() as Record<string, unknown>
      expect(result).toMatchObject({ verified: false, code: 'temporarily_unavailable' })
      expectAppShape(result)
    })

    // mobile 1.0.26-1.0.27 verify_connect_cubit.dart: verified true is the connect flow's success, and the
    // app then publishes canonical_identity ?? identity. web LinkedAccounts.tsx: a truthy
    // verified shows the badge.
    describe('T1.8 answers a verified claim as verified, with an identity the app can publish', () => {
      const cases: [string, (env: TargetEnv) => Promise<void>, Record<string, string>, string][] = [
        [
          'a Twitter sign-in sent with a leading @ publishes the handle without it',
          env => adapter.seedSignIn(env, { platform: 'twitter', identity: 'Synthetic-User', pubkey: PUBKEY }),
          { platform: 'twitter', identity: '@Synthetic-User', proof: 'oauth', pubkey: PUBKEY },
          'Synthetic-User',
        ],
        [
          'a Bluesky sign-in publishes the handle, not a DID',
          env => adapter.seedSignIn(env, { platform: 'bluesky', identity: 'synthetic.bsky.social', pubkey: PUBKEY }),
          { platform: 'bluesky', identity: 'synthetic.bsky.social', proof: '', pubkey: PUBKEY },
          'synthetic.bsky.social',
        ],
        [
          'a proof post checked earlier publishes the identity as sent',
          env => adapter.seedCachedVerified(env, { platform: 'github', identity: 'synthetic-user', proof: 'abc123', pubkey: PUBKEY }),
          { platform: 'github', identity: 'synthetic-user', proof: 'abc123', pubkey: PUBKEY },
          'synthetic-user',
        ],
      ]
      it.each(cases)('%s', async (_name, seed, sent, published) => {
        const { env } = verifyEnv()
        await seed(env)
        const response = await call(target, 'POST', path, sent, env)
        expect(response.status).toBe(200)
        const result = await response.json() as Record<string, unknown>
        expectAppShape(result)
        expect(result).toMatchObject({ verified: true, identity: sent.identity })
        expect(result.canonical_identity ?? result.identity).toBe(published)
      })
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

// mobile 1.0.24-1.0.27 verify_rejection.dart: these codes from /verify/single pick the
// message the app shows; any other code shows a generic rejection.
describe('POST /verify/single Discord rejections', () => {
  const USER = 'synthetic-user'
  const CHANNEL = '222222222222222222'
  const MESSAGE = '333333333333333333'
  const MESSAGE_LINK = `https://discord.com/channels/111111111111111111/${CHANNEL}/${MESSAGE}`
  const NPUB = bech32.encode('npub', bech32.toWords(hexToBytes(PUBKEY)))

  function discordAnswers(status: number, body: unknown) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url !== `https://discord.com/api/v10/channels/${CHANNEL}/messages/${MESSAGE}`) {
        throw new Error(`Unexpected platform fetch: ${url}`)
      }
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }))
  }

  const cases: [string, string, (() => void) | null][] = [
    ['discord_dm_link', `https://discord.com/channels/@me/${CHANNEL}/${MESSAGE}`, null],
    ['discord_channel_link', `https://discord.com/channels/111111111111111111/${CHANNEL}`, null],
    ['discord_message_not_found', MESSAGE_LINK, () => discordAnswers(404, { code: 10008, message: 'Unknown Message' })],
    ['discord_bot_no_access', MESSAGE_LINK, () => discordAnswers(403, { code: 50001, message: 'Missing Access' })],
    ['discord_author_mismatch', MESSAGE_LINK, () => discordAnswers(200, { author: { username: 'someone-else' }, content: NPUB })],
    ['discord_message_content_unavailable', MESSAGE_LINK, () => discordAnswers(200, { author: { username: USER }, content: '' })],
    ['discord_npub_not_in_message', MESSAGE_LINK, () => discordAnswers(200, { author: { username: USER }, content: 'no key here' })],
  ]
  it.each(cases)('T1.9 answers %s', async (code, proof, stub) => {
    const { env } = adapter.env({ DISCORD_BOT_TOKEN: 'synthetic-token' })
    stub?.()
    const response = await call(target, 'POST', '/verify/single', { platform: 'discord', identity: USER, proof, pubkey: PUBKEY }, env)
    expect(response.status).toBe(200)
    const result = await response.json() as Record<string, unknown>
    expectAppShape(result)
    expect(result).toMatchObject({ verified: false, code })
  })
})
