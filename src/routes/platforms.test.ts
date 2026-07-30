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

  it('keeps the unauthenticated proof-post platforms supported with no configuration', async () => {
    const body = await fetchPlatforms({})
    for (const key of ['github', 'twitter', 'mastodon', 'telegram', 'bluesky']) {
      expect(body.platforms[key]).toMatchObject({ supported: true })
    }
  })
})
