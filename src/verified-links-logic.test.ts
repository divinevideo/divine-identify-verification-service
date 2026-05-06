import { describe, expect, it } from 'vitest'
import {
  claimKeyForLink,
  mergeVerifiedLinksIntoITags,
  upsertVerifiedLinkList,
} from './verified-links-logic'

describe('claimKeyForLink', () => {
  it('joins platform and identity with colon', () => {
    expect(claimKeyForLink('twitter', 'jack')).toBe('twitter:jack')
  })

  it('handles empty parts', () => {
    expect(claimKeyForLink('', 'x')).toBe(':x')
    expect(claimKeyForLink('gh', '')).toBe('gh:')
  })
})

describe('upsertVerifiedLinkList', () => {
  it('appends new link', () => {
    const a: { platform: string; identity: string; proof: string }[] = []
    const b = upsertVerifiedLinkList(a, { platform: 'twitter', identity: 'a', proof: 'p1' })
    expect(b).toHaveLength(1)
    expect(b[0]).toEqual({ platform: 'twitter', identity: 'a', proof: 'p1' })
    expect(a).toHaveLength(0)
  })

  it('replaces same platform:identity case-insensitively', () => {
    const list = upsertVerifiedLinkList([], { platform: 'twitter', identity: 'Foo', proof: 'o' })
    const next = upsertVerifiedLinkList(list, { platform: 'twitter', identity: 'foo', proof: 'oauth' })
    expect(next).toHaveLength(1)
    expect(next[0].proof).toBe('oauth')
    expect(next[0].identity).toBe('foo')
  })

  it('keeps distinct identities', () => {
    let list = upsertVerifiedLinkList([], { platform: 'twitter', identity: 'a', proof: '1' })
    list = upsertVerifiedLinkList(list, { platform: 'twitter', identity: 'b', proof: '2' })
    expect(list).toHaveLength(2)
  })
})

describe('mergeVerifiedLinksIntoITags', () => {
  it('adds new i tag', () => {
    const out = mergeVerifiedLinksIntoITags([], [{ platform: 'github', identity: 'octocat', proof: 'abc' }])
    expect(out).toEqual([['i', 'github:octocat', 'abc']])
  })

  it('strips non-i tags from input', () => {
    const out = mergeVerifiedLinksIntoITags(
      [['p', 'relays'], ['i', 'twitter:jack', 'old']],
      [{ platform: 'twitter', identity: 'jack', proof: 'y' }],
    )
    expect(out.some((t) => t[0] === 'p')).toBe(false)
    expect(out).toEqual([['i', 'twitter:jack', 'y']])
  })

  it('replaces existing claim key case-insensitively', () => {
    const out = mergeVerifiedLinksIntoITags(
      [['i', 'twitter:Jack', 'old']],
      [{ platform: 'twitter', identity: 'jack', proof: 'newproof' }],
    )
    expect(out).toEqual([['i', 'twitter:jack', 'newproof']])
  })

  it('merges multiple links in one pass', () => {
    const out = mergeVerifiedLinksIntoITags(
      [['i', 'twitter:a', 't']],
      [
        { platform: 'bluesky', identity: 'bob.bsky.social', proof: 'oauth' },
        { platform: 'twitter', identity: 'a', proof: 'updated' },
      ],
    )
    expect(out).toHaveLength(2)
    expect(out.find((t) => t[1] === 'twitter:a')).toEqual(['i', 'twitter:a', 'updated'])
    expect(out.find((t) => t[1]?.includes('bluesky'))).toEqual([
      'i',
      'bluesky:bob.bsky.social',
      'oauth',
    ])
  })
})
