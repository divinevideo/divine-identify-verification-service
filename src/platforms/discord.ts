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
  | { kind: 'invite'; code: string }

function parseProof(proof: string, configuredChannelId?: string): ProofType | null {
  // Discord message URL: https://discord.com/channels/{guild}/{channel}/{message}
  const urlMatch = proof.match(
    /^https?:\/\/(?:www\.)?discord\.com\/channels\/\d+\/(\d+)\/(\d+)$/
  )
  if (urlMatch) {
    return { kind: 'message_url', channelId: urlMatch[1], messageId: urlMatch[2] }
  }

  // Pure numeric snowflake ID (17-20 digits) → message ID in configured channel
  if (/^\d{17,20}$/.test(proof) && configuredChannelId) {
    return { kind: 'message_id', messageId: proof }
  }

  // Invite code (alphanumeric + hyphens) or invite URL
  const inviteUrlMatch = proof.match(
    /^https?:\/\/(?:www\.)?discord\.gg\/([a-zA-Z0-9-]+)$/
  )
  if (inviteUrlMatch) {
    return { kind: 'invite', code: inviteUrlMatch[1] }
  }

  // Raw invite code
  if (/^[a-zA-Z0-9-]+$/.test(proof)) {
    return { kind: 'invite', code: proof }
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
