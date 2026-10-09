import type { PlatformVerifier } from './base'
import type { Platform, PlatformInfo } from '../types'
import { GitHubVerifier } from './github'
import { TwitterVerifier } from './twitter'
import { MastodonVerifier } from './mastodon'
import { TelegramVerifier } from './telegram'
import { BlueskyVerifier } from './bluesky'
import { DiscordVerifier } from './discord'
import { YouTubeVerifier } from './youtube'
import { TikTokVerifier } from './tiktok'

export function getVerifier(platform: Platform, githubToken?: string, youtubeApiKey?: string, discordBotToken?: string, discordVerifyChannelId?: string): PlatformVerifier {
  switch (platform) {
    case 'github': return new GitHubVerifier(githubToken)
    case 'twitter': return new TwitterVerifier()
    case 'mastodon': return new MastodonVerifier()
    case 'telegram': return new TelegramVerifier()
    case 'bluesky': return new BlueskyVerifier()
    case 'discord': return new DiscordVerifier(discordBotToken, discordVerifyChannelId)
    case 'youtube': return new YouTubeVerifier(youtubeApiKey)
    case 'tiktok': return new TikTokVerifier()
    default: throw new Error(`Unknown platform: ${platform}`)
  }
}

export function getPlatformInfo(opts?: {
  youtubeEnabled?: boolean
  tiktokOAuthAvailable?: boolean
  discordEnabled?: boolean
  // Whether sign-in (OAuth) is set up for each sign-in platform, matching
  // what /auth/:platform/start would do. Only read for twitter, bluesky,
  // youtube and tiktok; other platforms have no sign-in path.
  oauthAvailable?: { twitter?: boolean; bluesky?: boolean; youtube?: boolean; tiktok?: boolean }
}): Record<string, PlatformInfo> {
  const platforms: Record<string, PlatformInfo> = {
    github: { label: 'GitHub', supported: true },
    twitter: { label: 'Twitter / X', supported: true, oauth: !!opts?.oauthAvailable?.twitter },
    mastodon: { label: 'Mastodon', supported: true },
    telegram: { label: 'Telegram', supported: true },
    bluesky: { label: 'Bluesky', supported: true, oauth: !!opts?.oauthAvailable?.bluesky },
    // Discord resolves the proof message through the bot API; a server invite cannot
    // bind an account, so without the bot token there is no verification path.
    discord: { label: 'Discord', supported: !!opts?.discordEnabled },
  }
  if (opts?.youtubeEnabled) {
    platforms.youtube = { label: 'YouTube', supported: true, oauth: !!opts?.oauthAvailable?.youtube }
  }
  platforms.tiktok = { label: 'TikTok', supported: !!opts?.tiktokOAuthAvailable, oauth: !!opts?.oauthAvailable?.tiktok }
  return platforms
}
