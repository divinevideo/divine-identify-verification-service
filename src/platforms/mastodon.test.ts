import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MastodonVerifier } from './mastodon'
import { PlatformUnavailableError } from './base'

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

describe('MastodonVerifier on servers whose handles use another domain', () => {
  const verifier = new MastodonVerifier()
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
  const ID = '109876543210'
  const ACTIVITY = 'application/activity+json'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function webfinger(subject: unknown, links: unknown): () => Response {
    return () => new Response(JSON.stringify({ subject, links }), { status: 200, headers: { 'Content-Type': 'application/jrd+json' } })
  }
  function self(href: string, type = ACTIVITY) {
    return [{ rel: 'self', type, href }]
  }
  function post(acct: string, content = `<p>${npub}</p>`): () => Response {
    return () => new Response(JSON.stringify({ account: { acct }, content }), { status: 200 })
  }
  const notFound = () => new Response('not found', { status: 404 })

  // Answers by URL prefix; anything unlisted is a 404. Returns the URLs asked for.
  function serve(table: Record<string, () => Response>): string[] {
    const asked: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      asked.push(url)
      const prefix = Object.keys(table).find(p => url.startsWith(p))
      return prefix ? table[prefix]() : notFound()
    }))
    return asked
  }

  const SPLIT = {
    'https://example.com/api/v1/statuses/': notFound,
    'https://example.com/.well-known/webfinger': webfinger('acct:alice@example.com', self('https://social.example.com/users/alice')),
    'https://social.example.com/.well-known/webfinger': webfinger('acct:alice@example.com', self('https://social.example.com/users/alice')),
    'https://social.example.com/api/v1/statuses/': post('alice'),
  }

  it('verifies a post on the web domain when both domains confirm the account', async () => {
    const asked = serve(SPLIT)
    const result = await verifier.verify('example.com/@alice', ID, npub)
    expect(result).toEqual({ verified: true, canonicalIdentity: 'social.example.com/@alice' })
    expect(asked).toEqual([
      `https://example.com/api/v1/statuses/${ID}`,
      'https://example.com/.well-known/webfinger?resource=acct%3Aalice%40example.com',
      'https://social.example.com/.well-known/webfinger?resource=acct%3Aalice%40example.com',
      `https://social.example.com/api/v1/statuses/${ID}`,
    ])
  })

  it('makes one request on a server that has the post', async () => {
    const asked = serve({ 'https://mastodon.social/api/v1/statuses/': post('alice') })
    const result = await verifier.verify('mastodon.social/@alice', ID, npub)
    expect(result).toEqual({ verified: true })
    expect(asked).toHaveLength(1)
  })

  it('stops after one lookup when the account lives on the claimed domain', async () => {
    const asked = serve({
      'https://mastodon.social/.well-known/webfinger': webfinger('acct:alice@mastodon.social', self('https://mastodon.social/users/alice')),
    })
    expect(await verifier.verify('mastodon.social/@alice', ID, npub)).toEqual({ verified: false, error: 'Mastodon status not found' })
    expect(asked).toHaveLength(2)
  })

  it('follows the handle domain redirecting its lookup to the web domain', async () => {
    serve({
      ...SPLIT,
      'https://example.com/.well-known/webfinger': () => new Response(null, {
        status: 301,
        headers: { Location: 'https://social.example.com/.well-known/webfinger?resource=acct%3Aalice%40example.com' },
      }),
    })
    expect(await verifier.verify('example.com/@alice', ID, npub)).toEqual({ verified: true, canonicalIdentity: 'social.example.com/@alice' })
  })

  it('matches the account regardless of letter case', async () => {
    serve({
      'https://Example.com/api/v1/statuses/': notFound,
      'https://Example.com/.well-known/webfinger': webfinger('acct:alice@example.com', self('https://Social.Example.com/users/alice')),
      'https://social.example.com/.well-known/webfinger': webfinger('acct:Alice@Example.com', self('https://social.example.com/users/alice')),
      'https://social.example.com/api/v1/statuses/': post('alice'),
    })
    expect(await verifier.verify('Example.com/@Alice', ID, npub)).toEqual({ verified: true, canonicalIdentity: 'social.example.com/@Alice' })
  })

  it.each([
    ['names a different account', webfinger('acct:bob@example.com', self('https://social.example.com/users/bob'))],
    ['has no subject', webfinger(undefined, self('https://social.example.com/users/alice'))],
    ['has no links', webfinger('acct:alice@example.com', undefined)],
    ['has links that are not a list', webfinger('acct:alice@example.com', { rel: 'self' })],
    ['has only a profile page link', webfinger('acct:alice@example.com', [{ rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: 'https://social.example.com/@alice' }])],
    ['has a self link that is not ActivityPub', webfinger('acct:alice@example.com', self('https://social.example.com/users/alice', 'text/html'))],
    ['is not JSON', () => new Response('<html></html>', { status: 200 })],
  ])('treats the post as not found when the handle domain\'s answer %s', async (_label, answer) => {
    const asked = serve({ ...SPLIT, 'https://example.com/.well-known/webfinger': answer })
    expect(await verifier.verify('example.com/@alice', ID, npub)).toEqual({ verified: false, error: 'Mastodon status not found' })
    expect(asked.some(u => u.startsWith('https://social.example.com/'))).toBe(false)
  })

  it.each([
    ['http', 'http://social.example.com/users/alice'],
    ['a private name', 'https://social.internal/users/alice'],
    ['an IP address', 'https://10.0.0.5/users/alice'],
    ['a port', 'https://social.example.com:8443/users/alice'],
  ])('makes no request to a web domain given as %s', async (_label, href) => {
    const asked = serve({ ...SPLIT, 'https://example.com/.well-known/webfinger': webfinger('acct:alice@example.com', self(href)) })
    expect(await verifier.verify('example.com/@alice', ID, npub)).toEqual({ verified: false, error: 'Mastodon status not found' })
    expect(asked).toHaveLength(2)
  })

  it.each([
    ['does not know the account', notFound],
    ['names a different account', webfinger('acct:alice@social.example.com', self('https://social.example.com/users/alice'))],
    ['points somewhere else', webfinger('acct:alice@example.com', self('https://other.example.net/users/alice'))],
  ])('treats the post as not found when the web domain %s', async (_label, answer) => {
    const asked = serve({ ...SPLIT, 'https://social.example.com/.well-known/webfinger': answer })
    expect(await verifier.verify('example.com/@alice', ID, npub)).toEqual({ verified: false, error: 'Mastodon status not found' })
    expect(asked.some(u => u.startsWith('https://social.example.com/api/'))).toBe(false)
  })

  it.each([
    ['the handle domain\'s lookup', 'https://example.com/.well-known/webfinger'],
    ['the web domain\'s lookup', 'https://social.example.com/.well-known/webfinger'],
  ])('reports "couldn\'t check" when %s fails on the server\'s side', async (_label, prefix) => {
    serve({ ...SPLIT, [prefix]: () => new Response('down', { status: 503 }) })
    await expect(verifier.verify('example.com/@alice', ID, npub)).rejects.toBeInstanceOf(PlatformUnavailableError)
  })

  it('reports "couldn\'t check" when a lookup cannot reach the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://example.com/api/')) return new Response('not found', { status: 404 })
      throw new TypeError('network down')
    }))
    await expect(verifier.verify('example.com/@alice', ID, npub)).rejects.toBeInstanceOf(PlatformUnavailableError)
  })

  it('says the post was not found when the web domain doesn\'t have it either', async () => {
    serve({ ...SPLIT, 'https://social.example.com/api/v1/statuses/': notFound })
    expect(await verifier.verify('example.com/@alice', ID, npub)).toEqual({ verified: false, error: 'Mastodon status not found' })
  })

  it('refuses a post on the web domain by a same-named account from another server', async () => {
    serve({ ...SPLIT, 'https://social.example.com/api/v1/statuses/': post('alice@elsewhere.example') })
    expect(await verifier.verify('example.com/@alice', ID, npub)).toEqual({ verified: false, error: 'Status author does not match claimed identity' })
  })

  it('leaves canonicalIdentity out when the post on the web domain lacks the key', async () => {
    serve({ ...SPLIT, 'https://social.example.com/api/v1/statuses/': post('alice', '<p>hello</p>') })
    expect(await verifier.verify('example.com/@alice', ID, npub)).toEqual({ verified: false, error: 'npub not found in Mastodon status content' })
  })
})
