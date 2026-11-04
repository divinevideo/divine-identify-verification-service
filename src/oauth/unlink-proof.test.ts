import { describe, it, expect } from 'vitest'
import type { OAuthVerification } from '../types'
import type { SignedNostrEvent } from '../utils/nostr-event'
import { listHoldsClaim, listIsNewerThanLink, readNostrAuthorization, sha256Hex } from './unlink-proof'

const PUBKEY = 'ab'.repeat(32)
const DID = 'did:plc:alice111111111111111111'

function rec(over: Partial<OAuthVerification> = {}): OAuthVerification {
  return {
    platform: 'twitter', identity: 'alice', pubkey: PUBKEY, verified: true, method: 'oauth',
    checked_at: 1000, confirmed: true, confirm_event_id: '5'.repeat(64), confirm_created_at: 2000,
    ...over,
  }
}

function unconfirmed(): OAuthVerification {
  const { confirmed: _c, confirm_event_id: _id, confirm_created_at: _at, ...rest } = rec()
  return rest
}

function list(tags: string[][]): SignedNostrEvent {
  return { id: '9'.repeat(64), pubkey: PUBKEY, sig: 'cd'.repeat(64), kind: 10011, created_at: 3000, content: '', tags }
}

describe('listIsNewerThanLink', () => {
  it('counts a list dated after the confirmation', () => {
    expect(listIsNewerThanLink({ id: '9'.repeat(64), created_at: 2001 }, rec())).toBe(true)
  })

  it('refuses a list dated before the confirmation', () => {
    expect(listIsNewerThanLink({ id: '9'.repeat(64), created_at: 1999 }, rec())).toBe(false)
  })

  it('on the same second, counts only a lower id, as NIP-01 orders replaceable events', () => {
    expect(listIsNewerThanLink({ id: '4'.repeat(64), created_at: 2000 }, rec())).toBe(true)
    expect(listIsNewerThanLink({ id: '6'.repeat(64), created_at: 2000 }, rec())).toBe(false)
  })

  it('refuses the confirming list itself', () => {
    expect(listIsNewerThanLink({ id: '5'.repeat(64), created_at: 2000 }, rec())).toBe(false)
  })

  it('uses checked_at for a record never confirmed', () => {
    expect(listIsNewerThanLink({ id: '0'.repeat(64), created_at: 1000 }, unconfirmed())).toBe(false)
    expect(listIsNewerThanLink({ id: '9'.repeat(64), created_at: 1001 }, unconfirmed())).toBe(true)
  })
})

describe('listHoldsClaim', () => {
  it('holds the claim when the list still names it', () => {
    expect(listHoldsClaim(list([['i', 'twitter:alice', 'oauth']]), 'twitter', 'alice', rec())).toBe(true)
  })

  it('ignores case in the platform and identity', () => {
    expect(listHoldsClaim(list([['i', 'Twitter:ALICE', 'oauth']]), 'twitter', 'alice', rec())).toBe(true)
  })

  it('reads a tidied identity as the same claim', () => {
    expect(listHoldsClaim(list([['i', 'twitter:@Alice', 'oauth']]), 'twitter', 'alice', rec())).toBe(true)
    const channel = 'UC' + 'a'.repeat(22)
    const youtube = rec({ platform: 'youtube', identity: channel })
    const tags = [['i', 'youtube:https://www.youtube.com/channel/' + channel, 'oauth']]
    expect(listHoldsClaim(list(tags), 'youtube', channel, youtube)).toBe(true)
  })

  it('reads an x tag as the same claim as twitter', () => {
    expect(listHoldsClaim(list([['i', 'x:alice', 'oauth']]), 'twitter', 'alice', rec())).toBe(true)
    expect(listHoldsClaim(list([['i', 'X:Alice', 'oauth']]), 'twitter', 'alice', rec())).toBe(true)
  })

  it('ignores spaces around the platform in a tag', () => {
    expect(listHoldsClaim(list([['i', ' twitter :alice', 'oauth']]), 'twitter', 'alice', rec())).toBe(true)
  })

  it('holds the claim under the identity asked for or the one the record was saved by', () => {
    const saved = rec({ identity: 'alice_old' })
    expect(listHoldsClaim(list([['i', 'twitter:alice', 'oauth']]), 'twitter', 'alice', saved)).toBe(true)
    expect(listHoldsClaim(list([['i', 'twitter:alice_old', 'oauth']]), 'twitter', 'alice', saved)).toBe(true)
  })

  it('does not count the same name on another platform', () => {
    expect(listHoldsClaim(list([['i', 'github:alice', 'x']]), 'twitter', 'alice', rec())).toBe(false)
  })

  it('does not count malformed tags', () => {
    expect(listHoldsClaim(list([['i'], ['i', 'twitter'], ['p', 'twitter:alice']]), 'twitter', 'alice', rec())).toBe(false)
  })

  it('holds a Bluesky claim while either its handle or its DID is listed', () => {
    const bluesky = rec({ platform: 'bluesky', identity: 'alice.bsky.social', handle: 'alice.bsky.social', account_id: DID })
    const didOnly = list([['i', `bluesky:${DID}`, 'oauth']])
    const handleOnly = list([['i', 'bluesky:alice.bsky.social', 'oauth']])
    const neither = list([['i', 'bluesky:bob.bsky.social', 'oauth']])
    expect(listHoldsClaim(didOnly, 'bluesky', 'alice.bsky.social', bluesky)).toBe(true)
    const byDid = rec({ platform: 'bluesky', identity: DID, handle: 'alice.bsky.social', account_id: DID })
    expect(listHoldsClaim(handleOnly, 'bluesky', DID, byDid)).toBe(true)
    expect(listHoldsClaim(neither, 'bluesky', 'alice.bsky.social', bluesky)).toBe(false)
  })

  it('counts only a Bluesky account ID as the same claim', () => {
    const twitter = rec({ account_id: '12345' })
    expect(listHoldsClaim(list([['i', 'twitter:12345', 'oauth']]), 'twitter', 'alice', twitter)).toBe(false)
  })
})

describe('readNostrAuthorization', () => {
  it('reads no header, or another scheme, as absent', () => {
    expect(readNostrAuthorization(undefined)).toEqual({ kind: 'absent' })
    expect(readNostrAuthorization('Bearer abc')).toEqual({ kind: 'absent' })
  })

  it('decodes a Nostr header into its event', () => {
    expect(readNostrAuthorization('nostr ' + btoa('{"kind":27235}'))).toEqual({ kind: 'event', event: { kind: 27235 } })
  })

  it('reads a Nostr header it cannot decode as malformed', () => {
    expect(readNostrAuthorization('Nostr')).toEqual({ kind: 'malformed' })
    expect(readNostrAuthorization('Nostr !!!')).toEqual({ kind: 'malformed' })
    expect(readNostrAuthorization('Nostr ' + btoa('not json'))).toEqual({ kind: 'malformed' })
  })
})

describe('sha256Hex', () => {
  it('hashes bytes to lowercase hex', async () => {
    const bytes = (text: string) => new TextEncoder().encode(text)
    expect(await sha256Hex(bytes(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(await sha256Hex(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
