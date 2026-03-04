import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DiscordVerifier } from './discord'

describe('DiscordVerifier', () => {
  const verifier = new DiscordVerifier()
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns verified when npub found in guild name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 'AbCdEf',
        expires_at: null,
        guild: {
          id: '123456789',
          name: npub,
          description: null,
        },
      }),
    }))

    const result = await verifier.verify('alice', 'AbCdEf', npub)
    expect(result.verified).toBe(true)
  })

  it('returns verified when npub found in guild description', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 'AbCdEf',
        expires_at: null,
        guild: {
          id: '123456789',
          name: 'My Proof Server',
          description: `Verifying that I control the following Nostr public key: "${npub}"`,
        },
      }),
    }))

    const result = await verifier.verify('alice', 'AbCdEf', npub)
    expect(result.verified).toBe(true)
  })

  it('returns not verified when npub not in name or description', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 'AbCdEf',
        expires_at: null,
        guild: {
          id: '123456789',
          name: 'Just a regular server',
          description: 'Nothing to see here',
        },
      }),
    }))

    const result = await verifier.verify('alice', 'AbCdEf', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('npub not found')
  })

  it('returns error for 404 invite', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }))

    const result = await verifier.verify('alice', 'badcode', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('not found or expired')
  })

  it('returns error when invite has no guild (group DM)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 'AbCdEf',
        expires_at: null,
      }),
    }))

    const result = await verifier.verify('alice', 'AbCdEf', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('does not point to a server')
  })

  it('returns error when invite has expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 'AbCdEf',
        expires_at: '2020-01-01T00:00:00.000Z',
        guild: {
          id: '123456789',
          name: npub,
          description: null,
        },
      }),
    }))

    const result = await verifier.verify('alice', 'AbCdEf', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('expired')
  })

  it('returns error for invalid invite code format', async () => {
    const result = await verifier.verify('alice', 'bad<code>', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Invalid invite code format')
  })

  it('returns error on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))

    const result = await verifier.verify('alice', 'AbCdEf', npub)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('Failed to fetch')
  })
})
