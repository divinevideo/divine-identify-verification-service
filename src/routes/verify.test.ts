import { describe, expect, it } from 'vitest'
import { proofUrl, renderVerifyHtml } from './verify'
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
  it('points a Discord proof straight at the message link it already is', () => {
    expect(proofUrl('discord', 'alice', DISCORD_MESSAGE_LINK)).toBe(DISCORD_MESSAGE_LINK)
  })

  it('omits the link for a bare Discord snowflake, since there is no guild ID to build one from', () => {
    expect(proofUrl('discord', 'alice', '3456789012345678901')).toBeNull()
  })

  it('omits the link for an unrecognized Discord proof shape', () => {
    expect(proofUrl('discord', 'alice', 'not-a-link')).toBeNull()
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
    const start = html.indexOf('function proofUrl(')
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

  it('leaves other platforms unchanged', () => {
    const fn = embeddedProofUrl()
    expect(fn('github', 'octocat', 'abc123')).toBe('https://gist.github.com/octocat/abc123')
  })
})
