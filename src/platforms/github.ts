// ABOUTME: GitHub proof-post verifier: reads the gist and checks it for the
// ABOUTME: claimant's npub, via the JSON API when credentialed and the CDN otherwise.
import type { PlatformVerifier } from './base'

// Unauthenticated api.github.com allows 60 calls/hour per IP, and a Worker's
// egress addresses are shared across the whole Cloudflare edge — so that budget
// gets spent by strangers and every verification returns 403. The gist CDN
// carries no API rate limit, and GitHub enforces the owner in the path: the
// same gist id under a different username is a 404. That gives us both facts
// this check needs without depending on a credential.
const RAW_HOST = 'https://gist.githubusercontent.com'
const API_HOST = 'https://api.github.com'

// Statuses meaning "the API would not answer", as distinct from a verdict about
// the gist. These fall through to the CDN rather than being reported to the
// user as though their proof had been rejected.
const API_UNAVAILABLE = new Set([401, 403, 429, 500, 502, 503, 504])

export class GitHubVerifier implements PlatformVerifier {
  readonly name = 'github'
  readonly label = 'GitHub'
  private token?: string

  constructor(token?: string) {
    this.token = token
  }

  async verify(identity: string, proof: string, npub: string): Promise<{ verified: boolean; error?: string }> {
    // The API is preferred when it will answer: it searches every file in the
    // gist, where the CDN's /raw serves only the first one.
    if (this.token) {
      const viaApi = await this.verifyViaApi(identity, proof, npub)
      if (viaApi) return viaApi
    }
    return this.verifyViaRaw(identity, proof, npub)
  }

  // Returns null when the API declined to answer, so the caller can fall back.
  private async verifyViaApi(
    identity: string,
    proof: string,
    npub: string,
  ): Promise<{ verified: boolean; error?: string } | null> {
    let response: Response
    try {
      response = await fetch(`${API_HOST}/gists/${encodeURIComponent(proof)}`, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'divine-identity-verification-service',
          'Authorization': `token ${this.token}`,
        },
      })
    } catch {
      return null
    }

    if (response.status === 404) {
      return { verified: false, error: 'Gist not found' }
    }
    if (API_UNAVAILABLE.has(response.status)) {
      return null
    }
    if (!response.ok) {
      return { verified: false, error: `GitHub API error: ${response.status}` }
    }

    let gist: { owner?: { login?: string }; files?: Record<string, { content?: string }> }
    try {
      gist = (await response.json()) as typeof gist
    } catch {
      return null
    }

    if (gist.owner?.login?.toLowerCase() !== identity.toLowerCase()) {
      return { verified: false, error: 'Gist owner does not match claimed identity' }
    }

    for (const file of Object.values(gist.files || {})) {
      if (file.content && file.content.includes(npub)) {
        return { verified: true }
      }
    }

    return { verified: false, error: 'npub not found in gist content' }
  }

  private async verifyViaRaw(
    identity: string,
    proof: string,
    npub: string,
  ): Promise<{ verified: boolean; error?: string }> {
    // The username in this path is load-bearing: GitHub serves a gist only
    // under its actual owner, so a 200 here *is* the ownership check. Both
    // segments are encoded because both are user input.
    const url = `${RAW_HOST}/${encodeURIComponent(identity)}/${encodeURIComponent(proof)}/raw`

    // Deliberately unguarded: a transport failure is an outage, not a verdict
    // about the proof. Letting it throw keeps the service layer's
    // "Platform verification unavailable" path, so a network blip is never
    // cached as though the user's gist had been rejected.
    const response = await fetch(url, {
      headers: { 'User-Agent': 'divine-identity-verification-service' },
    })

    if (response.status === 404) {
      return { verified: false, error: 'Gist not found for that account — check the owner and the gist ID' }
    }
    if (!response.ok) {
      return { verified: false, error: `GitHub error: ${response.status}` }
    }

    const content = await response.text()
    if (content.includes(npub)) {
      return { verified: true }
    }

    return {
      verified: false,
      error:
        'npub not found in gist content. Without an API token only the first file of a gist is read, so put your npub in the first file.',
    }
  }
}
