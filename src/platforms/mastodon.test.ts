import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MastodonVerifier } from './mastodon'

describe('MastodonVerifier', () => {
  const verifier = new MastodonVerifier()
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns verified when npub found in status from correct author', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        account: { acct: 'alice', username: 'alice' },
        content: `<p>Verifying that I control the following Nostr public key: &quot;${npub}&quot;</p>`,
      }),
    }))

    const result = await verifier.verify('mastodon.social/@alice', '109876543210', npub)
    expect(result.verified).toBe(true)
  })

  it('returns not verified when npub missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        account: { acct: 'alice', username: 'alice' },
        content: '<p>Just a regular toot</p>',
      }),
    }))

    const result = await verifier.verify('mastodon.social/@alice', '109876543210', npub)
    expect(result.verified).toBe(false)
  })

  it('returns not verified when author does not match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        account: { acct: 'bob', username: 'bob' },
        content: `<p>${npub}</p>`,
      }),
    }))

    const result = await verifier.verify('mastodon.social/@alice', '109876543210', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('author does not match')
  })

  // Servers show posts from accounts on other servers too. A remote author has
  // the same bare username but an acct that names their own server.
  it('refuses a post by a same-named account on another server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        account: { acct: 'alice@elsewhere.example', username: 'alice' },
        content: `<p>${npub}</p>`,
      }),
    }))

    const result = await verifier.verify('mastodon.social/@alice', '109876543210', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('author does not match')
  })

  it('matches the local author regardless of letter case', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        account: { acct: 'Alice', username: 'Alice' },
        content: `<p>${npub}</p>`,
      }),
    }))

    const result = await verifier.verify('mastodon.social/@alice', '109876543210', npub)
    expect(result.verified).toBe(true)
  })

  it('matches a claimed user regardless of letter case', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ account: { acct: 'alice' }, content: `<p>${npub}</p>` }),
    }))

    const result = await verifier.verify('mastodon.social/@Alice', '109876543210', npub)
    expect(result.verified).toBe(true)
  })

  it('accepts a full handle on the same server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ account: { acct: 'alice' }, content: `<p>${npub}</p>` }),
    }))

    for (const identity of [
      'mastodon.social/@alice@mastodon.social',
      'mastodon.social/@alice@Mastodon.Social',
      'Mastodon.Social/@alice@mastodon.social',
    ]) {
      const result = await verifier.verify(identity, '109876543210', npub)
      expect(result.verified, identity).toBe(true)
    }
  })

  it('names the account\'s own server when the handle is on another server', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifier.verify('mastodon.social/@alice@elsewhere.example', '109876543210', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toBe(
      'This account is on elsewhere.example. Open your post there, copy its link, and enter your account as elsewhere.example/@alice.',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a handle with an empty name or an invalid server as an invalid account', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    for (const identity of [
      'mastodon.social/@@mastodon.social',
      'mastodon.social/@alice@',
      'mastodon.social/@alice@not a host',
      'mastodon.social/@alice@elsewhere.example.',
      'mastodon.social/@alice@.',
      'mastodon.social/@alice@localhost',
      'mastodon.social/@alice@10.0.0.1',
      'mastodon.social/@alice@social.internal',
    ]) {
      const result = await verifier.verify(identity, '109876543210', npub)
      expect(result.verified, identity).toBe(false)
      expect(result.error, identity).toContain('Invalid Mastodon identity')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns error for invalid identity format', async () => {
    const result = await verifier.verify('noinstance', '109876543210', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Invalid Mastodon identity')
  })

  it('refuses a server spelled with a trailing dot without fetching it', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifier.verify('mastodon.social./@alice', '109876543210', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toBe('Invalid Mastodon instance hostname')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects private/internal hostnames', async () => {
    const result = await verifier.verify('localhost/@alice', '109876543210', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Invalid Mastodon instance')
  })
})
