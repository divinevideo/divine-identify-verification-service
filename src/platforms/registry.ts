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

export function getPlatformInfo(opts?: { youtubeEnabled?: boolean; tiktokOAuthEnabled?: boolean; tiktokFlowConfigured?: boolean; discordEnabled?: boolean }): Record<string, PlatformInfo> {
  const platforms: Record<string, PlatformInfo> = {
    github: { label: 'GitHub', supported: true },
    twitter: { label: 'Twitter / X', supported: true },
    mastodon: { label: 'Mastodon', supported: true },
    telegram: { label: 'Telegram', supported: true },
    bluesky: { label: 'Bluesky', supported: true },
    // Discord resolves the proof message through the bot API; a server invite cannot
    // bind an account, so without the bot token there is no verification path.
    discord: { label: 'Discord', supported: !!opts?.discordEnabled },
  }
  if (opts?.youtubeEnabled) {
    platforms.youtube = { label: 'YouTube', supported: true }
  }
  // TikTok is advertised only when the operator has confirmed production OAuth is live
  // (TIKTOK_OAUTH_ENABLED) AND the flow is fully configured. A sandbox key is
  // indistinguishable from a production key by inspection, so the explicit flag is the
  // only reliable "production is live" signal; requiring the flow to be fully configured
  // (client key + secret + redirect base, everything startTikTokOAuth needs) keeps
  // supported from ever advertising a flow that would 503 for missing config.
  platforms.tiktok = { label: 'TikTok', supported: !!opts?.tiktokOAuthEnabled && !!opts?.tiktokFlowConfigured }
  return platforms
}
