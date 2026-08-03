import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GitHubVerifier } from './github'

describe('GitHubVerifier', () => {
  // Constructed with a token so these exercise the JSON API path. Without one
  // the verifier reads the gist CDN instead — covered in its own block below.
  const verifier = new GitHubVerifier('test-token')
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns verified when npub found in gist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        owner: { login: 'octocat' },
        files: {
          'nostr.md': { content: `Verifying that I control the following Nostr public key: ${npub}` },
        },
      }),
    }))

    const result = await verifier.verify('octocat', 'abc123', npub)
    expect(result.verified).toBe(true)
  })

  it('returns not verified when npub missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        owner: { login: 'octocat' },
        files: {
          'nostr.md': { content: 'Some other content without the key' },
        },
      }),
    }))

    const result = await verifier.verify('octocat', 'abc123', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('npub not found')
  })

  it('returns not verified when owner does not match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        owner: { login: 'differentuser' },
        files: {
          'nostr.md': { content: npub },
        },
      }),
    }))

    const result = await verifier.verify('octocat', 'abc123', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('owner does not match')
  })

  it('returns error for 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }))

    const result = await verifier.verify('octocat', 'notfound', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('not found')
  })
})

// The API path costs a credential. Unauthenticated it allows 60 calls/hour per
// IP, and a Worker's egress IPs are shared across the whole Cloudflare edge, so
// that budget is spent by strangers and verification returns 403 for real users
// — which is exactly what production was doing.
//
// gist.githubusercontent.com is CDN-served, carries no API rate limit, and
// GitHub enforces the owner in the path: a gist id under the wrong username is
// a 404. That makes it a credential-free way to check both facts we care about,
// so it backs the API up instead of the whole feature failing.
describe('GitHubVerifier without a usable API credential', () => {
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function rawOnly(responses: Record<string, { status: number; body?: string }>) {
    return vi.fn(async (url: string) => {
      const match = Object.keys(responses).find((key) => String(url).includes(key))
      if (!match) throw new Error(`unexpected fetch: ${url}`)
      const { status, body = '' } = responses[match]
      return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => ({}) }
    })
  }

  it('verifies from the raw gist when no token is configured', async () => {
    const fetchMock = rawOnly({
      'gist.githubusercontent.com/octocat/abc123/raw': { status: 200, body: `my key: ${npub}` },
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new GitHubVerifier().verify('octocat', 'abc123', npub)

    expect(result.verified).toBe(true)
    // Never touched the rate-limited API.
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('api.github.com'))).toBe(true)
  })

  it('treats a 404 on the owner-scoped raw URL as the gist not being theirs', async () => {
    vi.stubGlobal('fetch', rawOnly({
      'gist.githubusercontent.com/not-octocat/abc123/raw': { status: 404 },
    }))

    const result = await new GitHubVerifier().verify('not-octocat', 'abc123', npub)

    expect(result.verified).toBe(false)
    expect(result.error).toMatch(/not found|owner/i)
  })

  it('refuses raw content that does not carry the npub', async () => {
    vi.stubGlobal('fetch', rawOnly({
      'gist.githubusercontent.com/octocat/abc123/raw': { status: 200, body: 'nothing to see here' },
    }))

    const result = await new GitHubVerifier().verify('octocat', 'abc123', npub)

    expect(result.verified).toBe(false)
    expect(result.error).toMatch(/npub not found/i)
  })

  it('falls back to raw when the API is rate limited rather than failing the user', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('api.github.com')) {
        return { ok: false, status: 403, json: async () => ({}), text: async () => '' }
      }
      return { ok: true, status: 200, text: async () => `key ${npub}`, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new GitHubVerifier('a-token').verify('octocat', 'abc123', npub)

    expect(result.verified).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('gist.githubusercontent.com'))).toBe(true)
  })

  it('still prefers the API when it answers, so every file in the gist is searched', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('api.github.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            owner: { login: 'octocat' },
            files: { 'a.md': { content: 'nope' }, 'b.md': { content: `second file: ${npub}` } },
          }),
          text: async () => '',
        }
      }
      throw new Error('should not have needed the raw fallback')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new GitHubVerifier('a-token').verify('octocat', 'abc123', npub)

    expect(result.verified).toBe(true)
  })
})
