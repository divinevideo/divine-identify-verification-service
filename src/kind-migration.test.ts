import { describe, it, expect } from 'vitest'

const workerModule = await import('./index')

function createTestEnv() {
  return {
    CACHE_KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
    } as unknown as KVNamespace,
    RATE_LIMIT_KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
    } as unknown as KVNamespace,
  }
}

async function getServedHtml() {
  const env = createTestEnv()
  const req = new Request('http://localhost/')
  const res = await workerModule.default.fetch(req, env)
  return res.text()
}

describe('kind 10011 migration', () => {
  it('publish function uses kind 10011, not kind 0', async () => {
    const html = await getServedHtml()
    expect(html).toContain('kind: 10011')
    expect(html).not.toMatch(/unsignedEvent\s*=\s*\{[^}]*kind:\s*0/)
  })

  it('fetchIdentityEvent queries kind 10011', async () => {
    const html = await getServedHtml()
    expect(html).toContain('fetchIdentityEvent')
  })

  it('doLookup reads from both kind 10011 and kind 0', async () => {
    const html = await getServedHtml()
    expect(html).toContain('fetchIdentityEvent')
    expect(html).toContain('fetchProfileLegacy')
  })
})

describe('manage linked verifications UI', () => {
  it('serves a manage section with load and remove controls', async () => {
    const html = await getServedHtml()
    expect(html).toContain('Manage verified links')
    expect(html).toContain('loadLinkedVerifications')
  })
})

describe('remove verification flow', () => {
  it('includes confirmation dialog markup', async () => {
    const html = await getServedHtml()
    expect(html).toContain('Remove this verification?')
    expect(html).toContain('confirmRemoveVerification')
  })

  it('calls revoke endpoint for OAuth platforms', async () => {
    const html = await getServedHtml()
    expect(html).toContain('/auth/oauth/revoke')
  })
})
