import type { Bindings } from './types'
import { isTikTokOAuthUsable } from './oauth/tiktok'
import { isTwitterOAuthUsable } from './oauth/twitter'
import { isYouTubeOAuthUsable } from './oauth/youtube'

// What this deployment offers, as the landing page and /docs both need it.
// One function reads the environment, so the two pages can't disagree about
// which platforms and sign-in paths exist.
export interface PlatformFlags {
  hasYouTube: boolean
  hasTikTok: boolean
  twitterOAuthEnabled: boolean
  youtubeOAuthEnabled: boolean
  tiktokOAuthEnabled: boolean
}

export interface OAuthPlatform {
  value: string
  name: string
  shortLabel: string
  optionLabel: string
}

// Joins names the way the page's copy reads them: "A", "A and B", "A, B, and C".
export function listInProse(items: string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

export function platformFlags(env: Bindings, tiktokOAuthReviewEnabled: boolean): PlatformFlags {
  const hasYouTube = !!env.YOUTUBE_API_KEY
  return {
    hasYouTube,
    hasTikTok: true, // TikTok oEmbed is public, no key needed for proof verification
    // Twitter proof posts use the public oEmbed endpoint and need no
    // credentials; only sign-in does, so the page hides just that path.
    twitterOAuthEnabled: isTwitterOAuthUsable(env),
    // YouTube shows with its API key; its sign-in also needs the Google client
    // ID and secret and the redirect base (isYouTubeOAuthUsable).
    youtubeOAuthEnabled: hasYouTube && isYouTubeOAuthUsable(env),
    tiktokOAuthEnabled: isTikTokOAuthUsable(env, tiktokOAuthReviewEnabled),
  }
}

// Sign-in platforms, in picker order. Leaves out Twitter, YouTube and TikTok
// while their sign-in is unavailable. The picker and every list of sign-in
// platforms in the copy are built from this one list, so the copy never
// advertises a path the picker omits.
export function oauthPlatformsFor(flags: PlatformFlags): OAuthPlatform[] {
  return [
    ...(flags.twitterOAuthEnabled ? [{ value: 'twitter', name: 'Twitter', shortLabel: 'Twitter/X', optionLabel: 'Twitter / X' }] : []),
    { value: 'bluesky', name: 'Bluesky', shortLabel: 'Bluesky', optionLabel: 'Bluesky' },
    ...(flags.youtubeOAuthEnabled ? [{ value: 'youtube', name: 'YouTube', shortLabel: 'YouTube', optionLabel: 'YouTube' }] : []),
    ...(flags.hasTikTok && flags.tiktokOAuthEnabled ? [{ value: 'tiktok', name: 'TikTok', shortLabel: 'TikTok', optionLabel: 'TikTok' }] : []),
  ]
}
