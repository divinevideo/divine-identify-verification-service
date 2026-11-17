import { describe, it, expect, beforeEach, vi } from 'vitest'
import { oauthVerificationKey, deleteOAuthVerification, storeOAuthVerification, getOAuthVerification } from './state'
import type { OAuthVerification } from '../types'

// Minimal KV mock for Workers pool
function createMockKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
  } as unknown as KVNamespace
}

describe('oauthVerificationKey', () => {
  it('normalizes identity to lowercase', () => {
    const key = oauthVerificationKey('twitter', 'AliceJones', 'aabb')
    expect(key).toBe('oauth_verified:twitter:alicejones:aabb')
  })
})

describe('deleteOAuthVerification', () => {
  let kv: KVNamespace

  beforeEach(() => {
    kv = createMockKV()
  })

  it('deletes an existing verification entry', async () => {
    await storeOAuthVerification(kv, {
      platform: 'twitter',
      identity: 'alice',
      pubkey: 'aabb',
      verified: true,
      method: 'oauth',
      checked_at: Date.now(),
    })
    const before = await getOAuthVerification(kv, 'twitter', 'alice', 'aabb')
    expect(before).not.toBeNull()

    await deleteOAuthVerification(kv, 'twitter', 'alice', 'aabb')

    const after = await getOAuthVerification(kv, 'twitter', 'alice', 'aabb')
    expect(after).toBeNull()
  })

  it('succeeds silently when key does not exist (idempotent)', async () => {
    await deleteOAuthVerification(kv, 'bluesky', 'nobody', 'ccdd')
    const result = await getOAuthVerification(kv, 'bluesky', 'nobody', 'ccdd')
    expect(result).toBeNull()
  })

  it('normalizes identity case for deletion', async () => {
    await storeOAuthVerification(kv, {
      platform: 'bluesky',
      identity: 'Alice.Bsky.Social',
      pubkey: 'eeff',
      verified: true,
      method: 'oauth',
      checked_at: Date.now(),
    })

    await deleteOAuthVerification(kv, 'bluesky', 'alice.bsky.social', 'eeff')

    const after = await getOAuthVerification(kv, 'bluesky', 'Alice.Bsky.Social', 'eeff')
    expect(after).toBeNull()
  })
})

describe('storing a sign-in record', () => {
  const DAY = 24 * 60 * 60
  const DID = 'did:plc:alice'

  function spyKV() {
    const store = new Map<string, string>()
    const put = vi.fn(async (key: string, value: string, _opts?: { expirationTtl?: number }) => { store.set(key, value) })
    return { kv: { get: async (key: string) => store.get(key) ?? null, put, delete: async () => {} } as unknown as KVNamespace, put, store }
  }
  const base = { pubkey: 'aabb', verified: true as const, method: 'oauth' as const, checked_at: 1 }

  // A confirmed Bluesky record with its DID has no expiry (#90); other confirmed
  // records end at the same 30 days as the age check (signin-lifetime.ts).
  // `kept` is set only for the first case, and a stale one is stripped.
  it.each([
    ['a confirmed Bluesky record with its DID', { platform: 'bluesky', identity: 'alice.bsky.social', account_id: DID, handle: 'alice.bsky.social', confirmed: true }, undefined, true],
    ['a confirmed Bluesky record without account_id', { platform: 'bluesky', identity: 'alice.bsky.social', confirmed: true }, { expirationTtl: 30 * DAY }, false],
    ['a confirmed TikTok record', { platform: 'tiktok', identity: 'creator', account_id: 'acct-1', confirmed: true }, { expirationTtl: 30 * DAY }, false],
    ['a confirmed Twitter record', { platform: 'twitter', identity: 'jack', confirmed: true }, { expirationTtl: 30 * DAY }, false],
    ['an unconfirmed Bluesky record', { platform: 'bluesky', identity: 'alice.bsky.social', account_id: DID }, { expirationTtl: DAY }, false],
  ] as const)('stores %s with the right expiry and kept flag', async (_label, fields, ttl, kept) => {
    const { kv, put, store } = spyKV()
    const rec = { ...base, ...fields, kept: true } as unknown as OAuthVerification
    await storeOAuthVerification(kv, rec)
    expect(put).toHaveBeenCalledTimes(1)
    const call = put.mock.calls[0] as unknown as unknown[]
    expect(call[2]).toEqual(ttl)
    if (!ttl) expect(call).toHaveLength(2)
    const stored = JSON.parse(store.get(oauthVerificationKey(rec.platform, rec.identity, 'aabb')) ?? '{}')
    expect(stored).toMatchObject(fields)
    if (kept) expect(stored.kept).toBe(true)
    else expect(stored).not.toHaveProperty('kept')
  })
})
