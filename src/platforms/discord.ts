import type { PlatformVerifier } from './base'
import type { VerificationCode } from '../types'

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
  | { kind: 'dm_link' }
  | { kind: 'invite'; code: string }

/** Discord JSON error code for a channel the bot cannot see. */
const DISCORD_UNKNOWN_CHANNEL = 10003

// Every host Discord's own clients hand a user on "Copy Message Link". The
// Canary and PTB builds use their own subdomains, and links shared before the
// rename still carry discordapp.com; all of them serve the same message.
export const MESSAGE_LINK_HOSTS: readonly string[] = [
  'discord.com',
  'www.discord.com',
  'canary.discord.com',
  'ptb.discord.com',
  'discordapp.com',
  'www.discordapp.com',
  'canary.discordapp.com',
  'ptb.discordapp.com',
]

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
  if (!MESSAGE_LINK_HOSTS.includes(url.hostname.toLowerCase())) return null

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] !== 'channels') return null

  const isId = (segment: string) => /^\d+$/.test(segment)

  // A DM or group-DM link spells the guild `@me`. No bot can read someone
  // else's DMs, so this can never verify — and saying that is more use than
  // reporting the link as malformed, which is what it looks like otherwise.
  if (segments[1] === '@me') return { kind: 'dm_link' }

  if (segments.length === 4) {
    const [, guildId, channelId, messageId] = segments
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

// Whether `proof` is itself a full Discord message link. The verify-result
// page uses this to decide whether it can show `proof` directly as the
// "View proof post" link — the only Discord proof shape with a full URL to
// show. A bare snowflake (verified against a preconfigured channel) has no
// guild ID to build one from, and this service is never configured with one.
export function isDiscordMessageLink(proof: string): boolean {
  return parseDiscordUrl(proof.trim())?.kind === 'message_url'
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
  ): Promise<{ verified: boolean; error?: string; code?: VerificationCode }> {
    const parsed = parseProof(proof, this.verifyChannelId)
    if (!parsed) {
      return {
        verified: false,
        code: 'discord_invalid_proof_format',
        error: 'Invalid proof format — provide a Discord message link or message ID',
      }
    }

    if (parsed.kind === 'dm_link') {
      return {
        verified: false,
        code: 'discord_dm_link',
        error: 'That is a direct message, which our bot cannot read. Post your npub in a server channel instead.',
      }
    }

    if (parsed.kind === 'channel_url') {
      return {
        verified: false,
        code: 'discord_channel_link',
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
      code: 'discord_invite_refused',
      error: 'A server invite cannot prove who owns a Discord account. Post a message containing your npub and provide its message link instead.',
    }
  }

  private async verifyMessage(
    identity: string,
    parsed: { kind: 'message_url' | 'message_id'; channelId?: string; messageId: string },
    npub: string,
  ): Promise<{ verified: boolean; error?: string; code?: VerificationCode }> {
    if (!this.botToken) {
      return {
        verified: false,
        code: 'discord_not_configured',
        error: 'Discord verification is not configured on this deployment yet.',
      }
    }

    const channelId = ('channelId' in parsed && parsed.channelId)
      ? parsed.channelId
      : this.verifyChannelId

    if (!channelId) {
      return {
        verified: false,
        code: 'discord_invalid_proof_format',
        error: 'Could not determine Discord channel — use a full message URL',
      }
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
      return {
        verified: false,
        code: 'discord_api_error',
        error: 'Failed to fetch Discord message',
      }
    }

    if (response.status === 403) {
      return {
        verified: false,
        code: 'discord_bot_no_access',
        error: 'Bot does not have access to that channel',
      }
    }

    // Discord answers 404 both for a message that is not there and for a channel
    // the bot cannot see, and only the body tells them apart. That difference is
    // the whole answer to "is the bot in the server?", so it is worth reading.
    if (response.status === 404) {
      let discordCode: number | undefined
      try {
        discordCode = ((await response.json()) as { code?: number }).code
      } catch {
        discordCode = undefined
      }
      if (discordCode === DISCORD_UNKNOWN_CHANNEL) {
        return {
          verified: false,
          code: 'discord_bot_no_access',
          error: 'Bot cannot see that channel — post where the bot has access',
        }
      }
      return {
        verified: false,
        code: 'discord_message_not_found',
        error: 'Message not found — check the message link or ID',
      }
    }

    if (!response.ok) {
      return {
        verified: false,
        code: 'discord_api_error',
        error: `Discord API error: ${response.status}`,
      }
    }

    let data: DiscordMessageResponse
    try {
      data = await response.json() as DiscordMessageResponse
    } catch {
      return {
        verified: false,
        code: 'discord_api_error',
        error: 'Invalid JSON response from Discord',
      }
    }

    // Check that message author matches claimed identity
    const authorName = data.author.username.toLowerCase()
    const claimedIdentity = identity.toLowerCase()
    if (authorName !== claimedIdentity) {
      return {
        verified: false,
        code: 'discord_author_mismatch',
        error: `Message was not posted by @${identity}`,
      }
    }

    // An existing message whose text arrives empty is the signature of a bot
    // without the MESSAGE_CONTENT privileged intent, which Discord applies to
    // the REST API too. Reporting that as a missing npub blames the user for
    // our own misconfiguration, and sends them to re-post a message that was
    // already correct.
    if ((data.content ?? '').trim() === '') {
      return {
        verified: false,
        code: 'discord_message_content_unavailable',
        error: 'Could not read the message text — the bot may be missing the MESSAGE_CONTENT intent',
      }
    }

    // Check that message content contains the npub
    if (!data.content.includes(npub)) {
      return {
        verified: false,
        code: 'discord_npub_not_in_message',
        error: 'npub not found in message content',
      }
    }

    return { verified: true }
  }
}
