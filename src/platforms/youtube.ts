import { fetchFromPlatform, PlatformUnavailableError, readJson, throwIfUnanswered, type PlatformVerifier } from './base'
import { parseYouTubeIdentity } from '../utils/youtube-identity'
import { lookUpYouTubeHandle } from './youtube-handle'

interface YouTubeVideoSnippet {
  snippet?: {
    channelId?: string
    description?: string
    channelTitle?: string
  }
}

interface YouTubeVideoResponse {
  items?: YouTubeVideoSnippet[]
}

export class YouTubeVerifier implements PlatformVerifier {
  readonly name = 'youtube'
  readonly label = 'YouTube'
  private apiKey?: string
  private cache?: KVNamespace

  constructor(apiKey?: string, cache?: KVNamespace) {
    this.apiKey = apiKey
    this.cache = cache
  }

  async verify(identity: string, proof: string, npub: string): Promise<{ verified: boolean; error?: string }> {
    // Validate video ID format (11 chars, alphanumeric + - _)
    if (!/^[a-zA-Z0-9_-]{11}$/.test(proof)) {
      return { verified: false, error: 'Invalid YouTube video ID format' }
    }

    // Only a channel id or a handle names a channel; anything else is refused before YouTube is asked.
    const parsed = parseYouTubeIdentity(identity)
    if (!parsed) {
      return {
        verified: false,
        error: "Invalid YouTube channel. Use the channel's @handle or its channel ID (UC followed by 22 characters).",
      }
    }

    if (!this.apiKey) {
      return { verified: false, error: 'YouTube API key not configured' }
    }

    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(proof)}&key=${encodeURIComponent(this.apiKey)}`

    const response = await fetchFromPlatform(this.label, url, {
      headers: { 'Accept': 'application/json' },
    })

    throwIfUnanswered(response, this.label)
    if (!response.ok) {
      return { verified: false, error: `YouTube API error: ${response.status}` }
    }

    const data = await readJson<YouTubeVideoResponse>(response, this.label)
    if (data === undefined) {
      return { verified: false, error: 'Invalid JSON response from YouTube API' }
    }

    if (!data.items || data.items.length === 0) {
      return { verified: false, error: 'Video not found' }
    }

    const snippet = data.items[0].snippet
    if (!snippet) {
      return { verified: false, error: 'Video snippet not available' }
    }

    const channelId = snippet.channelId || ''
    if (!channelId) {
      return { verified: false, error: 'Unable to determine video channel' }
    }

    const MISMATCH = 'Video channel does not match claimed identity'
    if (parsed.kind === 'channel' && channelId !== parsed.channelId) {
      return { verified: false, error: MISMATCH }
    }

    // The handle is resolved only after the npub is found: a claim whose video
    // doesn't carry the npub then costs one API quota unit (the video fetch), not two.
    const description = snippet.description || ''
    if (!description.includes(npub)) {
      return { verified: false, error: 'npub not found in video description' }
    }
    if (parsed.kind === 'channel') {
      return { verified: true }
    }

    const lookup = await lookUpYouTubeHandle({ CACHE_KV: this.cache, YOUTUBE_API_KEY: this.apiKey }, parsed.handle)
    if (lookup === null) {
      throw new PlatformUnavailableError("YouTube handle lookup didn't answer")
    }
    if ('notFound' in lookup) {
      return { verified: false, error: 'YouTube handle not found' }
    }
    return lookup.channelId === channelId ? { verified: true } : { verified: false, error: MISMATCH }
  }
}
