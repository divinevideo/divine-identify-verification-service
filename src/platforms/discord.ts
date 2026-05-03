import type { PlatformVerifier } from './base'

interface DiscordInviteResponse {
  guild?: {
    id: string
    name: string
    description: string | null
  }
  code: string
  expires_at: string | null
}

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
      return { verified: false, error: 'Invalid proof format — provide a Discord message link, message ID, or server invite code' }
    }

    if (parsed.kind === 'message_url' || parsed.kind === 'message_id') {
      return this.verifyMessage(identity, parsed, npub)
    }

    return this.verifyInvite(identity, parsed.code, npub)
  }

  private async verifyMessage(
    identity: string,
    parsed: { kind: 'message_url' | 'message_id'; channelId?: string; messageId: string },
    npub: string,
  ): Promise<{ verified: boolean; error?: string }> {
    if (!this.botToken) {
      return { verified: false, error: 'Discord message verification is not configured — use a server invite code instead' }
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

  private async verifyInvite(
    _identity: string,
    code: string,
    npub: string,
  ): Promise<{ verified: boolean; error?: string }> {
    const url = `https://discord.com/api/v10/invites/${encodeURIComponent(code)}`

    let response: Response
    try {
      response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
      })
    } catch {
      return { verified: false, error: 'Failed to fetch Discord invite' }
    }

    if (response.status === 404) {
      return { verified: false, error: 'Invite not found or expired' }
    }

    if (!response.ok) {
      return { verified: false, error: `Discord API error: ${response.status}` }
    }

    let data: DiscordInviteResponse
    try {
      data = await response.json() as DiscordInviteResponse
    } catch {
      return { verified: false, error: 'Invalid JSON response from Discord' }
    }

    if (!data.guild) {
      return { verified: false, error: 'Invite does not point to a server' }
    }

    // Check if invite has expired
    if (data.expires_at) {
      const expiresAt = new Date(data.expires_at)
      if (expiresAt < new Date()) {
        return { verified: false, error: 'Invite has expired — create a permanent invite' }
      }
    }

    // Search guild name and description for npub
    const searchText = [
      data.guild.name ?? '',
      data.guild.description ?? '',
    ].join(' ')

    if (searchText.includes(npub)) {
      return { verified: true }
    }

    return {
      verified: false,
      error: 'npub not found in server name or description',
    }
  }
}
