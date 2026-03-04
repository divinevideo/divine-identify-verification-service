import type { PlatformVerifier } from './base'

export class GitHubVerifier implements PlatformVerifier {
  readonly name = 'github'
  readonly label = 'GitHub'
  private token?: string

  constructor(token?: string) {
    this.token = token
  }

  async verify(identity: string, proof: string, npub: string): Promise<{ verified: boolean; error?: string }> {
    const url = `https://api.github.com/gists/${proof}`
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'divine-identity-verification-service',
    }
    if (this.token) {
      headers['Authorization'] = `token ${this.token}`
    }

    const response = await fetch(url, { headers })

    if (response.status === 404) {
      return { verified: false, error: 'Gist not found' }
    }
    if (!response.ok) {
      return { verified: false, error: `GitHub API error: ${response.status}` }
    }

    let gist: { owner?: { login?: string }; files?: Record<string, { content?: string }> }
    try {
      gist = await response.json() as typeof gist
    } catch {
      return { verified: false, error: 'Invalid JSON response from GitHub' }
    }

    // Verify the gist owner matches the claimed identity
    if (gist.owner?.login?.toLowerCase() !== identity.toLowerCase()) {
      return { verified: false, error: 'Gist owner does not match claimed identity' }
    }

    // Search all file contents for the npub
    const files = gist.files || {}
    for (const file of Object.values(files)) {
      if (file.content && file.content.includes(npub)) {
        return { verified: true }
      }
    }

    return { verified: false, error: 'npub not found in gist content' }
  }
}
