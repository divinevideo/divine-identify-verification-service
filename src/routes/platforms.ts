import { Hono } from 'hono'
import type { Bindings } from '../types'
import { getPlatformInfo } from '../platforms/registry'

const platforms = new Hono<{ Bindings: Bindings }>()

platforms.get('/', (c) => {
  return c.json({ platforms: getPlatformInfo({
    youtubeEnabled: !!c.env.YOUTUBE_API_KEY,
    tiktokEnabled: true, // TikTok oEmbed is public
    discordEnabled: !!c.env.DISCORD_BOT_TOKEN,
  }) })
})

export default platforms
