import { describe, expect, it } from 'vitest'
import { proofUrl, renderVerifyHtml } from './verify'
import { MESSAGE_LINK_HOSTS } from '../platforms/discord'
import type { VerifyResult } from '../types'

const FAKE_RESULT: VerifyResult = {
  platform: 'discord',
  identity: 'alice',
  verified: false,
  checked_at: 1700000000,
  cached: false,
}

const DISCORD_MESSAGE_LINK = 'https://discord.com/channels/1234567890123456789/2345678901234567890/3456789012345678901'

describe('proofUrl', () => {
  // A Bluesky claim may carry no proof at all: it is confirmed by sign-in or by
  // an identity-link record. There is no post to link to then.
  it.each(['bluesky', 'github', 'twitter', 'mastodon', 'youtube', 'tiktok'])('omits the link when a %s claim has no proof', (platform) => {
    expect(proofUrl(platform, 'alice', '')).toBeNull()
  })

  it.each([' ', '\t'])('omits the link when the proof is only whitespace (%j)', (blank) => {
    expect(proofUrl('bluesky', 'alice', blank)).toBeNull()
  })

  it('points a Discord proof straight at the message link it already is', () => {
    expect(proofUrl('discord', 'alice', DISCORD_MESSAGE_LINK)).toBe(DISCORD_MESSAGE_LINK)
  })

  it('omits the link for a bare Discord snowflake, since there is no guild ID to build one from', () => {
    expect(proofUrl('discord', 'alice', '3456789012345678901')).toBeNull()
  })

  it('omits the link for an unrecognized Discord proof shape', () => {
    expect(proofUrl('discord', 'alice', 'not-a-link')).toBeNull()
  })

  it('upgrades an HTTP Discord proof link before rendering it', () => {
    expect(proofUrl('discord', 'alice', DISCORD_MESSAGE_LINK.replace('https:', 'http:'))).toBe(DISCORD_MESSAGE_LINK)
  })

  it('leaves other platforms unchanged', () => {
    expect(proofUrl('github', 'octocat', 'abc123')).toBe('https://gist.github.com/octocat/abc123')
    expect(proofUrl('twitter', 'jack', '123')).toBe('https://x.com/jack/status/123')
  })
})

describe('renderVerifyHtml — "View proof post" link', () => {
  function render(proof: string): string {
    return renderVerifyHtml(
      { ...FAKE_RESULT, identity: 'alice' },
      'discord',
      'alice',
      proof,
      'a'.repeat(64),
      'npub1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'https://verifier.divine.video/verify/discord/alice/x?pubkey=' + 'a'.repeat(64),
      'https://verifier.divine.video',
    )
  }

  it('points at the Discord message, not a discord.gg invite URL', () => {
    const html = render(DISCORD_MESSAGE_LINK)
    expect(html).toContain(`href="${DISCORD_MESSAGE_LINK}"`)
    expect(html).not.toContain('discord.gg')
  })

  it('renders no proof link at all for a bare snowflake proof', () => {
    const html = render('3456789012345678901')
    expect(html).not.toContain('View proof post')
  })

  it('renders no proof link for a Bluesky claim with no proof', () => {
    const html = renderVerifyHtml(
      { ...FAKE_RESULT, platform: 'bluesky', identity: 'alice.bsky.social' },
      'bluesky',
      'alice.bsky.social',
      '',
      'a'.repeat(64),
      'npub1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'https://verifier.divine.video/verify/bluesky/alice.bsky.social/?pubkey=' + 'a'.repeat(64),
      'https://verifier.divine.video',
    )
    expect(html).not.toContain('View proof post')
    expect(html).not.toContain('bsky.app/profile/alice.bsky.social/post/"')
  })
})

describe('renderVerifyHtml — embedded client-side proof link (other verified identities)', () => {
  function embeddedProofUrl(): (platform: string, identity: string, proof: string) => string | null {
    const html = renderVerifyHtml(
      FAKE_RESULT,
      'discord',
      'alice',
      DISCORD_MESSAGE_LINK,
      'a'.repeat(64),
      'npub1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'https://verifier.divine.video/verify/discord/alice/x',
      'https://verifier.divine.video',
    )
    const start = html.indexOf('var DISCORD_MESSAGE_LINK_HOSTS = ')
    expect(start).toBeGreaterThan(-1)
    const end = html.indexOf('function platformIconHtml(', start)
    expect(end).toBeGreaterThan(start)
    return new Function(`${html.slice(start, end)}\nreturn proofUrl;`)()
  }

  it('also points a Discord message link straight at itself', () => {
    const fn = embeddedProofUrl()
    const canaryLink = DISCORD_MESSAGE_LINK.replace('discord.com', 'canary.discord.com')
    expect(fn('discord', 'alice', canaryLink)).toBe(canaryLink)
  })

  it('also omits the link for a bare snowflake', () => {
    const fn = embeddedProofUrl()
    expect(fn('discord', 'alice', '3456789012345678901')).toBeNull()
  })

  it.each(['bluesky', 'github', 'twitter'])('also omits the link when a %s claim has no proof', (platform) => {
    const fn = embeddedProofUrl()
    expect(fn(platform, 'alice', '')).toBeNull()
  })

  it.each([' ', '\t'])('also omits the link when the proof is only whitespace (%j)', (blank) => {
    const fn = embeddedProofUrl()
    expect(fn('bluesky', 'alice', blank)).toBeNull()
  })

  // Claims come from tags on events fetched from relays, which aren't checked
  // here, so a proof may not even be text. One odd tag must not break the list.
  it.each([123, ['x'], { a: 1 }, true])('omits the link, without throwing, when a proof is not text (%j)', (odd) => {
    const fn = embeddedProofUrl() as unknown as (platform: string, identity: string, proof: unknown) => string | null
    expect(fn('github', 'alice', odd)).toBeNull()
  })

  it('uses the server allowlist for every Discord client host', () => {
    const fn = embeddedProofUrl()
    for (const host of MESSAGE_LINK_HOSTS) {
      const link = DISCORD_MESSAGE_LINK.replace('discord.com', host)
      expect(fn('discord', 'alice', link)).toBe(link)
    }
  })

  it('upgrades an HTTP Discord proof link before rendering it', () => {
    const fn = embeddedProofUrl()
    expect(fn('discord', 'alice', DISCORD_MESSAGE_LINK.replace('https:', 'http:'))).toBe(DISCORD_MESSAGE_LINK)
  })

  it('leaves other platforms unchanged', () => {
    const fn = embeddedProofUrl()
    expect(fn('github', 'octocat', 'abc123')).toBe('https://gist.github.com/octocat/abc123')
  })
})

describe('TikTok proof links', () => {
  const ID = '7123456789012345678'
  const CANONICAL = `https://www.tiktok.com/@alice/video/${ID}`

  function embeddedProofUrl(): (platform: string, identity: string, proof: string) => string | null {
    const html = renderVerifyHtml(
      FAKE_RESULT, 'tiktok', 'alice', ID, 'a'.repeat(64),
      'npub1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'https://verifier.divine.video/verify/tiktok/alice/x', 'https://verifier.divine.video',
    )
    const start = html.indexOf('var DISCORD_MESSAGE_LINK_HOSTS = ')
    const end = html.indexOf('function platformIconHtml(', start)
    expect(end).toBeGreaterThan(start)
    return new Function(`${html.slice(start, end)}\nreturn proofUrl;`)()
  }

  it.each([
    ['a video number', ID, CANONICAL],
    ['a full video link', `https://www.tiktok.com/@alice/video/${ID}?_r=1`, CANONICAL],
    ['a mobile video link', `https://m.tiktok.com/@alice/video/${ID}`, CANONICAL],
    ['a photo post link', `https://www.tiktok.com/@alice/photo/${ID}?_r=1`, `https://www.tiktok.com/@alice/photo/${ID}`],
    ['a share link', 'https://vm.tiktok.com/ZMabc123/', null],
    ['a profile link', 'https://www.tiktok.com/@alice', null],
    ['a link elsewhere', `https://example.com/@alice/video/${ID}`, null],
    ['a link with a number that is too long', `https://www.tiktok.com/@alice/video/${'1'.repeat(26)}`, null],
    ['a number that is too long', '1'.repeat(26), null],
    ['something that is not a number', 'abc', null],
    ['a video path on a share-link host', `https://vm.tiktok.com/@alice/video/${ID}`, null],
    ['a TikTok link inside another site\'s link', `https://example.com/?u=https://www.tiktok.com/@alice/video/${ID}`, null],
    ['a video link with an uppercase path', `https://www.tiktok.com/@alice/VIDEO/${ID}`, CANONICAL],
  ])('links %s correctly, on the server and in the page', (_label, proof, expected) => {
    expect(proofUrl('tiktok', 'alice', proof)).toBe(expected)
    expect(embeddedProofUrl()('tiktok', 'alice', proof)).toBe(expected)
  })
})

describe('TikTok proof link on the verification-link page', () => {
  it('links the post number the verifier resolved when the proof is a share link', () => {
    const html = renderVerifyHtml(
      { platform: 'tiktok', identity: 'alice', verified: true, canonical_proof: '7123456789012345678', checked_at: 1700000000, cached: false },
      'tiktok', 'alice', 'https://vm.tiktok.com/ZMabc123/', 'a'.repeat(64),
      'npub1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'https://verifier.divine.video/verify/tiktok/alice/x', 'https://verifier.divine.video',
    )
    expect(html).toContain('href="https://www.tiktok.com/@alice/video/7123456789012345678"')
  })

  it('uses the resolved post number for other linked accounts too', () => {
    const html = renderVerifyHtml(FAKE_RESULT, 'discord', 'alice', DISCORD_MESSAGE_LINK, 'a'.repeat(64),
      'npub1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'https://verifier.divine.video/verify/discord/alice/x', 'https://verifier.divine.video')
    expect(html).toContain('proofUrl(claims[k].platform, claims[k].identity, data.results[k].canonical_proof || claims[k].proof)')
  })
})
