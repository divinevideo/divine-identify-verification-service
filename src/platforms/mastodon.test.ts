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

  it('returns error for invalid identity format', async () => {
    const result = await verifier.verify('noinstance', '109876543210', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Invalid Mastodon identity')
  })

  it('rejects private/internal hostnames', async () => {
    const result = await verifier.verify('localhost/@alice', '109876543210', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Invalid Mastodon instance')
  })
})
