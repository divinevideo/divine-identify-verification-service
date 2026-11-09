import { afterEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { DIVINE_RELAY, readLinkedAccounts } from './linked-accounts'

// A well-behaved relay never returns another author's event, so this one is stubbed
// at the query layer to misbehave.
vi.mock('../utils/relay', () => ({ queryRelay: vi.fn() }))
import { queryRelay } from '../utils/relay'

afterEach(() => { vi.clearAllMocks() })

describe('readLinkedAccounts with a relay that ignores the author filter', () => {
  it('ignores events by another author', async () => {
    const mine = hexToBytes('11'.repeat(32))
    const theirs = hexToBytes('22'.repeat(32))
    const pubkey = bytesToHex(schnorr.getPublicKey(theirs))
    const tags = [['i', 'github:alice', '1']]
    const id = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(JSON.stringify([0, pubkey, 100, 10011, tags, ''])))))
    const event = { id, pubkey, sig: bytesToHex(schnorr.sign(hexToBytes(id), theirs)), kind: 10011, tags, created_at: 100, content: '' }
    vi.mocked(queryRelay).mockImplementation(async (url: string) => url === DIVINE_RELAY ? [event] : [])
    expect(await readLinkedAccounts(bytesToHex(schnorr.getPublicKey(mine)))).toEqual({ read: false, event: null })
  })
})
