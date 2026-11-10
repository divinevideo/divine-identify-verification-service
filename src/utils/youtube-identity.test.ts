import { describe, expect, it } from 'vitest'
import { parseYouTubeIdentity, YOUTUBE_CHANNEL_ID } from './youtube-identity'

describe('parseYouTubeIdentity', () => {
  it.each(['UCaaaaaaaaaaaaaaaaaaaaaa', 'UC1234567890abcdefghij_-'])('reads %s as a channel id', (id) => {
    expect(parseYouTubeIdentity(id)).toEqual({ kind: 'channel', channelId: id })
    expect(YOUTUBE_CHANNEL_ID.test(id)).toBe(true)
  })

  it.each([
    ['@alice', '@alice'],
    ['alice', '@alice'],
    ['@Alice', '@Alice'],
    ['UCLA', '@UCLA'],
    ['@UCaaaaaaaaaaaaaaaaaaaaaa', '@UCaaaaaaaaaaaaaaaaaaaaaa'],
    ['UCaaaaaaaaaaaaaaaaaaaaaaaa', '@UCaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['ucaaaaaaaaaaaaaaaaaaaaaa', '@ucaaaaaaaaaaaaaaaaaaaaaa'],
    ['@café', '@café'],
    ['@中文频道', '@中文频道'],
    ['@한국어채널', '@한국어채널'],
    ['@a_b.c-9', '@a_b.c-9'],
    ['@l·l', '@l·l'],
  ])('reads %s as the handle %s', (input, handle) => {
    expect(parseYouTubeIdentity(input)).toEqual({ kind: 'handle', handle })
  })

  it.each([
    '',
    '@',
    '@@alice',
    'al ice',
    'c/alice',
    'user/alice',
    'channel/UCaaaaaaaaaaaaaaaaaaaaaa',
    'https://www.youtube.com/c/alice',
    'https://www.youtube.com/user/alice',
    'https://www.youtube.com/@alice',
    'alice<b',
  ])('refuses %j', (input) => {
    expect(parseYouTubeIdentity(input)).toBeNull()
  })
})
