import { describe, expect, it, vi } from 'vitest'

// A platform that reports its own clean values for a claim that tidying also
// changed: the platform's values are the ones handed back.
vi.mock('../platforms/registry', () => ({
  getVerifier: () => ({
    name: 'twitter',
    label: 'Twitter / X',
    verify: async () => ({ verified: true, canonicalIdentity: 'platform-alice', canonicalProof: '42' }),
  }),
}))

import worker from '../index'

const PUBKEY = '9'.repeat(64)

function createMockKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
  } as unknown as KVNamespace
}

describe('clean values when the platform and tidying both have one', () => {
  it('returns the platform\'s values over the tidied ones, fresh and from the cache', async () => {
    const env = { CACHE_KV: createMockKV(), RATE_LIMIT_KV: createMockKV() }
    const ask = async () => {
      const response = await worker.fetch(new Request('https://verifier.divine.video/verify/single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'twitter', identity: '@alice', proof: 'https://x.com/alice/status/1234567890', pubkey: PUBKEY }),
      }), env as never)
      return await response.json()
    }
    const expected = { identity: '@alice', verified: true, canonical_identity: 'platform-alice', canonical_proof: '42' }
    expect(await ask()).toMatchObject({ ...expected, cached: false })
    expect(await ask()).toMatchObject({ ...expected, cached: true })
  })
})
