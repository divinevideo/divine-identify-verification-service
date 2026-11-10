// ABOUTME: The grammar of a YouTube channel identity: a channel id or a handle.
// ABOUTME: Pure: never fetches. Links are tidied elsewhere before they reach this.

export const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/

// A handle: letters and digits in any script, plus _ - . and the middle dot
// (support.google.com/youtube/answer/11585688).
const HANDLE_NAME = /^[\p{L}\p{M}\p{N}_.·-]+$/u

export type YouTubeIdentity =
  | { kind: 'channel'; channelId: string }
  | { kind: 'handle'; handle: string }

// An exact channel id wins, so a name that merely starts with UC stays a handle.
export function parseYouTubeIdentity(identity: string): YouTubeIdentity | null {
  if (YOUTUBE_CHANNEL_ID.test(identity)) return { kind: 'channel', channelId: identity }
  const name = identity.startsWith('@') ? identity.slice(1) : identity
  return HANDLE_NAME.test(name) ? { kind: 'handle', handle: `@${name}` } : null
}
