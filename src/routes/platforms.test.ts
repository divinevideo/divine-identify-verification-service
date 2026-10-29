// ABOUTME: Tests that GET /platforms reports each platform's supported and oauth
// ABOUTME: flags honestly, such as Discord needing its bot token and TikTok sign-in staying off until enabled.
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { Bindings } from '../types'
import platforms from './platforms'

const app = new Hono<{ Bindings: Bindings }>()
app.route('/platforms', platforms)

type PlatformsBody = { platforms: Record<string, { label: string; supported: boolean; oauth?: boolean }> }

async function fetchPlatforms(env: Partial<Bindings>): Promise<PlatformsBody> {
  const response = await app.request('/platforms', {}, env as Bindings)
  expect(response.status).toBe(200)
  return (await response.json()) as PlatformsBody
}

// Every setting each sign-in platform's start step needs: Twitter, Google
// (YouTube), TikTok production credentials, and the shared redirect base
// Bluesky's start step also relies on.
const ALL_OAUTH_CONFIGURED: Partial<Bindings> = {
  YOUTUBE_API_KEY: 'yt-key',
  OAUTH_REDIRECT_BASE: 'https://verify.example',
  TWITTER_CLIENT_ID: 'twitter-id',
  TWITTER_CLIENT_SECRET: 'twitter-secret',
  GOOGLE_CLIENT_ID: 'google-id',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  TIKTOK_CLIENT_KEY: 'prod-key',
  TIKTOK_CLIENT_SECRET: 'prod-secret',
  TIKTOK_OAUTH_ENABLED: 'true',
}

describe('GET /platforms', () => {
  it('reports discord unsupported until the bot token is configured', async () => {
    const body = await fetchPlatforms({})
    expect(body.platforms.discord).toMatchObject({ label: 'Discord', supported: false })
  })

  it('reports discord supported once the bot token is configured', async () => {
    const body = await fetchPlatforms({ DISCORD_BOT_TOKEN: 'bot-token' })
    expect(body.platforms.discord).toMatchObject({ label: 'Discord', supported: true })
  })

  // TikTok proof posts use TikTok's public oEmbed and need no credentials, so
  // TikTok is supported in every configuration (#63). Only its sign-in waits
  // for production approval (#39), which `oauth` reports. A sandbox key is
  // indistinguishable from a production one by inspection, so the enable flag
  // is the operator's production signal. The flow still needs both credentials
  // and a redirect base: startTikTokOAuth 503s without OAUTH_REDIRECT_BASE, so
  // sign-in would otherwise advertise as available yet fail on start.
  const tiktokSignIn: Partial<Bindings> = {
    TIKTOK_OAUTH_ENABLED: 'true',
    TIKTOK_CLIENT_KEY: 'prod-key',
    TIKTOK_CLIENT_SECRET: 'prod-secret',
    OAUTH_REDIRECT_BASE: 'https://verify.example',
  }

  it.each<[string, Partial<Bindings>, boolean]>([
    ['with sign-in off when nothing is configured', {}, false],
    ['with sign-in on once production OAuth is enabled and the flow is fully configured', tiktokSignIn, true],
    ['with sign-in off when enabled but the client credentials are missing', { TIKTOK_OAUTH_ENABLED: 'true' }, false],
    ['with sign-in off when enabled with credentials but no redirect base', { ...tiktokSignIn, OAUTH_REDIRECT_BASE: undefined }, false],
    // The flow is otherwise fully configured, so these isolate the enable flag,
    // the main gate keeping TikTok sign-in hidden. Only "true" turns it on.
    ['with sign-in off when credentials are present but TIKTOK_OAUTH_ENABLED is unset', { ...tiktokSignIn, TIKTOK_OAUTH_ENABLED: undefined }, false],
    ['with sign-in off when credentials are present but TIKTOK_OAUTH_ENABLED is "false", as wrangler.toml deploys it', { ...tiktokSignIn, TIKTOK_OAUTH_ENABLED: 'false' }, false],
  ])('reports TikTok supported %s', async (_label, env, oauth) => {
    const body = await fetchPlatforms(env)
    expect(body.platforms.tiktok).toEqual({ label: 'TikTok', supported: true, oauth })
  })

  it('keeps the unauthenticated proof-post platforms supported with no configuration', async () => {
    const body = await fetchPlatforms({})
    for (const key of ['github', 'twitter', 'mastodon', 'telegram', 'bluesky', 'tiktok']) {
      expect(body.platforms[key]).toMatchObject({ supported: true })
    }
  })

  describe('oauth: whether sign-in is set up', () => {
    it('reports oauth true for every sign-in platform once all credentials are configured', async () => {
      const body = await fetchPlatforms(ALL_OAUTH_CONFIGURED)
      expect(body.platforms.twitter).toMatchObject({ oauth: true })
      expect(body.platforms.bluesky).toMatchObject({ oauth: true })
      expect(body.platforms.youtube).toMatchObject({ oauth: true })
      expect(body.platforms.tiktok).toMatchObject({ oauth: true })
    })

    it('reports oauth false for every sign-in platform with no configuration', async () => {
      const body = await fetchPlatforms({ YOUTUBE_API_KEY: 'yt-key' }) // keep youtube listed so its oauth:false is observable
      expect(body.platforms.twitter).toMatchObject({ oauth: false })
      expect(body.platforms.bluesky).toMatchObject({ oauth: false })
      expect(body.platforms.youtube).toMatchObject({ oauth: false })
      expect(body.platforms.tiktok).toMatchObject({ oauth: false })
    })

    it('does not add an oauth key for platforms with no sign-in path', async () => {
      const body = await fetchPlatforms({ ...ALL_OAUTH_CONFIGURED, DISCORD_BOT_TOKEN: 'bot-token' })
      for (const key of ['github', 'mastodon', 'telegram', 'discord']) {
        expect(body.platforms[key]).not.toHaveProperty('oauth')
      }
    })

    it('leaves youtube out entirely, so no oauth key either, when YOUTUBE_API_KEY is unset', async () => {
      const body = await fetchPlatforms({
        GOOGLE_CLIENT_ID: 'google-id',
        GOOGLE_CLIENT_SECRET: 'google-secret',
        OAUTH_REDIRECT_BASE: 'https://verify.example',
      })
      expect(body.platforms.youtube).toBeUndefined()
    })

    it('does not change the existing supported values when oauth is added', async () => {
      const body = await fetchPlatforms(ALL_OAUTH_CONFIGURED)
      expect(body.platforms.github).toMatchObject({ supported: true })
      expect(body.platforms.twitter).toMatchObject({ supported: true })
      expect(body.platforms.mastodon).toMatchObject({ supported: true })
      expect(body.platforms.telegram).toMatchObject({ supported: true })
      expect(body.platforms.bluesky).toMatchObject({ supported: true })
      expect(body.platforms.youtube).toMatchObject({ supported: true })
      expect(body.platforms.tiktok).toMatchObject({ supported: true })
      expect(body.platforms.discord).toMatchObject({ supported: false })
    })

    it('keeps youtube oauth false when GOOGLE_CLIENT_SECRET alone is missing', async () => {
      const body = await fetchPlatforms({
        YOUTUBE_API_KEY: 'yt-key',
        GOOGLE_CLIENT_ID: 'google-id',
        OAUTH_REDIRECT_BASE: 'https://verify.example',
      })
      expect(body.platforms.youtube).toMatchObject({ oauth: false })
    })

    it('keeps bluesky oauth false when OAUTH_REDIRECT_BASE is missing, even with other credentials set', async () => {
      const body = await fetchPlatforms({
        TWITTER_CLIENT_ID: 'twitter-id',
        TWITTER_CLIENT_SECRET: 'twitter-secret',
      })
      expect(body.platforms.bluesky).toMatchObject({ oauth: false })
    })
  })
})
