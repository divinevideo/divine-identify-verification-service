import { Hono } from 'hono'
import type { Bindings } from '../types'
import { getPlatformInfo } from '../platforms/registry'

const platforms = new Hono<{ Bindings: Bindings }>()

platforms.get('/', (c) => {
  return c.json({ platforms: getPlatformInfo({
    youtubeEnabled: !!c.env.YOUTUBE_API_KEY,
    // TODO(#38): Enable after production OAuth credentials pass an end-to-end check.
    tiktokOAuthEnabled: c.env.TIKTOK_OAUTH_ENABLED === 'true',
    tiktokFlowConfigured: !!c.env.TIKTOK_CLIENT_KEY && !!c.env.TIKTOK_CLIENT_SECRET && !!c.env.OAUTH_REDIRECT_BASE,
    discordEnabled: !!c.env.DISCORD_BOT_TOKEN,
  }) })
})

export default platforms
