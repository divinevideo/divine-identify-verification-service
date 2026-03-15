import { describe, it, expect, beforeEach } from 'vitest'
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
