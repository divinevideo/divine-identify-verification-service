import { fetchFromPlatform, throwIfUnanswered, type PlatformVerifier } from './base'
import { isPrivateHostname, isSafeUrl } from '../utils/validation'
import { fetchPublic } from '../utils/safe-fetch'

const HEADERS = { 'User-Agent': 'divine-identity-verification-service' }

// The ActivityPub actor link in a WebFinger answer. Mastodon sends the first;
// the second is the same type spelled as JSON-LD.
const ACTOR_TYPES = new Set([
  'application/activity+json',
  'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
])

/**
 * The host serving `account`, from a WebFinger answer: only when the answer is
 * about that account, and only from its ActivityPub self link, an https link
 * to a public host on the default port. Anything else is no answer.
 */
function actorHost(body: unknown, account: string): string | null {
  if (!body || typeof body !== 'object') return null
  const { subject, links } = body as { subject?: unknown; links?: unknown }
  if (typeof subject !== 'string' || subject.toLowerCase() !== `acct:${account}`.toLowerCase()) return null
  if (!Array.isArray(links)) return null
  const self = links.find((link): link is { href: string } =>
    !!link && typeof link === 'object'
    && (link as { rel?: unknown }).rel === 'self'
    && ACTOR_TYPES.has((link as { type?: unknown }).type as string)
    && typeof (link as { href?: unknown }).href === 'string')
  if (!self || !isSafeUrl(self.href)) return null
  const url = new URL(self.href)
  return url.port ? null : url.hostname.toLowerCase()
}

export class MastodonVerifier implements PlatformVerifier {
  readonly name = 'mastodon'
  readonly label = 'Mastodon'

  async verify(identity: string, proof: string, npub: string): Promise<{ verified: boolean; error?: string; canonicalIdentity?: string }> {
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

    const direct = await this.fetchStatus(instance, proof)
    if (direct.status !== 404) return this.checkStatus(direct, user, npub)

    // Some servers use one domain in handles and another for their website and
    // API. The post isn't on the claimed domain, so look for that.
    const webHost = await this.resolveWebDomain(instance, user)
    if (!webHost) return { verified: false, error: 'Mastodon status not found' }
    const result = await this.checkStatus(await this.fetchStatus(webHost, proof), user, npub)
    return result.verified ? { ...result, canonicalIdentity: `${webHost}/@${user}` } : result
  }

  // The instance comes from the claim, so redirects are checked as fetchPublic does.
  private fetchStatus(host: string, proof: string): Promise<Response> {
    return fetchFromPlatform(this.label, `https://${host}/api/v1/statuses/${encodeURIComponent(proof)}`, {
      headers: { ...HEADERS, Accept: 'application/json' },
    }, fetchPublic)
  }

  private async checkStatus(response: Response, user: string, npub: string): Promise<{ verified: boolean; error?: string }> {
    if (response.status === 404) {
      return { verified: false, error: 'Mastodon status not found' }
    }
    throwIfUnanswered(response, this.label)
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

  /**
   * The web domain of a server whose handles use another domain (Mastodon's
   * LOCAL_DOMAIN and WEB_DOMAIN), or null. Both domains must agree: the handle
   * domain names the web domain for this account, and the web domain answers
   * for the same account at itself.
   */
  private async resolveWebDomain(instance: string, user: string): Promise<string | null> {
    const account = `${user}@${instance}`
    const webHost = await this.lookUpActorHost(instance, account)
    if (!webHost || webHost === instance.toLowerCase()) return null
    return (await this.lookUpActorHost(webHost, account)) === webHost ? webHost : null
  }

  private async lookUpActorHost(host: string, account: string): Promise<string | null> {
    const url = `https://${host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${account}`)}`
    const response = await fetchFromPlatform(this.label, url, {
      headers: { ...HEADERS, Accept: 'application/jrd+json, application/json' },
    }, fetchPublic)
    throwIfUnanswered(response, this.label)
    if (!response.ok) return null
    try {
      return actorHost(await response.json(), account)
    } catch {
      return null
    }
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
