import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DiscordVerifier } from './discord'

describe('DiscordVerifier', () => {
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // Invite-based verification is gone: it could not bind a Discord account to the
  // claimed username. Refusal behaviour is covered in its own describe block below.
  describe('invite proofs are rejected', () => {
    const verifier = new DiscordVerifier()

    it('rejects a raw invite code without calling Discord', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifier.verify('alice', 'AbCdEf', npub)

      expect(result.verified).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('returns error for a proof that is neither a message nor an invite', async () => {
      const result = await verifier.verify('alice', 'not a valid proof!!', npub)

      expect(result.verified).toBe(false)
      expect(result.error).toContain('Invalid proof format')
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

    it('does not fall back to invite verification when no bot token is configured', async () => {
      const noBotVerifier = new DiscordVerifier()
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await noBotVerifier.verify('alice', 'AbCdEf', npub)

      expect(result.verified).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
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

// A Discord server invite cannot prove who owns a Discord account, and this path
// never tried to: verifyInvite took the claimed username as `_identity` and ignored
// it, checking only whether the npub appeared in the guild name or description. That
// let anyone verify any Discord handle by creating a server carrying their own npub.
// It is not fixable by checking the inviter — Discord's public invite endpoint returns
// no `inviter` for permanent or vanity invites.
describe('DiscordVerifier invite proofs cannot bind an account', () => {
  const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function stubInvite(guild: { name: string; description: string | null }) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 'AbCdEf', expires_at: null, guild: { id: '1', ...guild } }),
    }))
  }

  it('refuses a username claimed against a server the claimant merely named', async () => {
    // The attacker's own server, their own npub, somebody else's Discord handle.
    stubInvite({ name: 'totally legit', description: `my key: ${npub}` })

    const result = await new DiscordVerifier().verify('jack', 'AbCdEf', npub)

    expect(result.verified).toBe(false)
    expect(result.error).toMatch(/message/i)
  })

  it('refuses even when the npub is the server name itself', async () => {
    stubInvite({ name: npub, description: null })

    const result = await new DiscordVerifier().verify('anyone', 'AbCdEf', npub)

    expect(result.verified).toBe(false)
  })

  it('refuses a discord.gg URL and never spends an upstream request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await new DiscordVerifier().verify('alice', 'https://discord.gg/AbCdEf', npub)

    expect(result.verified).toBe(false)
    expect(result.error).toContain('message link')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
