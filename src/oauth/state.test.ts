import { describe, it, expect, beforeEach, vi } from 'vitest'
import { oauthVerificationKey, deleteOAuthVerification, storeOAuthVerification, getOAuthVerification } from './state'

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
  function spyKV() {
    const store = new Map<string, string>()
    const put = vi.fn(async (key: string, value: string, _opts?: { expirationTtl?: number }) => { store.set(key, value) })
    return { kv: { get: async (key: string) => store.get(key) ?? null, put, delete: async () => {} } as unknown as KVNamespace, put, store }
  }
  const base = { pubkey: 'aabb', verified: true as const, method: 'oauth' as const, checked_at: 1 }

  // How long a confirmed record counts is decided when it is read
  // (signin-lifetime.ts), so storage keeps it with no expiry.
  it.each([
    ['a Bluesky', { platform: 'bluesky' as const, identity: 'alice.bsky.social', account_id: 'did:plc:alice', handle: 'alice.bsky.social' }],
    ['a TikTok', { platform: 'tiktok' as const, identity: 'creator', account_id: 'acct-1' }],
    ['a Twitter', { platform: 'twitter' as const, identity: 'jack' }],
  ])('stores %s confirmed record with no expiry, marked as such', async (_label, record) => {
    const { kv, put, store } = spyKV()
    await storeOAuthVerification(kv, { ...base, ...record, confirmed: true })
    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0][2]?.expirationTtl).toBeUndefined()
    expect(JSON.parse(store.get(oauthVerificationKey(record.platform, record.identity, 'aabb')) ?? '{}')).toMatchObject({ ...record, confirmed: true, stored_without_expiry: true })
  })

  it('stores an unconfirmed record for a day, without the marker', async () => {
    const { kv, put, store } = spyKV()
    await storeOAuthVerification(kv, { ...base, platform: 'bluesky', identity: 'alice.bsky.social', account_id: 'did:plc:alice' })
    expect(put.mock.calls[0][2]).toEqual({ expirationTtl: 86400 })
    expect(JSON.parse(store.get(oauthVerificationKey('bluesky', 'alice.bsky.social', 'aabb')) ?? '{}').stored_without_expiry).toBeUndefined()
  })
})
