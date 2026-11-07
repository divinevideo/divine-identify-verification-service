import { afterEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { fakeRelays, type FakeRelay } from '../contract/harness'
import type { SignedNostrEvent } from '../utils/nostr-event'
import { DIVINE_RELAY, linkedAccountClaims, readLinkedAccounts, readLinkedAccountsOf } from './linked-accounts'

const SECRET = hexToBytes('11'.repeat(32))
const OTHER_SECRET = hexToBytes('22'.repeat(32))
const PK = bytesToHex(schnorr.getPublicKey(SECRET))

async function signed(kind: number, tags: string[][], createdAt: number, secret = SECRET): Promise<SignedNostrEvent> {
  const pubkey = bytesToHex(schnorr.getPublicKey(secret))
  const serialized = JSON.stringify([0, pubkey, createdAt, kind, tags, ''])
  const id = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))))
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secret))
  return { id, pubkey, sig, kind, tags, created_at: createdAt, content: '' }
}

const relay = (url: string, events: unknown[] = [], over: Partial<FakeRelay> = {}): FakeRelay =>
  ({ url, events, seenFilters: [], ...over })
const DAMUS = 'wss://relay.damus.io'
const PRIMAL = 'wss://relay.primal.net'
const tag = (platform: string, proof = '123'): string[] => ['i', `${platform}:someone`, proof]

afterEach(() => { vi.unstubAllGlobals() })

// Relays that send these events whatever the REQ asked for, as a misbehaving relay may,
// so events no filter would match still arrive.
function sendRegardless(eventsByRelay: Record<string, unknown[]>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).replace(/^https:/, 'wss:')
    const socket = new EventTarget() as EventTarget & { accept(): void; send(m: string): void; close(): void }
    socket.accept = () => {}
    socket.close = () => {}
    socket.send = (message: string) => {
      const [verb, sub] = JSON.parse(message)
      if (verb !== 'REQ') return
      const frames = [...(eventsByRelay[url] ?? []).map(e => ['EVENT', sub, e]), ['EOSE', sub]]
      for (const frame of frames) {
        queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })))
      }
    }
    return { status: 101, webSocket: socket } as unknown as Response
  }))
}

describe('readLinkedAccounts', () => {
  it('takes the newest list across relays', async () => {
    const older = await signed(10011, [tag('github')], 100)
    const newer = await signed(10011, [tag('twitter')], 200)
    fakeRelays([relay(DIVINE_RELAY, [older]), relay(DAMUS, [newer]), relay(PRIMAL)])
    expect(await readLinkedAccounts(PK)).toEqual({ read: true, event: newer })
  })

  it('breaks a tie on created_at with the lowest id', async () => {
    const a = await signed(10011, [tag('github')], 100)
    const b = await signed(10011, [tag('twitter')], 100)
    const [low, high] = a.id < b.id ? [a, b] : [b, a]
    fakeRelays([relay(DIVINE_RELAY, [high]), relay(DAMUS, [low]), relay(PRIMAL)])
    expect((await readLinkedAccounts(PK)).event).toEqual(low)
  })

  it('falls back to the profile when there is no list', async () => {
    const profile = await signed(0, [tag('github')], 100)
    fakeRelays([relay(DIVINE_RELAY, [profile]), relay(DAMUS), relay(PRIMAL)])
    expect(await readLinkedAccounts(PK)).toEqual({ read: true, event: profile })
  })

  it('prefers a list over a newer profile', async () => {
    const list = await signed(10011, [tag('github')], 100)
    const profile = await signed(0, [tag('twitter')], 900)
    fakeRelays([relay(DIVINE_RELAY, [list, profile]), relay(DAMUS), relay(PRIMAL)])
    expect((await readLinkedAccounts(PK)).event).toEqual(list)
  })

  it('reads an empty answer from Divine as no list', async () => {
    fakeRelays([relay(DIVINE_RELAY), relay(DAMUS), relay(PRIMAL)])
    expect(await readLinkedAccounts(PK)).toEqual({ read: true, event: null })
  })

  it("is not read when Divine's relay is down", async () => {
    const list = await signed(10011, [tag('github')], 100)
    fakeRelays([relay(DIVINE_RELAY, [], { behaviour: 'refuse' }), relay(DAMUS, [list]), relay(PRIMAL, [list])])
    expect(await readLinkedAccounts(PK)).toEqual({ read: false, event: list })
  })

  it("is not read when Divine's relay sends an event that fails its checks", async () => {
    const good = await signed(10011, [tag('github')], 100)
    // A profile, so the list filter's limit of 1 still lets both events through.
    const forged = { ...(await signed(0, [tag('twitter')], 200)), sig: 'f'.repeat(128) }
    fakeRelays([relay(DIVINE_RELAY, [good, forged]), relay(DAMUS), relay(PRIMAL)])
    expect(await readLinkedAccounts(PK)).toEqual({ read: false, event: good })
  })

  it('ignores a bad event from another relay', async () => {
    const good = await signed(10011, [tag('github')], 100)
    const forged = { ...(await signed(10011, [tag('twitter')], 200)), sig: 'f'.repeat(128) }
    fakeRelays([relay(DIVINE_RELAY, [good]), relay(DAMUS), relay(PRIMAL, [forged])])
    expect(await readLinkedAccounts(PK)).toEqual({ read: true, event: good })
  })

  it('asks every relay for the list and the profile', async () => {
    const relays = [relay(DIVINE_RELAY), relay(DAMUS), relay(PRIMAL)]
    fakeRelays(relays)
    await readLinkedAccounts(PK)
    for (const r of relays) {
      expect(r.seenFilters).toEqual([[
        { kinds: [10011], authors: [PK], limit: 1 },
        { kinds: [0], authors: [PK], limit: 1 },
      ]])
    }
  })
})

describe('readLinkedAccountsOf', () => {
  const OTHER_PK = bytesToHex(schnorr.getPublicKey(OTHER_SECRET))
  const forge = (e: SignedNostrEvent): SignedNostrEvent => ({ ...e, sig: e.sig.replace(/^./, c => (c === '0' ? '1' : '0')) })

  it('reads two people in one request per relay', async () => {
    const mine = await signed(10011, [tag('github')], 100)
    const theirs = await signed(10011, [tag('twitter')], 100, OTHER_SECRET)
    const relays = [relay(DIVINE_RELAY, [mine, theirs]), relay(DAMUS), relay(PRIMAL)]
    fakeRelays(relays)
    const reads = await readLinkedAccountsOf([PK, OTHER_PK])
    expect(reads.get(PK)).toEqual({ read: true, event: mine })
    expect(reads.get(OTHER_PK)).toEqual({ read: true, event: theirs })
    for (const r of relays) {
      expect(r.seenFilters).toEqual([[
        { kinds: [10011], authors: [PK, OTHER_PK], limit: 2 },
        { kinds: [0], authors: [PK, OTHER_PK], limit: 2 },
      ]])
    }
  })

  it('keeps the newest copy for each person', async () => {
    const myOlder = await signed(10011, [tag('github')], 100)
    const myNewer = await signed(10011, [tag('twitter')], 200)
    const theirNewer = await signed(10011, [tag('github')], 300, OTHER_SECRET)
    const theirOlder = await signed(10011, [tag('twitter')], 50, OTHER_SECRET)
    fakeRelays([relay(DIVINE_RELAY, [myOlder, theirNewer]), relay(DAMUS, [myNewer, theirOlder]), relay(PRIMAL)])
    const reads = await readLinkedAccountsOf([PK, OTHER_PK])
    expect(reads.get(PK)?.event).toEqual(myNewer)
    expect(reads.get(OTHER_PK)?.event).toEqual(theirNewer)
  })

  it("leaves only that person unread when Divine sends them an event that fails", async () => {
    const mine = await signed(10011, [tag('github')], 100)
    const theirs = forge(await signed(10011, [tag('twitter')], 100, OTHER_SECRET))
    fakeRelays([relay(DIVINE_RELAY, [mine, theirs]), relay(DAMUS), relay(PRIMAL)])
    const reads = await readLinkedAccountsOf([PK, OTHER_PK])
    expect(reads.get(PK)).toEqual({ read: true, event: mine })
    expect(reads.get(OTHER_PK)).toEqual({ read: false, event: null })
  })

  it("leaves only that person unread when Divine sends a malformed event naming them", async () => {
    const mine = await signed(10011, [tag('github')], 100)
    const theirs = await signed(10011, [tag('twitter')], 100, OTHER_SECRET)
    // A profile with no valid shape, but it says whose it is.
    const malformed = { pubkey: OTHER_PK, kind: 0, tags: [], created_at: 'soon' }
    fakeRelays([relay(DIVINE_RELAY, [mine, theirs, malformed]), relay(DAMUS), relay(PRIMAL)])
    const reads = await readLinkedAccountsOf([PK, OTHER_PK])
    expect(reads.get(PK)).toEqual({ read: true, event: mine })
    expect(reads.get(OTHER_PK)?.read).toBe(false)
  })

  it('counts malformed events against the limit they may have filled', async () => {
    const myProfile = await signed(0, [tag('github')], 100)
    // Two malformed lists naming them fill the list filter's limit of 2, so my list may
    // have been left out and my profile can't stand in for it.
    const malformed = (n: number, kind: unknown) => ({ pubkey: OTHER_PK, kind, tags: [], created_at: `soon${n}` })
    for (const kinds of [[10011, 10011], ['?', '?']]) {
      sendRegardless({ [DIVINE_RELAY]: [malformed(1, kinds[0]), malformed(2, kinds[1]), myProfile] })
      const reads = await readLinkedAccountsOf([PK, OTHER_PK])
      expect(reads.get(PK)?.read).toBe(false)
      expect(reads.get(OTHER_PK)?.read).toBe(false)
    }
  })

  it("leaves everyone unread when Divine sends an event that can't be pinned on anyone", async () => {
    const mine = await signed(10011, [tag('github')], 100)
    const theirs = await signed(10011, [tag('twitter')], 100, OTHER_SECRET)
    // Malformed, and naming no one asked about, so no author can be trusted from it.
    for (const junk of [
      { kind: 0, tags: [], created_at: 'soon' },
      { pubkey: 42, kind: 0, tags: [], created_at: 'soon' },
      { pubkey: 'c'.repeat(64), kind: 0, tags: [], created_at: 'soon' },
    ]) {
      sendRegardless({ [DIVINE_RELAY]: [mine, theirs, junk] })
      const reads = await readLinkedAccountsOf([PK, OTHER_PK])
      expect(reads.get(PK)?.read).toBe(false)
      expect(reads.get(OTHER_PK)?.read).toBe(false)
    }
  })

  it("leaves unread anyone a full answer from Divine may have left out", async () => {
    // Two copies of my list fill the shared limit of 2, so Divine's answer can't show theirs.
    const myOlder = await signed(10011, [tag('github')], 200)
    const myNewer = await signed(10011, [tag('twitter')], 300)
    const theirs = await signed(10011, [tag('github')], 100, OTHER_SECRET)
    fakeRelays([relay(DIVINE_RELAY, [myOlder, myNewer, theirs]), relay(DAMUS), relay(PRIMAL)])
    const reads = await readLinkedAccountsOf([PK, OTHER_PK])
    expect(reads.get(PK)).toEqual({ read: true, event: myNewer })
    expect(reads.get(OTHER_PK)?.read).toBe(false)
  })

  it('reads no one when asked about no one', async () => {
    const relays = [relay(DIVINE_RELAY), relay(DAMUS), relay(PRIMAL)]
    fakeRelays(relays)
    expect((await readLinkedAccountsOf([])).size).toBe(0)
    expect(relays.every(r => r.seenFilters.length === 0)).toBe(true)
  })
})

describe('linkedAccountClaims', () => {
  const event = (tags: string[][]) => ({ tags }) as SignedNostrEvent

  it('skips tags the pages skip', () => {
    const claims = linkedAccountClaims(event([
      ['x', 'github:nope', '1'],
      ['i', 'x:jack', '123'],
      ['i', 123, 'p'],
      ['i', 'github:a', 5],
      ['i'],
      ['i', 'github:noproof'],
      ['i', 'github:alice', '1'],
      ['i', 'myspace:bob', '2'],
      ['i', 'twitter:carol'],
      ['i', 'twitter:dave', ''],
      ['i', '', '3'],
      ['p', PK],
      ['i', 'mastodon:erin@example.social', '4'],
    ] as string[][]), PK)
    expect(claims).toEqual([
      { pubkey: PK, platform: 'github', identity: 'alice', proof: '1' },
      { pubkey: PK, platform: 'mastodon', identity: 'erin@example.social', proof: '4' },
    ])
  })

  it('keeps colons after the first in the identity', () => {
    const [claim] = linkedAccountClaims(event([['i', 'mastodon:a:b', '1']]), PK)
    expect(claim?.identity).toBe('a:b')
  })

  it('drops claims /verify would reject', () => {
    expect(linkedAccountClaims(event([['i', 'github:alice', 'x'.repeat(5000)]]), PK)).toEqual([])
  })

  it('returns nothing without an event', () => {
    expect(linkedAccountClaims(null, PK)).toEqual([])
  })
})
