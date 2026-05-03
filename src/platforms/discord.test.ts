import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DiscordVerifier } from './discord'

describe('DiscordVerifier', () => {
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('invite-based verification', () => {
    const verifier = new DiscordVerifier()

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
      expect(result.error).toContain('Invalid proof format')
    })

    it('returns error on fetch failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))

      const result = await verifier.verify('alice', 'AbCdEf', npub)
      expect(result.verified).toBe(false)
      expect(result.error).toContain('Failed to fetch')
    })

    it('handles discord.gg invite URL as proof', async () => {
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

      const result = await verifier.verify('alice', 'https://discord.gg/AbCdEf', npub)
      expect(result.verified).toBe(true)
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/invites/AbCdEf'),
        expect.any(Object),
      )
    })
  })

  describe('message-based verification', () => {
    const channelId = '1234567890123456'
    const botToken = 'Bot.Token.Here'
    const verifier = new DiscordVerifier(botToken, channelId)

    it('returns verified when message contains npub and author matches', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: '99887766554433221',
          content: `I'm on divine.video, find me at: https://alice.divine.video This serves to verify connecting this account with my divine account: ${npub}`,
          author: {
            id: '111222333',
            username: 'alice',
            global_name: 'Alice',
          },
          channel_id: channelId,
        }),
      }))

      const result = await verifier.verify('alice', '99887766554433221', npub)
      expect(result.verified).toBe(true)
      expect(fetch).toHaveBeenCalledWith(
        `https://discord.com/api/v10/channels/${channelId}/messages/99887766554433221`,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Bot ${botToken}`,
          }),
        }),
      )
    })

    it('returns verified with full message URL', async () => {
      const guildId = '9999999999999999'
      const msgId = '99887766554433221'

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: msgId,
          content: `Verifying npub: ${npub}`,
          author: {
            id: '111222333',
            username: 'alice',
            global_name: 'Alice',
          },
          channel_id: channelId,
        }),
      }))

      const result = await verifier.verify(
        'alice',
        `https://discord.com/channels/${guildId}/${channelId}/${msgId}`,
        npub,
      )
      expect(result.verified).toBe(true)
    })

    it('returns error when author does not match identity', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: '99887766554433221',
          content: `Verify: ${npub}`,
          author: {
            id: '111222333',
            username: 'bob',
            global_name: 'Bob',
          },
          channel_id: channelId,
        }),
      }))

      const result = await verifier.verify('alice', '99887766554433221', npub)
      expect(result.verified).toBe(false)
      expect(result.error).toContain('posted by @bob')
    })

    it('returns error when message does not contain npub', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: '99887766554433221',
          content: 'Hello world, no npub here',
          author: {
            id: '111222333',
            username: 'alice',
            global_name: 'Alice',
          },
          channel_id: channelId,
        }),
      }))

      const result = await verifier.verify('alice', '99887766554433221', npub)
      expect(result.verified).toBe(false)
      expect(result.error).toContain('npub not found in message')
    })

    it('returns error when message not found', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }))

      const result = await verifier.verify('alice', '99887766554433221', npub)
      expect(result.verified).toBe(false)
      expect(result.error).toContain('Message not found')
    })

    it('returns error when bot lacks channel access', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      }))

      const result = await verifier.verify('alice', '99887766554433221', npub)
      expect(result.verified).toBe(false)
      expect(result.error).toContain('does not have access')
    })

    it('returns error when no bot token configured', async () => {
      const noBotVerifier = new DiscordVerifier(undefined, channelId)

      const result = await noBotVerifier.verify('alice', '99887766554433221', npub)
      expect(result.verified).toBe(false)
      expect(result.error).toContain('not configured')
    })

    it('falls back to invite verification for non-numeric proof without bot token', async () => {
      const noBotVerifier = new DiscordVerifier()

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

      const result = await noBotVerifier.verify('alice', 'AbCdEf', npub)
      expect(result.verified).toBe(true)
    })

    it('handles case-insensitive username matching', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: '99887766554433221',
          content: `Verify: ${npub}`,
          author: {
            id: '111222333',
            username: 'Alice',
            global_name: 'Alice',
          },
          channel_id: channelId,
        }),
      }))

      const result = await verifier.verify('alice', '99887766554433221', npub)
      expect(result.verified).toBe(true)
    })
  })
})
