// ABOUTME: Remembering an answer is a side effect of a check. When the save fails, the
// ABOUTME: person still gets the answer the check reached, and the failed save is logged.
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import type { Bindings } from '../types'
import { hexToNpub } from '../utils/npub'

const PUBKEY = 'ab'.repeat(32)
const NPUB = hexToNpub(PUBKEY)
const MESSAGE_ID = '99887766554433221'
const OTHER_MESSAGE_ID = '99887766554433222'

// `failSave` says whether the nth save (counting from 1) fails.
function createEnv(failSave: (n: number) => boolean = () => false) {
  const store = new Map<string, string>()
  let saves = 0
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      saves++
      if (failSave(saves)) throw new Error('KV PUT failed with status 429')
      store.set(key, value)
    }),
  }
  const rateLimit = { get: vi.fn(async () => null), put: vi.fn(async () => {}) }
  const env = {
    CACHE_KV: kv,
    RATE_LIMIT_KV: rateLimit,
    DISCORD_BOT_TOKEN: 'synthetic-bot-token',
    DISCORD_VERIFY_CHANNEL_ID: '1234567890123456',
  } as unknown as Bindings
  return { env, kv, store }
}

function discordPostedMyNpub() {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    id: MESSAGE_ID,
    content: `Verifying: ${NPUB}`,
    author: { id: '111222333', username: 'synthetic', global_name: null },
    channel_id: '1234567890123456',
  })))
}

function verifySingle(env: Bindings) {
  return worker.fetch(new Request('https://example.com/verify/single', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'discord', identity: 'synthetic', proof: MESSAGE_ID, pubkey: PUBKEY }),
  }), env)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a result that cannot be saved', () => {
  it('CONTROL: a save that works remembers the verified answer', async () => {
    const { env, kv, store } = createEnv()
    discordPostedMyNpub()

    const response = await verifySingle(env)

    expect(await response.json()).toMatchObject({ verified: true, cached: false })
    expect(kv.put).toHaveBeenCalledTimes(1)
    expect(JSON.parse([...store.values()][0])).toMatchObject({ type: 'verified' })
  })

  it('is still reported as verified when the check verified', async () => {
    const { env, kv, store } = createEnv(n => n === 1)
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    discordPostedMyNpub()

    const response = await verifySingle(env)

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toMatchObject({ verified: true, cached: false })
    expect(body.code).toBeUndefined()
    // A failed save must not be remembered as "couldn't check right now" for the next 5 minutes.
    expect(kv.put).toHaveBeenCalledTimes(1)
    expect(store.size).toBe(0)
    expect(logError).toHaveBeenCalledWith(expect.stringMatching(/saving .*discord.* result failed/i), expect.any(Error))
  })

  it('is still reported as the rejection the check reached', async () => {
    const { env } = createEnv(n => n === 1)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 10008, message: 'Unknown Message' }, { status: 404 })))

    const response = await verifySingle(env)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ verified: false, code: 'discord_message_not_found' })
  })

  it('does not turn a platform that did not answer into a server error', async () => {
    const { env } = createEnv(() => true)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))

    const response = await verifySingle(env)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ verified: false, code: 'temporarily_unavailable' })
  })

  it('does not take the other claims in a batch down with it', async () => {
    const { env } = createEnv(() => true)
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    discordPostedMyNpub()

    const response = await worker.fetch(new Request('https://example.com/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claims: [
          { platform: 'discord', identity: 'synthetic', proof: MESSAGE_ID, pubkey: PUBKEY },
          { platform: 'discord', identity: 'synthetic', proof: OTHER_MESSAGE_ID, pubkey: PUBKEY },
        ],
      }),
    }), env)

    expect(response.status).toBe(200)
    const { results } = await response.json() as { results: Array<Record<string, unknown>> }
    expect(results).toHaveLength(2)
    expect(results.every(result => result.verified === true)).toBe(true)
    expect(logError).toHaveBeenCalledTimes(2)
  })
})
