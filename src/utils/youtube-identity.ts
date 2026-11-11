// ABOUTME: The grammar of a YouTube channel identity: a channel id or a handle.
// ABOUTME: Pure: never fetches. Links are tidied elsewhere before they reach this.

export const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/

// A handle: letters and digits in any script, plus _ - . and the middle dot,
// which can't start or end it (support.google.com/youtube/answer/11585688).
// Combining marks may follow only a letter or digit, so a decomposed accent can
// end a handle but can't hide a separator at its end.
// Length isn't checked here: YouTube's limits on it differ by script.
const HANDLE_NAME = /^[\p{L}\p{N}]\p{M}*(?:[_.·-]*[\p{L}\p{N}]\p{M}*)*$/u

// Folds A to Z only. YouTube documents handles as case-insensitive, but full
// Unicode lowercasing can turn different handles into one, such as the Kelvin
// sign into a k. The handle lookup cache and the sign-in check both use this.
export function foldYouTubeHandleCase(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

export type YouTubeIdentity =
  | { kind: 'channel'; channelId: string }
  | { kind: 'handle'; handle: string }

// An exact channel id wins, so a name that merely starts with UC stays a handle.
export function parseYouTubeIdentity(identity: string): YouTubeIdentity | null {
  if (YOUTUBE_CHANNEL_ID.test(identity)) return { kind: 'channel', channelId: identity }
  const name = identity.startsWith('@') ? identity.slice(1) : identity
  return HANDLE_NAME.test(name) ? { kind: 'handle', handle: `@${name}` } : null
}
