import { describe, expect, it } from 'vitest'
import { tidyClaim } from './tidy-claim'

describe('tidyClaim', () => {
  it.each([
    ['twitter', '@alice', 'alice'],
    ['bluesky', '@alice.bsky.social', 'alice.bsky.social'],
    ['github', '@alice', 'alice'],
    ['telegram', '@alicechannel', 'alicechannel'],
    ['tiktok', '@alice', 'alice'],
  ])('drops a leading @ from a %s account', (platform, identity, expected) => {
    expect(tidyClaim(platform, identity, '1').identity).toBe(expected)
  })

  it('drops only one @', () => {
    expect(tidyClaim('twitter', '@@alice', '1').identity).toBe('@alice')
  })

  it('keeps the @ on a YouTube handle', () => {
    expect(tidyClaim('youtube', '@Alice', 'dQw4w9WgXcQ').identity).toBe('@Alice')
  })

  it('trims spaces around both values', () => {
    expect(tidyClaim('github', '  alice ', ' abc123 ')).toEqual({ identity: 'alice', proof: 'abc123' })
  })

  it('keeps a value that tidying would leave empty', () => {
    expect(tidyClaim('twitter', '@', '1').identity).toBe('@')
  })

  it('keeps values that tidying would leave empty', () => {
    expect(tidyClaim('github', '   ', '  ')).toEqual({ identity: '   ', proof: '  ' })
  })

  it.each([
    ['https://x.com/alice/status/1234567890', '1234567890'],
    ['https://twitter.com/alice/status/1234567890?s=20', '1234567890'],
    ['https://mobile.twitter.com/alice/status/1234567890', '1234567890'],
    ['https://mobile.x.com/alice/status/1234567890', '1234567890'],
    ['https://www.twitter.com/alice/status/1234567890', '1234567890'],
    ['https://www.x.com/alice/status/1234567890#m', '1234567890'],
    ['https://x.com/alice/status/1234567890/photo/1', '1234567890'],
    ['https://x.com/alice/status/1234567890/video/1', '1234567890'],
    ['https://x.com/i/status/1234567890', '1234567890'],
    ['https://x.com/i/web/status/1234567890', '1234567890'],
    ['HTTPS://X.COM/alice/status/1234567890', '1234567890'],
    ['http://x.com/alice/status/1234567890', '1234567890'],
    ['https://x.com/alice/status/1234567890/', '1234567890'],
    // Empty path segments are skipped when the link is read.
    ['https://x.com/alice//status/1234567890', '1234567890'],
  ])('reduces the Twitter link %s to its post number', (proof, expected) => {
    expect(tidyClaim('twitter', 'alice', proof).proof).toBe(expected)
  })

  it.each([
    ['https://bsky.app/profile/alice.bsky.social/post/3kabc123xyz', '3kabc123xyz'],
    ['at://did:plc:abc123/app.bsky.feed.post/3kabc123xyz', '3kabc123xyz'],
  ])('reduces the Bluesky link %s to its post key', (proof, expected) => {
    expect(tidyClaim('bluesky', 'alice.bsky.social', proof).proof).toBe(expected)
  })

  it.each([
    ['https://gist.github.com/alice/0123456789abcdef', '0123456789abcdef'],
    ['https://gist.github.com/alice/0123456789abcdef#file-proof-md', '0123456789abcdef'],
    ['https://gist.github.com/alice/0123456789abcdef/revisions', '0123456789abcdef'],
    ['https://gist.githubusercontent.com/alice/0123456789abcdef/raw/proof.md', '0123456789abcdef'],
    ['https://gist.github.com/0123456789abcdef', '0123456789abcdef'],
    ['https://gist.github.com/0123456789abcdef.git', '0123456789abcdef'],
    ['https://gist.github.com/alice/0123456789abcdef.js', '0123456789abcdef'],
  ])('reduces the gist link %s to its id', (proof, expected) => {
    expect(tidyClaim('github', 'alice', proof).proof).toBe(expected)
  })

  it.each([
    ['https://t.me/alicechannel/45', 'alicechannel/45'],
    ['https://t.me/s/alicechannel/45', 'alicechannel/45'],
    ['https://t.me/s/alicechannel/45?embed=1', 'alicechannel/45'],
    ['https://telegram.me/alicechannel/45', 'alicechannel/45'],
    ['https://telegram.dog/alicechannel/45', 'alicechannel/45'],
    ['https://alicechannel.t.me/45', 'alicechannel/45'],
    ['s/alicechannel/45', 'alicechannel/45'],
  ])('reduces the Telegram link %s to channel/post', (proof, expected) => {
    expect(tidyClaim('telegram', 'alicechannel', proof).proof).toBe(expected)
  })

  it('takes the channel from the post when the account came through as "s"', () => {
    // "s" is the path of Telegram's public preview page (t.me/s/<channel>), not an account.
    expect(tidyClaim('telegram', 's', 's/alicechannel/45')).toEqual({ identity: 'alicechannel', proof: 'alicechannel/45' })
  })

  it('reads the account "s" case-insensitively', () => {
    expect(tidyClaim('telegram', 'S', 's/alicechannel/45')).toEqual({ identity: 'alicechannel', proof: 'alicechannel/45' })
  })

  it('takes the channel for the account "s" from a pasted preview link', () => {
    expect(tidyClaim('telegram', 's', 'https://t.me/s/alicechannel/45')).toEqual({ identity: 'alicechannel', proof: 'alicechannel/45' })
  })

  it('keeps the account "s" when the proof is not a preview link', () => {
    expect(tidyClaim('telegram', 's', 'other_channel/5')).toEqual({ identity: 's', proof: 'other_channel/5' })
  })

  it('keeps the account "s" when the proof is a private post link', () => {
    const proof = 'https://t.me/c/1006503122/43'
    expect(tidyClaim('telegram', 's', proof)).toEqual({ identity: 's', proof })
  })

  it('leaves a channel name longer than Telegram allows (32 characters) as it is', () => {
    const proof = `s/${'a'.repeat(33)}/45`
    expect(tidyClaim('telegram', 's', proof)).toEqual({ identity: 's', proof })
    const link = `https://t.me/${'a'.repeat(33)}/45`
    expect(tidyClaim('telegram', 'alicechannel', link).proof).toBe(link)
  })

  it('reads a channel name of exactly 32 characters', () => {
    const channel = 'a'.repeat(32)
    expect(tidyClaim('telegram', 's', `s/${channel}/45`)).toEqual({ identity: channel, proof: `${channel}/45` })
  })

  it('reads a pasted www.t.me link', () => {
    expect(tidyClaim('telegram', 'alicechannel', 'https://www.t.me/alicechannel/45').proof).toBe('alicechannel/45')
  })

  it('keeps the account "s" when a plain post link names a channel', () => {
    expect(tidyClaim('telegram', 's', 'https://t.me/alicechannel/45')).toEqual({ identity: 's', proof: 'alicechannel/45' })
  })

  it('keeps the account "s" for a preview link to a private post', () => {
    const proof = 'https://t.me/s/c/45'
    expect(tidyClaim('telegram', 's', proof)).toEqual({ identity: 's', proof })
  })

  it('keeps a Telegram account other than "s" even when the post names another channel', () => {
    expect(tidyClaim('telegram', 'bobchannel', 'https://t.me/alicechannel/45')).toEqual({ identity: 'bobchannel', proof: 'alicechannel/45' })
  })

  it.each([
    ['bobchannel', 'https://t.me/s/alicechannel/45'],
    ['bobchannel', 's/alicechannel/45'],
    ['bob', 'https://t.me/s/alicechannel/45'],
  ])('keeps the Telegram account %s when the proof %s is a preview link to another channel', (identity, proof) => {
    expect(tidyClaim('telegram', identity, proof)).toEqual({ identity, proof: 'alicechannel/45' })
  })

  it('keeps the account "s" when the proof is a channel whose name starts with s', () => {
    expect(tidyClaim('telegram', 's', 'sam_channel/5')).toEqual({ identity: 's', proof: 'sam_channel/5' })
  })

  it.each([
    ['https://mastodon.social/@alice/109876543210', '109876543210'],
    ['https://mastodon.social/users/alice/statuses/109876543210', '109876543210'],
    ['https://mastodon.social/@alice/109876543210/embed', '109876543210'],
    ['https://mastodon.social/web/@alice/109876543210', '109876543210'],
  ])('reduces the Mastodon link %s to its post id', (proof, expected) => {
    expect(tidyClaim('mastodon', 'mastodon.social/@alice', proof).proof).toBe(expected)
  })

  it.each([
    ['@alice@mastodon.social', 'mastodon.social/@alice'],
    ['alice@mastodon.social', 'mastodon.social/@alice'],
    [' @alice@mastodon.social ', 'mastodon.social/@alice'],
    ['@Alice_1@Social.Example.com', 'Social.Example.com/@Alice_1'],
    ['@alice.b-c@mastodon.social', 'mastodon.social/@alice.b-c'],
    ['@a..b@social.example', 'social.example/@a..b'],
  ])('reads the Mastodon handle %s as the account %s', (identity, expected) => {
    expect(tidyClaim('mastodon', identity, '1').identity).toBe(expected)
  })

  it.each([
    'mastodon.social/@alice',
    'mastodon.social/@alice@mastodon.social',
    '@alice',
    'alice',
    '@alice@localhost',
    '@alice@mastodon.social@other.example',
    '@@alice@mastodon.social',
    '@alice@mastodon.social:8080',
    '@ali ce@mastodon.social',
    '@.alice@mastodon.social',
    '@alice.@mastodon.social',
    '@alice@mastodon.social.',
  ])('leaves the Mastodon account %s as sent', (identity) => {
    expect(tidyClaim('mastodon', identity, '1').identity).toBe(identity.trim())
  })

  it('reads user@server as a Mastodon handle only for Mastodon', () => {
    expect(tidyClaim('discord', 'alice@example.com', '1').identity).toBe('alice@example.com')
  })

  it('reads a YouTube channel link as the account only for YouTube', () => {
    expect(tidyClaim('twitter', 'https://www.youtube.com/@alice', '1').identity).toBe('https://www.youtube.com/@alice')
  })

  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=30s', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?is=AbCdEf123', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('reduces the YouTube link %s to its video id', (proof, expected) => {
    expect(tidyClaim('youtube', '@alice', proof).proof).toBe(expected)
  })

  it.each([
    ['https://www.youtube.com/channel/UC1234567890abcdefghijkl', 'UC1234567890abcdefghijkl'],
    ['https://www.youtube.com/@Alice', '@Alice'],
    ['https://m.youtube.com/@Alice/videos', '@Alice'],
    ['https://www.youtube.com/@caf%C3%A9', '@café'],
    ['https://www.youtube.com/@café', '@café'],
    // Vowel signs are combining marks; digits, _ . - and the middle dot are allowed.
    ['https://www.youtube.com/@%E0%A4%A8%E0%A4%AE%E0%A4%B8%E0%A5%8D%E0%A4%A4%E0%A5%87', '@नमस्ते'],
    ['https://www.youtube.com/@a_b.c-9', '@a_b.c-9'],
    ['https://www.youtube.com/@l·l', '@l·l'],
  ])('reduces the YouTube channel link %s to the channel', (identity, expected) => {
    expect(tidyClaim('youtube', identity, 'dQw4w9WgXcQ').identity).toBe(expected)
  })

  it.each([
    'https://www.youtube.com/channel/UCshort',
    `https://www.youtube.com/channel/UC${'a'.repeat(23)}`,
    'https://www.youtube.com/channel/XX1234567890abcdefghijkl',
    `https://www.youtube.com/user/UC${'a'.repeat(22)}`,
    'https://www.youtube.com/@',
    'https://www.youtube.com/@%E0%A4',
    'https://www.youtube.com/@a%2Fb',
    'https://www.youtube.com/@a%3Cb',
    'https://evil.example/@Alice',
    'https://evil.example/channel/UC1234567890abcdefghijkl',
    'https://music.youtube.com/@Alice',
    'https://music.youtube.com/channel/UC1234567890abcdefghijkl',
  ])('leaves an unrecognised YouTube channel link %s as it is', (identity) => {
    expect(tidyClaim('youtube', identity, 'dQw4w9WgXcQ').identity).toBe(identity)
  })

  it.each([
    ['twitter', 'https://x.com.example.net/alice/status/1'],
    ['twitter', 'https://notx.com/alice/status/1'],
    ['twitter', 'https://x.com/alice/likes'],
    ['twitter', 'https://x.com/alice/status/notanumber'],
    ['telegram', 'https://t.me.example/alicechannel/45'],
    ['github', 'https://gist.github.com.example/alice/abc'],
    ['youtube', 'https://youtube.com/watch?v=tooshort'],
    ['youtube', 'https://evil.example/watch?v=dQw4w9WgXcQ'],
    ['bluesky', 'https://bsky.app/profile/alice.bsky.social'],
    ['telegram', 'https://t.me/c/1006503122/43'],
    ['telegram', 'https://t.me/alicechannel/12/45'],
    ['mastodon', 'https://mastodon.social/@alice@other.example/109876543210'],
    ['mastodon', 'https://mastodon.social/users/alice/statuses/109876543210/activity'],
    ['youtube', 'https://www.youtube.com/user/AliceChannel'],
    ['youtube', 'https://www.youtube.com/c/AliceChannel'],
    ['telegram', 'https://t.me/s/c/45'],
    ['youtube', 'https://youtu.be/tooshort'],
    ['twitter', 'https://x.com/alice/likes/1234567890'],
    ['twitter', 'https://x.com/alice/status/1234567890/analytics'],
    ['twitter', 'https://x.com/alice/status/1234567890/photo/1/extra'],
    ['bluesky', 'https://evil.example/profile/alice.bsky.social/post/3kabc123xyz'],
    ['bluesky', 'https://bsky.app/user/alice.bsky.social/post/3kabc123xyz'],
    ['bluesky', 'https://bsky.app/profile/alice.bsky.social/feed/3kabc123xyz'],
    ['bluesky', 'https://bsky.app/profile/alice.bsky.social/post/3kabc123xyz/liked-by'],
    ['bluesky', 'at://did:plc:abc123/app.bsky.feed.post/3kabc123xyz/extra'],
    ['github', 'https://gist.github.com/alice'],
    ['github', 'https://gist.githubusercontent.com/0123456789abcdef'],
    ['github', 'https://gist.github.com/alice/0123456789abcdef.git'],
    ['github', 'https://gist.github.com/0123456789abcdef.js'],
    ['telegram', 'https://t.me/alicechannel/abc'],
    ['telegram', 'https://t.me/alice-channel/45'],
    ['telegram', 'https://www.t.me/45'],
    ['telegram', 'https://alicechannel.t.me/45/extra'],
    ['telegram', 'https://www.telegram.me/alicechannel/45'],
    ['mastodon', 'https://mastodon.social/@alice/with_replies'],
    ['mastodon', 'https://mastodon.social/@alice/109876543210/reblogs'],
    ['mastodon', 'https://mastodon.social/@alice/109876543210/embed/extra'],
    ['mastodon', 'https://mastodon.social/web/@alice/109876543210/embed'],
    ['youtube', 'https://www.youtube-nocookie.com/v/dQw4w9WgXcQ'],
    ['youtube', 'https://youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['youtube', 'https://music.youtube.com/shorts/dQw4w9WgXcQ'],
    ['telegram', 'https://evil.example/s/alicechannel/45'],
    ['telegram', 's/alicechannel/45/extra'],
    ['twitter', 'ftp://x.com/alice/status/1'],
    ['twitter', 'https://x.com/alice/status/1/photo/abc'],
    ['bluesky', 'x at://did:plc:a/app.bsky.feed.post/3k'],
    ['bluesky', 'at://a/b/app.bsky.feed.post/3k'],
    ['mastodon', 'https://akko.wtf/notice/BBFSKRcr9ptxCQUa8G'],
    ['mastodon', 'https://m.s/x/alice/statuses/1'],
    ['mastodon', 'https://m.s/users/alice/followers/1'],
    ['mastodon', 'https://m.s/users/alice/statuses/a_b'],
    ['youtube', 'https://youtu.be/dQw4w9WgXcQx'],
    ['youtube', 'https://www.youtube-nocookie.com/embed/short'],
    ['youtube', 'https://www.youtube.com/shorts/short'],
    ['github', 'https://gist.github.com/alice/ABCDEF'],
    ['twitter', 'https://x.com/alice/web/status/1'],
    ['twitter', 'https://x.com/alice/status/1a'],
    ['bluesky', 'at://did:plc:a/app.bsky.feed.like/3k'],
    ['telegram', 'https://t.me/alicechannel/45x'],
    ['youtube', 'https://www.youtube.com/playlist?v=dQw4w9WgXcQ'],
    ['github', 'https://gist.github.com/'],
    ['twitter', 'https://x.com/alice/status/1/likes/2'],
    ['github', 'https://github.com/alice/deadbeef'],
    ['youtube', 'https://www.youtube.com/v/dQw4w9WgXcQ'],
  ])('leaves an unrecognised %s link %s as it is', (platform, proof) => {
    expect(tidyClaim(platform, 'alice', proof).proof).toBe(proof)
  })

  it.each([
    'https://bsky.app/profile/alice.bsky.social/post/3k!abc',
    'https://bsky.app/profile/alice.bsky.social/post/3k\u00e9abc',
    'at://did:plc:a/app.bsky.feed.post/3k!abc',
  ])('leaves a Bluesky link %s whose post key has characters a record key never has as it is', (proof) => {
    expect(tidyClaim('bluesky', 'alice.bsky.social', proof).proof).toBe(proof)
  })

  it.each([
    ['twitter', 'https://'],
    ['twitter', 'https://exa mple.com/a'],
  ])('leaves a %s proof that is not a complete link (%s) as it is', (platform, proof) => {
    expect(tidyClaim(platform, 'alice', proof).proof).toBe(proof)
  })

  it('leaves Discord claims as they are', () => {
    const proof = 'https://discord.com/channels/1/2/3'
    expect(tidyClaim('discord', '@alice', proof)).toEqual({ identity: '@alice', proof })
  })

  it('leaves a TikTok proof as it is (the TikTok check reads its own links)', () => {
    const proof = 'https://vm.tiktok.com/ZMabc123/'
    expect(tidyClaim('tiktok', 'alice', proof).proof).toBe(proof)
  })
})
