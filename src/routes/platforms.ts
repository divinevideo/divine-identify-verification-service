import { Hono } from 'hono'
import type { Bindings } from '../types'
import { getPlatformInfo } from '../platforms/registry'
import { isTikTokOAuthUsable } from '../oauth/tiktok'
import { isTwitterOAuthUsable } from '../oauth/twitter'
import { isBlueskyOAuthUsable } from '../oauth/bluesky'
import { isYouTubeOAuthUsable } from '../oauth/youtube'

const platforms = new Hono<{ Bindings: Bindings }>()

platforms.get('/', (c) => {
  return c.json({ platforms: getPlatformInfo({
    youtubeEnabled: !!c.env.YOUTUBE_API_KEY,
    discordEnabled: !!c.env.DISCORD_BOT_TOKEN,
    oauthAvailable: {
      twitter: isTwitterOAuthUsable(c.env),
      bluesky: isBlueskyOAuthUsable(c.env),
      youtube: isYouTubeOAuthUsable(c.env),
      // Without the sandbox-review cookie: /platforms has no request-scoped
      // review session to read it from, so it reports the state that applies
      // to everyone else.
      // Off until TIKTOK_OAUTH_ENABLED is set, once production OAuth
      // credentials pass an end-to-end check (#39).
      tiktok: isTikTokOAuthUsable(c.env),
    },
  }) })
})

export default platforms
