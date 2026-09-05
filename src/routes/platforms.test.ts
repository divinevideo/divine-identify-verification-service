// ABOUTME: Tests that GET /platforms reports Discord support honestly.
// ABOUTME: Discord proof posts resolve a message through the bot API, so without
// ABOUTME: DISCORD_BOT_TOKEN there is no verification path — invites are refused.
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { Bindings } from '../types'
import platforms from './platforms'

const app = new Hono<{ Bindings: Bindings }>()
app.route('/platforms', platforms)

type PlatformsBody = { platforms: Record<string, { label: string; supported: boolean }> }

async function fetchPlatforms(env: Partial<Bindings>): Promise<PlatformsBody> {
  const response = await app.request('/platforms', {}, env as Bindings)
  expect(response.status).toBe(200)
  return (await response.json()) as PlatformsBody
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

  it('reports TikTok unsupported until production OAuth is enabled', async () => {
    const body = await fetchPlatforms({})
    expect(body.platforms.tiktok).toMatchObject({ label: 'TikTok', supported: false })
  })

  it('reports TikTok supported once production OAuth is enabled and the flow is fully configured', async () => {
    const body = await fetchPlatforms({
      TIKTOK_OAUTH_ENABLED: 'true',
      TIKTOK_CLIENT_KEY: 'prod-key',
      TIKTOK_CLIENT_SECRET: 'prod-secret',
      OAUTH_REDIRECT_BASE: 'https://verify.example',
    })
    expect(body.platforms.tiktok).toMatchObject({ label: 'TikTok', supported: true })
  })

  it('keeps TikTok unsupported when enabled but the client credentials are missing', async () => {
    // A sandbox key is indistinguishable from a production one by inspection, so the
    // enable flag is the operator's production signal, but supported must not advertise
    // a flow that would 503 for lack of a key/secret.
    const body = await fetchPlatforms({ TIKTOK_OAUTH_ENABLED: 'true' })
    expect(body.platforms.tiktok).toMatchObject({ label: 'TikTok', supported: false })
  })

  it('keeps TikTok unsupported when enabled with credentials but no redirect base', async () => {
    // startTikTokOAuth 503s without OAUTH_REDIRECT_BASE, so supported must fold it in
    // too, otherwise the flow would advertise as available yet 503 on start.
    const body = await fetchPlatforms({
      TIKTOK_OAUTH_ENABLED: 'true',
      TIKTOK_CLIENT_KEY: 'prod-key',
      TIKTOK_CLIENT_SECRET: 'prod-secret',
    })
    expect(body.platforms.tiktok).toMatchObject({ label: 'TikTok', supported: false })
  })

  it('keeps TikTok unsupported when credentials are present but production OAuth is not enabled', async () => {
    const body = await fetchPlatforms({
      TIKTOK_CLIENT_KEY: 'sandbox-key',
      TIKTOK_CLIENT_SECRET: 'sandbox-secret',
    })
    expect(body.platforms.tiktok).toMatchObject({ label: 'TikTok', supported: false })
  })

  it('keeps the unauthenticated proof-post platforms supported with no configuration', async () => {
    const body = await fetchPlatforms({})
    for (const key of ['github', 'twitter', 'mastodon', 'telegram', 'bluesky']) {
      expect(body.platforms[key]).toMatchObject({ supported: true })
    }
  })
})
