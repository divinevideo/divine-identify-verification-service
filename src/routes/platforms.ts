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
      // Checked without the sandbox-review cookie on purpose: the app and the
      // other clients that call /platforms never hold it, so this is the
      // state everyone gets. Off until TIKTOK_OAUTH_ENABLED is "true" and the
      // key, secret and redirect base are set. Production keeps the flag
      // "false" until its credentials pass an end-to-end check (#39).
      tiktok: isTikTokOAuthUsable(c.env),
    },
  }) })
})

export default platforms
