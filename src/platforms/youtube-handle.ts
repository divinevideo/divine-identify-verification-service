// ABOUTME: Resolves a YouTube handle to the channel it belongs to, via the YouTube Data API.
// ABOUTME: Remembers only the lookup, never a verified result, and never a failure.
import { YOUTUBE_CHANNEL_ID } from '../utils/youtube-identity'
import { discardBody, readJson } from './base'

// How long YouTube's answer to "which channel does this handle belong to" is
// reused. A handle its channel gives up is held for that channel for 14 days
// before anyone else can take it (support.google.com/youtube/answer/15920820),
// so a day-old answer still names the right channel. This module caches only
// the lookup; the verify route caches each claim's result on its own, and a
// verified proof post isn't checked against its video again for 24 hours.
const HANDLE_LOOKUP_TTL = 24 * 60 * 60
// A handle that doesn't exist yet may be claimed soon, so that answer is
// reused only for a few minutes. That helps a new claim of the handle; a claim
// already answered "YouTube handle not found" keeps that answer for the verify
// route's 15 minutes.
const HANDLE_NOT_FOUND_TTL = 5 * 60
const HANDLE_LOOKUP_TIMEOUT_MS = 3000

export type YouTubeHandleLookup = { channelId: string } | { notFound: true } | null

/** Bindings is assignable to this, so a caller holding the full `env` passes it directly. */
export interface YouTubeLookupEnv {
  CACHE_KV?: KVNamespace
  YOUTUBE_API_KEY?: string
}

const NOT_FOUND = 'not-found'

// Fold ASCII case only, because YouTube documents handles as case-insensitive
// and full Unicode lowercasing can turn different handles into one key.
const lookupKey = (name: string) => `yt_handle_channel:${name.replace(/[A-Z]/g, (c) => c.toLowerCase())}`

// Remembering a lookup only saves the next one, so a failed write never fails
// the check it was made for.
async function remember(cache: KVNamespace | undefined, key: string, value: string, ttl: number): Promise<void> {
  if (!cache) return
  try {
    await cache.put(key, value, { expirationTtl: ttl })
  } catch (err) {
    console.warn('YouTube handle lookup not cached:', err instanceof Error ? err.name : 'unknown')
  }
}

/**
 * The channel a handle belongs to. `null` means YouTube didn't answer usefully
 * (no key, unreachable, quota, unreadable answer); the caller decides what that
 * means. `handle` may carry a leading `@` or not. The caller checks the handle
 * grammar first; this does not reject `@` or `@@x` itself.
 */
export async function lookUpYouTubeHandle(env: YouTubeLookupEnv, handle: string): Promise<YouTubeHandleLookup> {
  const apiKey = env.YOUTUBE_API_KEY
  if (!apiKey) return null
  const name = handle.startsWith('@') ? handle.slice(1) : handle
  const key = lookupKey(name)

  try {
    const cached = await env.CACHE_KV?.get(key)
    if (cached === NOT_FOUND) return { notFound: true }
    if (cached && YOUTUBE_CHANNEL_ID.test(cached)) return { channelId: cached }
  } catch {
    // An unreadable cache is a miss.
  }

  let body: { items?: unknown } | undefined
  try {
    const url =
      'https://www.googleapis.com/youtube/v3/channels?part=id' +
      `&forHandle=${encodeURIComponent(`@${name}`)}&key=${encodeURIComponent(apiKey)}`
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(HANDLE_LOOKUP_TIMEOUT_MS),
    })
    if (resp.status !== 200) {
      void discardBody(resp)
      console.warn('YouTube handle lookup answered', resp.status)
      return null
    }
    body = await readJson<{ items?: unknown }>(resp, 'YouTube')
  } catch (err) {
    // Only the error's name: its message could carry the request URL, and the key is in it.
    console.warn('YouTube handle lookup failed:', err instanceof Error ? err.name : 'unknown')
    return null
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    console.warn('YouTube handle lookup answered with an unreadable body')
    return null
  }

  const items = body.items
  if (items === undefined || (Array.isArray(items) && items.length === 0)) {
    await remember(env.CACHE_KV, key, NOT_FOUND, HANDLE_NOT_FOUND_TTL)
    return { notFound: true }
  }
  const id = Array.isArray(items) ? (items[0] as { id?: unknown } | null)?.id : undefined
  if (typeof id !== 'string' || !YOUTUBE_CHANNEL_ID.test(id)) {
    console.warn('YouTube handle lookup answered with an unexpected shape')
    return null
  }
  await remember(env.CACHE_KV, key, id, HANDLE_LOOKUP_TTL)
  return { channelId: id }
}
