import { describe, expect, it, vi } from 'vitest'
import worker from '../index'
import type { Bindings, OAuthVerification } from '../types'
import { accountStatusKey } from './bluesky-account-status'
import { deleteOAuthVerification, oauthVerificationKey } from './state'

const PUBKEY = 'ab'.repeat(32)
const HANDLE = 'synthetic.bsky.social'
const DID = 'did:plc:abcdefghijklmnopqrstuvwx'
const record: OAuthVerification = {
  platform: 'bluesky', identity: HANDLE, pubkey: PUBKEY, account_id: DID,
  handle: HANDLE, confirmed: true, verified: true, method: 'oauth',
  checked_at: Math.floor(Date.now() / 1000), kept: true,
}

function setup(status: string, handle: string) {
  const store = new Map<string, string>()
  for (const identity of [HANDLE, DID]) {
    store.set(oauthVerificationKey('bluesky', identity, PUBKEY), JSON.stringify({ ...record, identity }))
  }
  store.set(accountStatusKey(DID), status)
  store.set(`bsky_handle_did:${HANDLE}`, handle)
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
  }
  const env = { CACHE_KV: kv, RATE_LIMIT_KV: { get: async () => null, put: async () => {} } } as unknown as Bindings
  return { store, kv, env }
}

function request(endpoint: string) {
  return endpoint === 'status'
    ? new Request(`https://verifier.divine.video/auth/bluesky/status?pubkey=${PUBKEY}&identity=${HANDLE}`)
    : new Request('https://verifier.divine.video/verify/single', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'bluesky', identity: HANDLE, pubkey: PUBKEY, proof: 'oauth' }),
    })
}

describe.each(['verify', 'status'])('%s reads stored Bluesky sign-ins', endpoint => {
  it.each([
    ['active', DID, true],
    ['gone', DID, false],
    ['gone', 'not-found', false],
  ] as const)('leaves records unchanged for status %s and handle %s', async (status, handle, verified) => {
    const { store, kv, env } = setup(status, handle)
    const before = new Map(store)
    const response = await worker.fetch(request(endpoint), env)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ verified })
    expect(store).toEqual(before)
    expect(kv.put).not.toHaveBeenCalled()
    expect(kv.delete).not.toHaveBeenCalled()
  })

  it.each(['active', 'gone'])('does not change a completed unlink during a %s account check', async status => {
    const { store, kv, env } = setup(status, DID)
    let read!: () => void
    let resume!: () => void
    const readStarted = new Promise<void>(resolve => { read = resolve })
    const continueRead = new Promise<void>(resolve => { resume = resolve })
    const key = oauthVerificationKey('bluesky', HANDLE, PUBKEY)
    const snapshot = store.get(key)!
    kv.get.mockImplementationOnce(async requestedKey => {
      expect(requestedKey).toBe(key)
      read()
      await continueRead
      return snapshot
    })
    const checking = worker.fetch(request(endpoint), env)
    await readStarted
    await deleteOAuthVerification(env.CACHE_KV, 'bluesky', HANDLE, PUBKEY)
    resume()
    expect((await checking).status).toBe(200)
    for (const identity of [HANDLE, DID]) expect(store.has(oauthVerificationKey('bluesky', identity, PUBKEY))).toBe(false)
    expect(kv.put).not.toHaveBeenCalled()
  })
})
