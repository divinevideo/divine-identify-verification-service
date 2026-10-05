import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TikTokVerifier } from './tiktok'

describe('TikTokVerifier', () => {
  const verifier = new TikTokVerifier()
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns verified when npub found in video caption', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'testuser',
        author_unique_id: 'testuser',
        title: `My Nostr key: ${npub} #nostr`,
      }),
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(true)
  })

  it('returns not verified when npub not in caption', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'testuser',
        author_unique_id: 'testuser',
        title: 'Just a regular TikTok caption',
      }),
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toBe('npub not found in post caption')
  })

  it('returns error when author does not match identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'otheruser',
        author_unique_id: 'otheruser',
        title: npub,
      }),
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('does not match')
  })

  it('matches author handle case-insensitively', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'Display Name',
        author_unique_id: 'TestUser',
        title: npub,
      }),
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(true)
  })

  it('verifies when display name differs from the handle', async () => {
    // Regression: the claimed identity is the @handle, which oEmbed returns as
    // author_unique_id. Matching author_name (the display name) rejected every
    // account whose display name differs from its handle.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'foo',
        author_unique_id: 'foo7323',
        title: npub,
      }),
    }))

    const result = await verifier.verify('foo7323', '7676181219524021535', npub)
    expect(result.verified).toBe(true)
  })

  it('falls back to the documented author_url when author_unique_id is absent', async () => {
    // author_unique_id is undocumented; author_url is documented. Verification
    // must still work off author_url alone if TikTok drops the former.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'Display Name',
        author_url: 'https://www.tiktok.com/@foo7323',
        title: npub,
      }),
    }))

    const result = await verifier.verify('foo7323', '7676181219524021535', npub)
    expect(result.verified).toBe(true)
  })

  it('ignores an author_url on a non-TikTok host', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'Display Name',
        author_url: 'https://evil.example/@foo7323',
        title: npub,
      }),
    }))

    const result = await verifier.verify('foo7323', '7676181219524021535', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('did not say whose post this is')
  })

  it('ignores a non-HTTPS author_url', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'Display Name',
        author_url: 'http://www.tiktok.com/@foo7323',
        title: npub,
      }),
    }))

    const result = await verifier.verify('foo7323', '7676181219524021535', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('did not say whose post this is')
  })

  it('ignores an author_url that is not a bare @handle profile path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'Display Name',
        author_url: 'https://www.tiktok.com/@foo7323/video/7676181219524021535',
        title: npub,
      }),
    }))

    const result = await verifier.verify('foo7323', '7676181219524021535', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('did not say whose post this is')
  })

  it('returns error when neither author_unique_id nor a valid author_url is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        author_name: 'testuser',
        title: npub,
      }),
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('did not say whose post this is')
  })

  it('returns error for 404 video', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('returns error for something that is not a TikTok video', async () => {
    const result = await verifier.verify('testuser', 'bad-id', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Paste a TikTok video or photo link')
  })

  it('returns error for invalid username format', async () => {
    const result = await verifier.verify('bad user!', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Invalid TikTok username')
  })

  it('returns error on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toBe('Failed to fetch TikTok post')
  })

  it('returns error on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }))

    const result = await verifier.verify('testuser', '7123456789012345678', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('oEmbed error')
  })
})

describe('TikTokVerifier: the links people paste', () => {
  const verifier = new TikTokVerifier()
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
  const VIDEO_ID = '7123456789012345678'

  function oembedOk() {
    return {
      ok: true,
      status: 200,
      json: async () => ({ author_unique_id: 'testuser', author_url: 'https://www.tiktok.com/@testuser', title: `My key ${npub}` }),
    }
  }

  // Answers the share-link lookup with a redirect, then the oEmbed call.
  function stubShareThenOembed(location: string | null, status = 301) {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status, headers: new Headers(location ? { Location: location } : {}) })
      .mockResolvedValueOnce(oembedOk())
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['a full video link', `https://www.tiktok.com/@testuser/video/${VIDEO_ID}`],
    ['a video link with tracking parameters', `https://www.tiktok.com/@testuser/video/${VIDEO_ID}?_r=1&_t=abc`],
    ['a video link without https://', `www.tiktok.com/@testuser/video/${VIDEO_ID}`],
    ['a mobile video link', `https://m.tiktok.com/@testuser/video/${VIDEO_ID}`],
    ['a video link on tiktok.com without www', `https://tiktok.com/@testuser/video/${VIDEO_ID}`],
    ['a video number with spaces around it', `  ${VIDEO_ID}  `],
    ['a video link with an uppercase scheme', `HTTPS://www.tiktok.com/@testuser/video/${VIDEO_ID}`],
    ['an embed link', `https://www.tiktok.com/embed/v2/${VIDEO_ID}`],
    ['a short embed link', `https://www.tiktok.com/embed/${VIDEO_ID}`],
    ['an older mobile share landing', `https://m.tiktok.com/v/${VIDEO_ID}.html`],
  ])('verifies %s', async (_label, proof) => {
    const fetchMock = vi.fn().mockResolvedValue(oembedOk())
    vi.stubGlobal('fetch', fetchMock)
    const result = await verifier.verify('testuser', proof, npub)
    expect(result.verified).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toContain(encodeURIComponent(`https://www.tiktok.com/@testuser/video/${VIDEO_ID}`))
  })

  it.each([
    ['vm.tiktok.com', 'https://vm.tiktok.com/ZMabc123/'],
    ['vt.tiktok.com', 'https://vt.tiktok.com/ZSxyz789/'],
    ['vm.tiktok.com typed without https://', 'vm.tiktok.com/ZMabc123'],
    ['vm.tiktok.com over plain http', 'http://vm.tiktok.com/ZMabc123/'],
    ['www.tiktok.com/t/', 'https://www.tiktok.com/t/ZTabc123/'],
  ])('follows a %s share link to the video it points to', async (_label, proof) => {
    const fetchMock = stubShareThenOembed(`https://www.tiktok.com/@testuser/video/${VIDEO_ID}?_r=1&_t=xyz`)
    const result = await verifier.verify('testuser', proof, npub)
    expect(result.verified).toBe(true)
    const [shareUrl, shareInit] = fetchMock.mock.calls[0]
    expect(new URL(shareUrl).protocol).toBe('https:')
    expect(shareInit.redirect).toBe('manual')
    expect(fetchMock.mock.calls[1][0]).toContain(encodeURIComponent(`https://www.tiktok.com/@testuser/video/${VIDEO_ID}`))
  })

  it.each([
    ['somewhere other than TikTok', 'https://example.com/@testuser/video/7123456789012345678'],
    ['to another share link', 'https://vm.tiktok.com/ZMother/'],
    ['to another /t/ share link', 'https://www.tiktok.com/t/ZTother/'],
    ['to a TikTok page that is not a video', 'https://www.tiktok.com/foryou'],
    ['to a TikTok video over plain http', 'http://www.tiktok.com/@testuser/video/7123456789012345678'],
  ])('does not accept a share link that leads %s', async (_label, location) => {
    const fetchMock = stubShareThenOembed(location)
    const result = await verifier.verify('testuser', 'https://vm.tiktok.com/ZMabc123/', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toBe('Could not open that TikTok share link. Paste the full post link instead.')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('explains a share link that does not redirect', async () => {
    stubShareThenOembed(null, 404)
    const result = await verifier.verify('testuser', 'https://vm.tiktok.com/ZMabc123/', npub)
    expect(result.error).toBe('Could not open that TikTok share link. Paste the full post link instead.')
  })

  it('explains a share link that cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const result = await verifier.verify('testuser', 'https://vm.tiktok.com/ZMabc123/', npub)
    expect(result.error).toBe('Could not open that TikTok share link. Paste the full post link instead.')
  })

  it('only follows share links on TikTok\'s own share hosts', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await verifier.verify('testuser', 'https://vm.tiktok.com.example.com/ZMabc123/', npub)
    expect(result.verified).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a share link with extra path parts', 'https://vm.tiktok.com/ZMabc123/extra/'],
    ['a share code with other characters', 'https://vm.tiktok.com/ZM-abc_123/'],
    ['a /t/ link with extra path parts', 'https://www.tiktok.com/t/ZTabc123/extra/'],
    ['another tiktok.com subdomain', 'https://foo.tiktok.com/ZMabc123/'],
    ['a bare @', 'https://www.tiktok.com/@'],
    ['a video link with a non-numeric id', 'https://www.tiktok.com/@testuser/video/abc'],
    ['a video link with extra path parts', `https://www.tiktok.com/@testuser/video/${VIDEO_ID}/extra`],
    ['a number that is too short', '123'],
    ['an embed link without a number', 'https://www.tiktok.com/embed/abc'],
    ['a v2 embed link without a number', 'https://www.tiktok.com/embed/v2/abc'],
    ['an embed link with extra path parts', `https://www.tiktok.com/embed/a/b/${VIDEO_ID}`],
    ['an embed link with an unknown middle part', `https://www.tiktok.com/embed/a/${VIDEO_ID}`],
    ['an older mobile link without a number', 'https://m.tiktok.com/v/abc.html'],
    ['an older mobile link with extra path parts', `https://m.tiktok.com/v/${VIDEO_ID}.html/extra`],
    ['an older mobile link with a number that is too long', `https://m.tiktok.com/v/${'1'.repeat(26)}.html`],
    ['a number that is too long', '1'.repeat(26)],
    ['a video link with a number that is too long', `https://www.tiktok.com/@testuser/video/${'1'.repeat(26)}`],
    ['an embed link with a number that is too long', `https://www.tiktok.com/embed/${'1'.repeat(26)}`],
    ['a link to something other than a video or photo', `https://www.tiktok.com/@testuser/live/${VIDEO_ID}`],
    ['a /t/ link with other characters', 'https://www.tiktok.com/t/ZT-abc_123/'],
  ])('does not accept %s', async (_label, proof) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await verifier.verify('testuser', proof, npub)
    expect(result.error).toBe('Paste a TikTok video or photo link (or the post number from it).')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['http://vm.tiktok.com/ZMabc123/?_r=1', 'https://vm.tiktok.com/ZMabc123/'],
    ['http://tiktok.com/t/ZTabc123?_r=1', 'https://www.tiktok.com/t/ZTabc123/'],
  ])('looks up %s as %s, over https and without the extras', async (proof, lookedUp) => {
    const fetchMock = stubShareThenOembed(`https://www.tiktok.com/@testuser/video/${VIDEO_ID}`)
    await verifier.verify('testuser', proof, npub)
    expect(fetchMock.mock.calls[0][0]).toBe(lookedUp)
  })

  it('closes the share link response after reading where it points', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 301, headers: new Headers({ Location: `https://www.tiktok.com/@testuser/video/${VIDEO_ID}` }), body: { cancel } })
      .mockResolvedValueOnce(oembedOk()))
    await verifier.verify('testuser', 'https://vm.tiktok.com/ZMabc123/', npub)
    expect(cancel).toHaveBeenCalled()
  })

  it.each([200, 404])('only trusts a share link answer that is a redirect (not %i)', async (status) => {
    stubShareThenOembed(`https://www.tiktok.com/@testuser/video/${VIDEO_ID}`, status)
    const result = await verifier.verify('testuser', 'https://vm.tiktok.com/ZMabc123/', npub)
    expect(result.error).toBe('Could not open that TikTok share link. Paste the full post link instead.')
  })

  it('explains that a profile link cannot prove anything', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await verifier.verify('testuser', 'https://www.tiktok.com/@testuser', npub)
    expect(result).toEqual({ verified: false, error: 'That is a TikTok profile link. Paste a link to a post whose caption contains your npub.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a photo post link', `https://www.tiktok.com/@testuser/photo/${VIDEO_ID}`],
    ['a photo post link with tracking parameters', `https://www.tiktok.com/@testuser/photo/${VIDEO_ID}?_r=1&_t=abc`],
  ])('verifies %s by asking TikTok for that post number', async (_label, proof) => {
    const fetchMock = vi.fn().mockResolvedValue(oembedOk())
    vi.stubGlobal('fetch', fetchMock)
    const result = await verifier.verify('testuser', proof, npub)
    expect(result).toEqual({ verified: true, canonicalProof: VIDEO_ID })
    // TikTok's oEmbed only answers for a photo post in the /video/ form.
    expect(fetchMock.mock.calls[0][0]).toContain(encodeURIComponent(`https://www.tiktok.com/@testuser/video/${VIDEO_ID}`))
  })

  it('explains a share link that leads to a profile', async () => {
    stubShareThenOembed('https://www.tiktok.com/@testuser?_t=xyz')
    const result = await verifier.verify('testuser', 'https://vm.tiktok.com/ZMabc123/', npub)
    expect(result.error).toBe('That is a TikTok profile link. Paste a link to a post whose caption contains your npub.')
  })

  it.each([
    ['a look-alike host', 'https://www.tiktok.com.example.com/@testuser/video/7123456789012345678'],
    ['another site ending in tiktok.com', 'https://notiktok.com/@testuser/video/7123456789012345678'],
  ])('does not treat %s as TikTok', async (_label, proof) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await verifier.verify('testuser', proof, npub)
    expect(result.error).toBe('Paste a TikTok video or photo link (or the post number from it).')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('follows a share link that leads to a photo post and verifies it', async () => {
    const fetchMock = stubShareThenOembed(`https://www.tiktok.com/@testuser/photo/${VIDEO_ID}?_r=1&_t=xyz`)
    const result = await verifier.verify('testuser', 'https://www.tiktok.com/t/ZTabc123/', npub)
    expect(result.verified).toBe(true)
    expect(fetchMock.mock.calls[1][0]).toContain(encodeURIComponent(`https://www.tiktok.com/@testuser/video/${VIDEO_ID}`))
  })

  it('says plainly when TikTok cannot find the video or it is not public', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ message: 'Something went wrong' }) }))
    const result = await verifier.verify('testuser', VIDEO_ID, npub)
    expect(result).toEqual({ verified: false, error: 'TikTok post not found or not public' })
  })

  it('checks the account name before following any share link', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await verifier.verify('bad user!', 'https://vm.tiktok.com/ZMabc123/', npub)
    expect(result.error).toContain('Invalid TikTok username')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says plainly when TikTok does not say whose post it is', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ author_url: 'https://www.tiktok.com/', title: '' }) }))
    const result = await verifier.verify('testuser', VIDEO_ID, npub)
    expect(result).toEqual({ verified: false, error: 'TikTok did not say whose post this is, so it cannot be checked.' })
  })

  it.each([
    ['a share link', 'https://vm.tiktok.com/ZMabc123/', true],
    ['a full video link', `https://www.tiktok.com/@testuser/video/${VIDEO_ID}?_r=1`, false],
    ['a photo post link', `https://www.tiktok.com/@testuser/photo/${VIDEO_ID}`, false],
  ])('reports the post number to publish after verifying %s', async (_label, proof, viaShare) => {
    if (viaShare) stubShareThenOembed(`https://www.tiktok.com/@testuser/video/${VIDEO_ID}`)
    else vi.stubGlobal('fetch', vi.fn().mockResolvedValue(oembedOk()))
    const result = await verifier.verify('testuser', proof, npub)
    expect(result).toEqual({ verified: true, canonicalProof: VIDEO_ID })
  })

  it('rejects a share link that leads to someone else\'s post, with no post number', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 301, headers: new Headers({ Location: `https://www.tiktok.com/@someoneelse/video/${VIDEO_ID}` }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ author_unique_id: 'someoneelse', title: `key ${npub}` }) }))
    const result = await verifier.verify('testuser', 'https://vm.tiktok.com/ZMabc123/', npub)
    expect(result).toEqual({ verified: false, error: 'Post author does not match claimed identity' })
  })

  it('reports no separate post number when the proof already is one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(oembedOk()))
    expect(await verifier.verify('testuser', VIDEO_ID, npub)).toEqual({ verified: true })
  })

  it('reports no post number when verification fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ author_unique_id: 'testuser', title: 'no key here' }) }))
    const result = await verifier.verify('testuser', `https://www.tiktok.com/@testuser/video/${VIDEO_ID}`, npub)
    expect(result.verified).toBe(false)
    expect(result).not.toHaveProperty('canonicalProof')
  })

  it('explains what to paste when the proof is not a TikTok video', async () => {
    const result = await verifier.verify('testuser', 'not a link', npub)
    expect(result).toEqual({ verified: false, error: 'Paste a TikTok video or photo link (or the post number from it).' })
  })
})
