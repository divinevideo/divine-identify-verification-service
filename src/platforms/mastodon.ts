import type { PlatformVerifier } from './base'
import { isPrivateHostname } from '../utils/validation'
import { fetchPublic } from '../utils/safe-fetch'

export class MastodonVerifier implements PlatformVerifier {
  readonly name = 'mastodon'
  readonly label = 'Mastodon'

  async verify(identity: string, proof: string, npub: string): Promise<{ verified: boolean; error?: string }> {
    const invalidIdentity = { verified: false, error: 'Invalid Mastodon identity format (expected instance/@user or instance/user)' }
    const parsed = this.parseIdentity(identity)
    if (!parsed) return invalidIdentity

    const { instance } = parsed
    let { user } = parsed

    // SSRF protection: block private/internal hostnames
    if (isPrivateHostname(instance)) {
      return { verified: false, error: 'Invalid Mastodon instance hostname' }
    }

    // A claim is for an account on this server. A full handle naming this
    // server is the same account; a handle naming another server is an account
    // there, whose posts seen here are copies of the originals it holds.
    const at = user.indexOf('@')
    if (at !== -1) {
      const name = user.slice(0, at)
      const server = user.slice(at + 1)
      const isDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(server) && !isPrivateHostname(server)
      if (!name || !isDomain) return invalidIdentity
      if (server.toLowerCase() !== instance.toLowerCase()) {
        return {
          verified: false,
          error: `This account is on ${server}. Open your post there, copy its link, and enter your account as ${server}/@${name}.`,
        }
      }
      user = name
    }

    const url = `https://${instance}/api/v1/statuses/${encodeURIComponent(proof)}`

    const response = await fetchPublic(url, {
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

    let status: { account?: { acct?: string }; content?: string }
    try {
      status = await response.json() as typeof status
    } catch {
      return { verified: false, error: 'Invalid JSON response from Mastodon' }
    }

    // The author must be the claimed account on this server. Servers also show
    // posts from other servers, whose authors may share the bare username but have
    // an acct of username@their-server; a local author's acct is the username.
    const acct = status.account?.acct?.toLowerCase()
    if (acct !== user.toLowerCase()) {
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
