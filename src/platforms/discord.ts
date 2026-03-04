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

export class DiscordVerifier implements PlatformVerifier {
  readonly name = 'discord'
  readonly label = 'Discord'

  async verify(
    identity: string,
    proof: string,
    npub: string,
  ): Promise<{ verified: boolean; error?: string }> {
    // Validate invite code format (alphanumeric, hyphens)
    if (!/^[a-zA-Z0-9-]+$/.test(proof)) {
      return { verified: false, error: 'Invalid invite code format' }
    }

    const url = `https://discord.com/api/v10/invites/${encodeURIComponent(proof)}`

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
