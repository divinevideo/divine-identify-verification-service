// ABOUTME: Tests how SIGNIN_LINKS_OFF is read into the platforms whose sign-in links are off.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Bindings } from '../types'
import { signInLinksOff, signInLinksAreOff } from './signin-switch'

const env = (v: string | undefined) => ({ SIGNIN_LINKS_OFF: v }) as Bindings

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

describe('SIGNIN_LINKS_OFF', () => {
  it.each([
    [undefined, []],
    ['', []],
    ['twitter', ['twitter']],
    [' Twitter , TIKTOK ', ['twitter', 'tiktok']],
    ['tiktok twitter', ['twitter', 'tiktok']],
    ['twitter,,twitter', ['twitter']],
    ['bluesky,youtube', ['bluesky', 'youtube']],
  ])('reads %j as %j', (value, expected) => {
    expect(signInLinksOff(env(value))).toEqual(expected)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('ignores a name that is not a sign-in platform, and says so', () => {
    expect(signInLinksOff(env('x,tiktok'))).toEqual(['tiktok'])
    expect(signInLinksOff(env('github'))).toEqual([])
    expect(console.warn).toHaveBeenCalledTimes(2)
    expect(vi.mocked(console.warn).mock.calls[0][0]).toContain('"x"')
    expect(vi.mocked(console.warn).mock.calls[1][0]).toContain('"github"')
  })

  it('answers per platform', () => {
    const e = env('twitter')
    expect(signInLinksAreOff(e, 'twitter')).toBe(true)
    expect(signInLinksAreOff(e, 'tiktok')).toBe(false)
    expect(signInLinksAreOff(e, 'github')).toBe(false)
    expect(signInLinksAreOff(env(undefined), 'twitter')).toBe(false)
  })
})
