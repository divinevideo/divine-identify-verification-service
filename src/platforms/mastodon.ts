import type { PlatformVerifier } from './base'
import { isPrivateHostname } from '../utils/validation'

export class MastodonVerifier implements PlatformVerifier {
  readonly name = 'mastodon'
  readonly label = 'Mastodon'

  async verify(identity: string, proof: string, npub: string): Promise<{ verified: boolean; error?: string }> {
    const parsed = this.parseIdentity(identity)
    if (!parsed) {
      return { verified: false, error: 'Invalid Mastodon identity format (expected instance/@user or instance/user)' }
    }

    const { instance, user } = parsed

    // SSRF protection: block private/internal hostnames
    if (isPrivateHostname(instance)) {
      return { verified: false, error: 'Invalid Mastodon instance hostname' }
    }

    const url = `https://${instance}/api/v1/statuses/${encodeURIComponent(proof)}`

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'divine-identity-verification-service',
      },
    })

    if (response.status === 404) {
      return { verified: false, error: 'Mastodon status not found' }
    }
    if (!response.ok) {
      return { verified: false, error: `Mastodon API error: ${response.status}` }
    }

    let status: { account?: { acct?: string; username?: string }; content?: string }
    try {
      status = await response.json() as typeof status
    } catch {
      return { verified: false, error: 'Invalid JSON response from Mastodon' }
    }

    // Verify the status author matches the claimed user
    const acct = status.account?.acct?.toLowerCase()
    const username = status.account?.username?.toLowerCase()
    const claimedUser = user.toLowerCase()
    if (acct !== claimedUser && username !== claimedUser) {
      return { verified: false, error: 'Status author does not match claimed identity' }
    }

    // Check the post content for the npub
    if (status.content && status.content.includes(npub)) {
      return { verified: true }
    }

    return { verified: false, error: 'npub not found in Mastodon status content' }
  }

  private parseIdentity(identity: string): { instance: string; user: string } | null {
    const slashIdx = identity.indexOf('/')
    if (slashIdx === -1) return null

    const instance = identity.slice(0, slashIdx)
    let user = identity.slice(slashIdx + 1)
    if (user.startsWith('@')) user = user.slice(1)
    if (!instance || !user) return null

    // Block path traversal in instance hostname (e.g., "evil.com/../../internal")
    if (instance.includes('/') || instance.includes('\\') || !/^[a-zA-Z0-9.-]+$/.test(instance)) return null

    return { instance, user }
  }
}
