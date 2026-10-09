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

  it('does not follow a redirect from a public instance to an internal host', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: 'https://localhost/api/v1/statuses/109876543210' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifier.verify('mastodon.social/@alice', '109876543210', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toBe('Mastodon API error: 302')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
  })

  it('follows a redirect to another public host', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { Location: 'https://social.example.org/api/v1/statuses/109876543210' } }),
      )
      .mockResolvedValueOnce(Response.json({ account: { acct: 'alice' }, content: `<p>${npub}</p>` }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifier.verify('mastodon.social/@alice', '109876543210', npub)
    expect(result.verified).toBe(true)
    expect(fetchMock.mock.calls[1][0]).toBe('https://social.example.org/api/v1/statuses/109876543210')
  })
})

describe('MastodonVerifier failure answers', () => {
  const verifier = new MastodonVerifier()
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function answer(response: Response) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
  }

  it('says the post was not found when the server answers 404', async () => {
    // Every request 404s, so this holds before and after the web-domain lookup exists.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    const result = await verifier.verify('mastodon.social/@alice', '109876543210', npub)
    expect(result).toEqual({ verified: false, error: 'Mastodon status not found' })
  })

  it('reports a refusal that is not a redirect as an API error', async () => {
    answer(new Response('forbidden', { status: 403 }))
    expect(await verifier.verify('mastodon.social/@alice', '1', npub))
      .toEqual({ verified: false, error: 'Mastodon API error: 403' })
  })

  it('reports a removed post as an API error', async () => {
    answer(new Response('gone', { status: 410 }))
    expect(await verifier.verify('mastodon.social/@alice', '1', npub))
      .toEqual({ verified: false, error: 'Mastodon API error: 410' })
  })

  it('refuses an answer that is not JSON', async () => {
    answer(new Response('<html>oops</html>', { status: 200 }))
    expect(await verifier.verify('mastodon.social/@alice', '1', npub))
      .toEqual({ verified: false, error: 'Invalid JSON response from Mastodon' })
  })

  it('refuses a post with no author', async () => {
    answer(new Response(JSON.stringify({ content: `<p>${npub}</p>` }), { status: 200 }))
    expect(await verifier.verify('mastodon.social/@alice', '1', npub))
      .toEqual({ verified: false, error: 'Status author does not match claimed identity' })
  })

  it('says the key is missing when the post has no text', async () => {
    answer(new Response(JSON.stringify({ account: { acct: 'alice' } }), { status: 200 }))
    expect(await verifier.verify('mastodon.social/@alice', '1', npub))
      .toEqual({ verified: false, error: 'npub not found in Mastodon status content' })
  })

  it.each([
    ['no account after the slash', 'mastodon.social/'],
    ['only an @ after the slash', 'mastodon.social/@'],
    ['an underscore in the server name', 'bad_host.example/@alice'],
  ])('refuses %s without fetching', async (_label, identity) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await verifier.verify(identity, '1', npub)
    expect(result).toEqual({ verified: false, error: 'Invalid Mastodon identity format (expected instance/@user or instance/user)' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
