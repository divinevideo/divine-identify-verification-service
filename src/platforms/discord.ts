import type { PlatformVerifier } from './base'

interface DiscordMessageResponse {
  id: string
  content: string
  author: {
    id: string
    username: string
    global_name: string | null
  }
  channel_id: string
}

type ProofType =
  | { kind: 'message_url'; channelId: string; messageId: string }
  | { kind: 'message_id'; messageId: string }
  | { kind: 'channel_url' }
  | { kind: 'invite'; code: string }

// Every host Discord's own clients hand a user on "Copy Message Link". The
// Canary and PTB builds use their own subdomains, and links shared before the
// rename still carry discordapp.com; all of them serve the same message.
const MESSAGE_LINK_HOSTS = new Set([
  'discord.com',
  'www.discord.com',
  'canary.discord.com',
  'ptb.discord.com',
  'discordapp.com',
  'www.discordapp.com',
  'canary.discordapp.com',
  'ptb.discordapp.com',
])

// Parsed rather than matched with one anchored pattern: parsing normalises the
// trailing slash, discards the query and fragment, and lower-cases the host —
// each of which the previous regex treated as an unrecognisable proof.
function parseDiscordUrl(proof: string): ProofType | null {
  let url: URL
  try {
    url = new URL(proof)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!MESSAGE_LINK_HOSTS.has(url.hostname.toLowerCase())) return null

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] !== 'channels') return null

  const isId = (segment: string) => /^\d+$/.test(segment)

  if (segments.length === 4) {
    const [, guildId, channelId, messageId] = segments
    // A DM link spells the guild `@me`. The bot is not in that conversation, so
    // the fetch could only 404 — refusing here can say why.
    if (!isId(guildId) || !isId(channelId) || !isId(messageId)) return null
    return { kind: 'message_url', channelId, messageId }
  }

  // `channels/{guild}/{channel}` is the channel itself, which is the single
  // easiest thing to copy by mistake, so it earns its own answer.
  if (segments.length === 3 && isId(segments[1]) && isId(segments[2])) {
    return { kind: 'channel_url' }
  }

  return null
}

function parseProof(proof: string, configuredChannelId?: string): ProofType | null {
  const trimmed = proof.trim()

  const fromUrl = parseDiscordUrl(trimmed)
  if (fromUrl) return fromUrl

  // Pure numeric snowflake ID (17-20 digits) → message ID in configured channel
  if (/^\d{17,20}$/.test(trimmed) && configuredChannelId) {
    return { kind: 'message_id', messageId: trimmed }
  }

  // Invite code (alphanumeric + hyphens) or invite URL
  const inviteUrlMatch = trimmed.match(
    /^https?:\/\/(?:www\.)?discord\.gg\/([a-zA-Z0-9-]+)\/?$/
  )
  if (inviteUrlMatch) {
    return { kind: 'invite', code: inviteUrlMatch[1] }
  }

  // Raw invite code
  if (/^[a-zA-Z0-9-]+$/.test(trimmed)) {
    return { kind: 'invite', code: trimmed }
  }

  return null
}

export class DiscordVerifier implements PlatformVerifier {
  readonly name = 'discord'
  readonly label = 'Discord'

  constructor(
    private botToken?: string,
    private verifyChannelId?: string,
  ) {}

  async verify(
    identity: string,
    proof: string,
    npub: string,
  ): Promise<{ verified: boolean; error?: string }> {
    const parsed = parseProof(proof, this.verifyChannelId)
    if (!parsed) {
      return { verified: false, error: 'Invalid proof format — provide a Discord message link or message ID' }
    }

    if (parsed.kind === 'channel_url') {
      return {
        verified: false,
        error: 'That is a link to the channel, not to your message. Open your message, choose Copy Message Link, and paste that instead.',
      }
    }

    if (parsed.kind === 'message_url' || parsed.kind === 'message_id') {
      return this.verifyMessage(identity, parsed, npub)
    }

    // A server invite cannot prove who owns a Discord account. The public invite
    // endpoint returns no `inviter` for permanent or vanity invites, so an invite
    // establishes only that somebody put an npub in a server's name or description
    // — with no link to the claimed username. Accepting it let anyone claim any
    // handle, so invites are refused outright.
    return {
      verified: false,
      error: 'A server invite cannot prove who owns a Discord account. Post a message containing your npub and provide its message link instead.',
    }
  }

  private async verifyMessage(
    identity: string,
    parsed: { kind: 'message_url' | 'message_id'; channelId?: string; messageId: string },
    npub: string,
  ): Promise<{ verified: boolean; error?: string }> {
    if (!this.botToken) {
      return { verified: false, error: 'Discord verification is not configured on this deployment yet.' }
    }

    const channelId = ('channelId' in parsed && parsed.channelId)
      ? parsed.channelId
      : this.verifyChannelId

    if (!channelId) {
      return { verified: false, error: 'Could not determine Discord channel — use a full message URL' }
    }

    const url = `https://discord.com/api/v10/channels/${channelId}/messages/${parsed.messageId}`

    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          'Authorization': `Bot ${this.botToken}`,
          'Accept': 'application/json',
        },
      })
    } catch {
      return { verified: false, error: 'Failed to fetch Discord message' }
    }

    if (response.status === 404) {
      return { verified: false, error: 'Message not found — check the message link or ID' }
    }

    if (response.status === 403) {
      return { verified: false, error: 'Bot does not have access to that channel' }
    }

    if (!response.ok) {
      return { verified: false, error: `Discord API error: ${response.status}` }
    }

    let data: DiscordMessageResponse
    try {
      data = await response.json() as DiscordMessageResponse
    } catch {
      return { verified: false, error: 'Invalid JSON response from Discord' }
    }

    // Check that message author matches claimed identity
    const authorName = data.author.username.toLowerCase()
    const claimedIdentity = identity.toLowerCase()
    if (authorName !== claimedIdentity) {
      return {
        verified: false,
        error: `Message was posted by @${data.author.username}, not @${identity}`,
      }
    }

    // Check that message content contains the npub
    if (!data.content.includes(npub)) {
      return {
        verified: false,
        error: 'npub not found in message content',
      }
    }

    return { verified: true }
  }
}
