import type { PlatformVerifier } from './base'
import type { Platform, PlatformInfo } from '../types'
import { GitHubVerifier } from './github'
import { TwitterVerifier } from './twitter'
import { MastodonVerifier } from './mastodon'
import { TelegramVerifier } from './telegram'
import { BlueskyVerifier } from './bluesky'
import { DiscordVerifier } from './discord'

export function getVerifier(platform: Platform, githubToken?: string): PlatformVerifier {
  switch (platform) {
    case 'github': return new GitHubVerifier(githubToken)
    case 'twitter': return new TwitterVerifier()
    case 'mastodon': return new MastodonVerifier()
    case 'telegram': return new TelegramVerifier()
    case 'bluesky': return new BlueskyVerifier()
    case 'discord': return new DiscordVerifier()
    default: throw new Error(`Unknown platform: ${platform}`)
  }
}

export function getPlatformInfo(): Record<Platform, PlatformInfo> {
  return {
    github: { label: 'GitHub', supported: true },
    twitter: { label: 'Twitter / X', supported: true },
    mastodon: { label: 'Mastodon', supported: true },
    telegram: { label: 'Telegram', supported: true },
    bluesky: { label: 'Bluesky', supported: true },
    discord: { label: 'Discord', supported: true },
  }
}
