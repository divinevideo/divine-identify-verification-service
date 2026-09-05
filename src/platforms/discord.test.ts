import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DiscordVerifier, isDiscordMessageLink } from './discord'

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
      // The refusal names the claimed handle, never the account that actually
      // posted — resolving that is a lookup across every channel the bot reads.
      expect(result.error).toContain('alice')
      expect(result.error).not.toContain('bob')
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

    // Migrated user accounts have lowercase usernames, while legacy and bot
    // accounts can still use mixed case. The claimed handle reaches the
    // verifier exactly as the user typed it.
    it.each([
      ['a capitalised handle for a migrated account', 'alice', 'Alice'],
      ['a lowercase handle for a legacy or bot account', 'Alice', 'alice'],
    ])('accepts %s', async (_scenario, username, identity) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: '99887766554433221',
          content: `Verify: ${npub}`,
          author: {
            id: '111222333',
            username,
            global_name: 'Alice',
          },
          channel_id: channelId,
        }),
      }))

      const result = await verifier.verify(identity, '99887766554433221', npub)
      expect(result.verified).toBe(true)
    })
  })

  // Copy Message Link does not always spell the host `discord.com`: the Canary
  // and PTB clients use their own subdomains, and links shared years ago still
  // carry the legacy discordapp.com. All of them serve the same message.
  describe('proof link parsing', () => {
    const guildId = '9999999999999999'
    const channelId = '1234567890123456'
    const messageId = '99887766554433221'
    const verifier = new DiscordVerifier('Bot.Token.Here', channelId)

    function stubMessage() {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            id: messageId,
            content: `verifying with ${npub}`,
            author: { id: '111222333', username: 'alice', global_name: null },
            channel_id: channelId,
          }),
        }),
      )
    }

    const path = `/channels/${guildId}/${channelId}/${messageId}`

    it.each([
      ['canary client', `https://canary.discord.com${path}`],
      ['ptb client', `https://ptb.discord.com${path}`],
      ['legacy discordapp.com', `https://discordapp.com${path}`],
      ['www.discordapp.com', `https://www.discordapp.com${path}`],
      ['trailing slash', `https://discord.com${path}/`],
      ['query string', `https://discord.com${path}?jump=1`],
      ['fragment', `https://discord.com${path}#pinned`],
      ['uppercase host', `https://Discord.com${path}`],
      ['surrounding whitespace', `  https://discord.com${path}  `],
    ])('verifies a message link from the %s', async (_label, proof) => {
      stubMessage()

      const result = await verifier.verify('alice', proof, npub)

      expect(result.verified).toBe(true)
    })

    it('tells someone who linked a DM why it can never work', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const message = await verifier.verify(
        'alice',
        `https://discord.com/channels/@me/${channelId}/${messageId}`,
        npub,
      )

      expect(message.verified).toBe(false)
      expect(message.code).toBe('discord_dm_link')
      expect(fetchMock).not.toHaveBeenCalled()

      // The DM channel on its own reaches the same answer, not the channel one.
      const channel = await verifier.verify(
        'alice',
        `https://discord.com/channels/@me/${channelId}`,
        npub,
      )

      expect(channel.code).toBe('discord_dm_link')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('does not name the account that actually posted the message', async () => {
      // Resolving the author is a lookup over every channel the bot can read,
      // so the reason travels as a code and the message names only the handle
      // the user typed themselves.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: messageId,
          content: `key ${npub}`,
          author: { id: '1', username: 'someone-else', global_name: null },
          channel_id: channelId,
        }),
      }))

      const result = await verifier.verify('alice', messageId, npub)

      expect(result.code).toBe('discord_author_mismatch')
      expect(result.error).not.toContain('someone-else')
      expect(result.error).toContain('alice')
    })

    it('codes an access refusal and an upstream failure apart', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ code: 50001 }),
      }))
      expect((await verifier.verify('alice', messageId, npub)).code).toBe(
        'discord_bot_no_access',
      )

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      }))
      const upstream = await verifier.verify('alice', messageId, npub)
      expect(upstream.code).toBe('discord_api_error')
      expect(upstream.error).toContain('500')

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
      expect((await verifier.verify('alice', messageId, npub)).code).toBe(
        'discord_api_error',
      )
    })

    it('tells someone who copied the channel link what to copy instead', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifier.verify(
        'alice',
        `https://discord.com/channels/${guildId}/${channelId}`,
        npub,
      )

      expect(result.verified).toBe(false)
      expect(result.error).toContain('Copy Message Link')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('codes every rejection so a client can localize it', async () => {
      // A channel but no bot token: without the channel a bare snowflake falls
      // through to the invite branch instead of ever reaching the token check.
      const unconfigured = new DiscordVerifier(undefined, channelId)

      expect((await verifier.verify('alice', 'not a proof!!', npub)).code).toBe(
        'discord_invalid_proof_format',
      )
      expect(
        (await verifier.verify('alice', `https://discord.com/channels/${guildId}/${channelId}`, npub))
          .code,
      ).toBe('discord_channel_link')
      expect((await verifier.verify('alice', 'AbCdEf', npub)).code).toBe(
        'discord_invite_refused',
      )
      expect((await unconfigured.verify('alice', messageId, npub)).code).toBe(
        'discord_not_configured',
      )
    })

    it('codes an author mismatch and a genuinely missing npub apart', async () => {
      const message = (content: string, username: string) => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: messageId,
          content,
          author: { id: '1', username, global_name: null },
          channel_id: channelId,
        }),
      })

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(message(`key ${npub}`, 'bob')))
      expect((await verifier.verify('alice', messageId, npub)).code).toBe(
        'discord_author_mismatch',
      )

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(message('no key here', 'alice')))
      expect((await verifier.verify('alice', messageId, npub)).code).toBe(
        'discord_npub_not_in_message',
      )
    })

    // Discord answers 404 both for a message that is not there and for a channel
    // the bot cannot see. Only the body separates them, and that difference is
    // exactly what a stuck user needs to hear.
    it('separates an unreadable channel from an absent message on a 404', async () => {
      const notFound = (body: unknown) => ({
        ok: false,
        status: 404,
        json: async () => body,
      })

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(notFound({ code: 10003 })))
      expect((await verifier.verify('alice', messageId, npub)).code).toBe(
        'discord_bot_no_access',
      )

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(notFound({ code: 10008 })))
      expect((await verifier.verify('alice', messageId, npub)).code).toBe(
        'discord_message_not_found',
      )
    })

    it('falls back to message-not-found when the 404 body cannot be read', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          json: async () => {
            throw new Error('no body')
          },
        }),
      )

      expect((await verifier.verify('alice', messageId, npub)).code).toBe(
        'discord_message_not_found',
      )
    })

    // An existing message whose text comes back empty is the signature of a bot
    // without the MESSAGE_CONTENT privileged intent. Reporting that as "your
    // npub is missing" blames the user for our own misconfiguration.
    it('does not blame the user when the message text comes back empty', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            id: messageId,
            content: '   ',
            author: { id: '1', username: 'alice', global_name: null },
            channel_id: channelId,
          }),
        }),
      )

      const result = await verifier.verify('alice', messageId, npub)

      expect(result.verified).toBe(false)
      expect(result.code).toBe('discord_message_content_unavailable')
    })

    it('still refuses a host that only looks like Discord', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await verifier.verify(
        'alice',
        `https://discord.com.evil.example${path}`,
        npub,
      )

      expect(result.verified).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
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

// The verify-result page shows a "View proof post" link built from whatever
// counts as a platform's `proof`. Discord's proof used to be a short invite
// code, so the page could always build a link by hand; now it is the message
// link itself, so this decides whether that link can be shown as-is.
describe('isDiscordMessageLink', () => {
  const messageLink = 'https://discord.com/channels/1234567890123456789/2345678901234567890/3456789012345678901'

  it('accepts the message link a Discord client actually produces', () => {
    expect(isDiscordMessageLink(messageLink)).toBe(true)
  })

  it('accepts the same link from Canary, PTB, and the pre-rename host', () => {
    expect(isDiscordMessageLink(messageLink.replace('discord.com', 'canary.discord.com'))).toBe(true)
    expect(isDiscordMessageLink(messageLink.replace('discord.com', 'ptb.discord.com'))).toBe(true)
    expect(isDiscordMessageLink(messageLink.replace('discord.com', 'discordapp.com'))).toBe(true)
  })

  it('rejects a bare snowflake, since there is no guild ID to build a link from', () => {
    expect(isDiscordMessageLink('3456789012345678901')).toBe(false)
  })

  it('rejects a DM link', () => {
    expect(isDiscordMessageLink('https://discord.com/channels/@me/2345678901234567890/3456789012345678901')).toBe(false)
  })

  it('rejects a channel link', () => {
    expect(isDiscordMessageLink('https://discord.com/channels/1234567890123456789/2345678901234567890')).toBe(false)
  })

  it('rejects an invite code or invite URL', () => {
    expect(isDiscordMessageLink('AbCdEf')).toBe(false)
    expect(isDiscordMessageLink('https://discord.gg/AbCdEf')).toBe(false)
  })

  it('rejects a look-alike host', () => {
    expect(isDiscordMessageLink(messageLink.replace('discord.com', 'discord.com.evil.example'))).toBe(false)
  })
})
