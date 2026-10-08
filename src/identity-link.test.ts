import { describe, expect, it } from 'vitest'
import { matchNostrIdentityLinkRecord } from './identity-link'

describe('identity-link', () => {
  it('matches valid nostr identity link records', () => {
    const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
    const result = matchNostrIdentityLinkRecord({
      $type: 'video.divine.identity.link',
      version: 1,
      target: {
        protocol: 'nostr',
        id: npub,
      },
      gateway: {
        domain: 'atproto.brid.gy',
      },
    }, npub)

    expect(result.matched).toBe(true)
    expect(result.gateway?.domain).toBe('atproto.brid.gy')
  })

  it('rejects non-matching records', () => {
    const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
    const result = matchNostrIdentityLinkRecord({
      $type: 'video.divine.identity.link',
      version: 1,
      target: {
        protocol: 'nostr',
        id: 'npub1wrong',
      },
    }, npub)

    expect(result.matched).toBe(false)
  })
})
