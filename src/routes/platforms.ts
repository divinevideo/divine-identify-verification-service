import { Hono } from 'hono'
import type { Bindings } from '../types'
import { getPlatformInfo } from '../platforms/registry'
import { isTikTokOAuthUsable } from '../oauth/tiktok'

const platforms = new Hono<{ Bindings: Bindings }>()

platforms.get('/', (c) => {
  return c.json({ platforms: getPlatformInfo({
    youtubeEnabled: !!c.env.YOUTUBE_API_KEY,
    // TODO(#39): Enable after production OAuth credentials pass an end-to-end check.
    tiktokOAuthAvailable: isTikTokOAuthUsable(c.env),
    discordEnabled: !!c.env.DISCORD_BOT_TOKEN,
  }) })
})

export default platforms
