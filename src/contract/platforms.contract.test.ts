// ABOUTME: Pins the GET /platforms list the Divine app reads to decide which platforms
// ABOUTME: it offers and where sign-in is shown, so a change cannot silently break it.
import { describe, expect, it } from 'vitest'
import { adapter } from './adapter'
import { call, type ContractConfig } from './harness'
import { SIGNIN_SETUPS, type SignInPlatform } from './signin-driver'

const target = adapter.target

type Entry = Record<string, unknown>

async function platformsFor(overrides: ContractConfig = {}): Promise<Record<string, Entry>> {
  const { env } = adapter.env(overrides)
  const response = await call(target, 'GET', '/platforms', undefined, env)
  expect(response.status).toBe(200)
  const body = await response.json() as { platforms: Record<string, Entry> }
  return body.platforms
}

// T2.5: the app ignores other fields, so additive keys (such as signin_expires_after_days) are
// allowed. Every test here reads named fields only and never asserts an exact key set.
describe('GET /platforms (mobile verifier_platform.dart)', () => {
  // mobile 1.0.26 verifier_platform.dart: platforms is a map of maps (a non-object value
  // throws for the whole list); label is String?, supported is bool?, oauth is bool (else treated as absent).
  it('T2.1 returns a map of entries with a string label, boolean supported and optional boolean oauth', async () => {
    const platforms = await platformsFor()
    expect(platforms !== null && typeof platforms === 'object' && !Array.isArray(platforms)).toBe(true)
    expect(Object.keys(platforms).length).toBeGreaterThan(0)
    for (const entry of Object.values(platforms)) {
      expect(entry !== null && typeof entry === 'object' && !Array.isArray(entry)).toBe(true)
      expect(typeof entry.label).toBe('string')
      expect(typeof entry.supported).toBe('boolean')
      if ('oauth' in entry) expect(typeof entry.oauth).toBe('boolean')
    }
  })

  // mobile 1.0.26 verify_state.dart: platform keys are NIP-39 names, so twitter, never x.
  it('T2.2 lists the platforms the app knows by their NIP-39 keys', async () => {
    const platforms = await platformsFor()
    for (const key of ['twitter', 'bluesky', 'github', 'mastodon', 'telegram', 'discord', 'tiktok']) {
      expect(Object.keys(platforms)).toContain(key)
    }
    expect(Object.keys(await platformsFor({ YOUTUBE_API_KEY: 'synthetic-key' }))).toContain('youtube')
    expect(Object.keys(platforms)).not.toContain('x')
  })

  // mobile 1.0.26 identity_claims_repository.dart: the app defaults a missing supported to false
  // and drops unsupported entries from its list, so the platforms it shows must be true.
  it('T2.6 reports supported true for the platforms the app shows', async () => {
    const platforms = await platformsFor({ YOUTUBE_API_KEY: 'synthetic-key', DISCORD_BOT_TOKEN: 'synthetic-token' })
    for (const key of ['github', 'twitter', 'mastodon', 'telegram', 'bluesky', 'discord', 'youtube']) {
      expect(platforms[key]?.supported, `${key} supported`).toBe(true)
    }
    // Discord has no verification path without its bot token, so it is a boolean, not pinned true.
    expect(typeof (await platformsFor()).discord.supported).toBe('boolean')
    // TikTok reports false until its sign-in is set up; #156 makes it always true, and this
    // can tighten to true once that lands.
    expect(typeof platforms.tiktok?.supported).toBe('boolean')
  })

  // mobile 1.0.26 verifier_platform.dart: oauth true is what shows the sign-in button, and
  // false hides it. The setups are the ones start answers 200 and 503 for
  // (signin.contract.test.ts T3.1 and T3.2), so the two endpoints agree.
  describe('T2.7 reports oauth as whether the platform sign-in is on', () => {
    it.each(Object.keys(SIGNIN_SETUPS) as SignInPlatform[])('%s', async (platform) => {
      expect((await platformsFor(SIGNIN_SETUPS[platform].on))[platform]?.oauth, 'on').toBe(true)
      expect((await platformsFor(SIGNIN_SETUPS[platform].off))[platform]?.oauth, 'off').toBe(false)
    })
  })

  // mobile 1.0.26 verifier_platform.dart: a missing oauth reads as "sign-in available",
  // so every sign-in platform must state it explicitly, in both configured and unconfigured setups.
  it('T2.3 gives every sign-in platform a boolean oauth', async () => {
    const setups: ContractConfig[] = [
      {},
      { YOUTUBE_API_KEY: 'synthetic-key' },
    ]
    for (const overrides of setups) {
      const platforms = await platformsFor(overrides)
      for (const key of ['twitter', 'bluesky', 'tiktok']) {
        expect(typeof platforms[key]?.oauth, `${key} oauth`).toBe('boolean')
      }
      if (overrides.YOUTUBE_API_KEY) expect(typeof platforms.youtube?.oauth, 'youtube oauth').toBe('boolean')
    }
  })

  // mobile 1.0.26 identity_claims_repository.dart: an unlisted youtube gets no sign-in
  // and is not shown, so listing it must follow the API key.
  it('T2.4 lists youtube only when the YouTube API key is set', async () => {
    expect(Object.keys(await platformsFor())).not.toContain('youtube')
    const withKey = await platformsFor({ YOUTUBE_API_KEY: 'synthetic-key' })
    expect(Object.keys(withKey)).toContain('youtube')
    expect(withKey.youtube.supported).toBe(true)
  })
})
