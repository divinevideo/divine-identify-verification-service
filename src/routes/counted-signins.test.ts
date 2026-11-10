import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import worker from '../index'
import type { Bindings } from '../types'
import { oauthVerificationKey } from '../oauth/state'

const PUBKEY = 'ab'.repeat(32)
const X = { platform: 'twitter', identity: 'jack' }
const BLUESKY = { platform: 'bluesky', identity: 'alice.bsky.social' }
type Account = typeof X

// When a record doesn't count, the check falls through to the proof post,
// which would fetch from the platform; no network in tests.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests') }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function envWith(vars: Partial<Bindings>, record: Record<string, unknown> | null, { platform, identity }: Account = X): Bindings {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
  } as unknown as KVNamespace
  if (record) {
    store.set(oauthVerificationKey(platform, identity, PUBKEY), JSON.stringify({
      platform, identity, pubkey: PUBKEY, verified: true, method: 'oauth', checked_at: Math.floor(Date.now() / 1000), ...record,
    }))
  }
  return { CACHE_KV: kv, RATE_LIMIT_KV: kv, ...vars } as Bindings
}

async function single(env: Bindings, { platform, identity }: Account = X) {
  const res = await worker.fetch(new Request('https://verifier.divine.video/verify/single', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, identity, proof: 'oauth', pubkey: PUBKEY }),
  }), env)
  return (await res.json() as { method?: string }).method === 'oauth'
}

async function batch(env: Bindings, { platform, identity }: Account = X) {
  const res = await worker.fetch(new Request('https://verifier.divine.video/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claims: [{ platform, identity, proof: 'oauth', pubkey: PUBKEY }] }),
  }), env)
  return (await res.json() as { results: Array<{ method?: string }> }).results[0].method === 'oauth'
}

async function status(env: Bindings, { platform, identity }: Account = X) {
  const res = await worker.fetch(new Request(`https://verifier.divine.video/auth/${platform}/status?pubkey=${PUBKEY}&identity=${identity}`), env)
  return (await res.json() as { verified: boolean }).verified
}

// The verification-link route: GET /verify/:platform/<identity>/<proof>?pubkey=
async function link(env: Bindings, { platform, identity }: Account = X) {
  const res = await worker.fetch(new Request(`https://verifier.divine.video/verify/${platform}/${identity}/oauth?pubkey=${PUBKEY}`, { headers: { Accept: 'application/json' } }), env)
  return (await res.json() as { method?: string }).method === 'oauth'
}

const CHECKS = [['single', single], ['batch', batch], ['status', status], ['link', link]] as const

describe('sign-in records answer every check the same way', () => {
  it.each(CHECKS)('%s: before the switch, an unconfirmed record counts', async (_name, check) => {
    expect(await check(envWith({}, {}))).toBe(true)
  })

  it.each(CHECKS)('%s: once required, an unconfirmed or older record does not count', async (_name, check) => {
    expect(await check(envWith({ SIGNIN_CONFIRMATION: 'required' }, {}))).toBe(false)
    expect(await check(envWith({ SIGNIN_CONFIRMATION: 'required' }, { bound: true }))).toBe(false)
  })

  it.each(CHECKS)('%s: once required, a confirmed record counts', async (_name, check) => {
    expect(await check(envWith({ SIGNIN_CONFIRMATION: 'required' }, { confirmed: true }))).toBe(true)
  })

  it.each(CHECKS)('%s: a confirmed record does not count while its platform\'s links are switched off', async (_name, check) => {
    expect(await check(envWith({ SIGNIN_CONFIRMATION: 'required', SIGNIN_LINKS_OFF: 'twitter' }, { confirmed: true }))).toBe(false)
    expect(await check(envWith({ SIGNIN_CONFIRMATION: 'required', SIGNIN_LINKS_OFF: 'tiktok' }, { confirmed: true }))).toBe(true)
  })

  it.each(CHECKS)('%s: a TikTok link counts while TikTok sign-in is paused, and not once its links are switched off', async (_name, check) => {
    const TIKTOK = { platform: 'tiktok', identity: 'creator' }
    const vars = {
      SIGNIN_CONFIRMATION: 'required', TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's',
      OAUTH_REDIRECT_BASE: 'https://verifier.divine.video', TIKTOK_OAUTH_ENABLED: 'false',
    }
    expect(await check(envWith(vars, { confirmed: true }, TIKTOK), TIKTOK)).toBe(true)
    expect(await check(envWith({ ...vars, SIGNIN_LINKS_OFF: 'tiktok' }, { confirmed: true }, TIKTOK), TIKTOK)).toBe(false)
  })

  it.each(CHECKS)('%s: a confirmed X or Bluesky record past its lifetime does not count', async (_name, check) => {
    const checkedAt = Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60
    expect(await check(envWith({ SIGNIN_CONFIRMATION: 'required' }, { confirmed: true, checked_at: checkedAt }))).toBe(false)
    const blueskyRecord = { confirmed: true, checked_at: checkedAt, account_id: 'did:plc:alice111111111111111111', handle: BLUESKY.identity }
    expect(await check(envWith({ SIGNIN_CONFIRMATION: 'required' }, blueskyRecord, BLUESKY), BLUESKY)).toBe(false)
  })
})
