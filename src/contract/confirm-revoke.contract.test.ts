// ABOUTME: Pins how the Divine app confirms a sign-in and unlinks one, so a change
// ABOUTME: (or a move to another worker) cannot silently break shipped clients.
import { describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Bindings } from '../types'
import { call, BASE_URL, verifierAdapter as adapter } from './harness'
import { startTwitter, finishTwitter } from './signin-driver'

const target = adapter.target
// 43 characters of base64url, as mobile signin_confirmation.dart sends.
const START_SECRET = 'S'.repeat(43)

// Production runs with confirmation required.
function signInEnv(): Bindings {
  return adapter.env({
    OAUTH_REDIRECT_BASE: BASE_URL,
    SIGNIN_CONFIRMATION: 'required',
    TWITTER_CLIENT_ID: 'synthetic-id',
    TWITTER_CLIENT_SECRET: 'synthetic-secret',
  }).env
}

async function sha256Bytes(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// mobile signin_confirmation.dart: the start check and the binding the client signs.
const startCheckOf = async (secret: string) => base64url(await sha256Bytes(`divine-signin-start:${secret}`))
const bindingOf = async (code: string, startCheck: string) =>
  base64url(await sha256Bytes(`divine-signin-confirm:${code}:${startCheck}`))

// A really signed event, built the way the app builds one.
async function signed(secretKey: Uint8Array, kind: number, tags: string[][], createdAt = Math.floor(Date.now() / 1000)) {
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))
  const id = bytesToHex(await sha256Bytes(JSON.stringify([0, pubkey, createdAt, kind, tags, ''])))
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey))
  return { id, pubkey, created_at: createdAt, kind, tags, content: '', sig }
}

interface Pending {
  env: Bindings
  secretKey: Uint8Array
  pubkey: string
  code: string
  /** The platform and identity the return redirect carried, which the app compares against. */
  platform: string
  identity: string
  binding: string
}

// Starts a Twitter sign-in for a fresh key and finishes it through the callback,
// so the one-time code is the one the service really issued.
async function pendingSignIn(): Promise<Pending> {
  const env = signInEnv()
  const secretKey = schnorr.utils.randomSecretKey()
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))
  const startCheck = await startCheckOf(START_SECRET)
  const stateId = await startTwitter(env, pubkey, startCheck)
  const location = await finishTwitter(env, stateId)
  const code = new URLSearchParams(location.hash.slice(1)).get('oauth_confirm') as string
  expect(code).not.toBe('')
  const platform = location.searchParams.get('platform') as string
  const identity = location.searchParams.get('identity') as string
  return {
    env, secretKey, pubkey, code, platform, identity,
    binding: await bindingOf(code, startCheck),
  }
}

const bound = (p: Pending) => [['i', `${p.platform}:${p.identity}`, 'oauth', p.binding]]

function confirm(p: Pending, event: unknown, overrides: Record<string, unknown> = {}) {
  return call(target, 'POST', '/auth/confirm', { code: p.code, start_secret: START_SECRET, event, ...overrides }, p.env)
}

// The app retries a 5xx and treats 429 as "keep waiting"; any other refusal is final.
async function refusal(res: Response) {
  expect(res.status).toBeGreaterThanOrEqual(400)
  expect(res.status).toBeLessThan(500)
  expect(res.status).not.toBe(429)
  return ((await res.json()) as { code?: unknown }).code
}

describe('POST /auth/confirm (mobile verifier_client.dart confirmSignIn)', () => {
  // mobile 1.0.25+ verifier_client.dart: success is exactly 200 with linked === true (a
  // boolean) and string platform and identity.
  it('T4.1 answers 200 with linked true and the sign-in platform and identity', async () => {
    const p = await pendingSignIn()
    const res = await confirm(p, await signed(p.secretKey, 10011, bound(p)))
    expect(res.status).toBe(200)
    const body = await res.json() as { linked: unknown; platform: unknown; identity: unknown }
    expect(body.linked).toBe(true)
    expect(typeof body.platform).toBe('string')
    expect(typeof body.identity).toBe('string')
    // The app compares the confirm answer with the return redirect, identity ignoring case.
    expect(body.platform).toBe(p.platform)
    expect(String(body.identity).toLowerCase()).toBe(p.identity.toLowerCase())
  })

  // mobile 1.0.25+ verifier_client.dart: the same signed event sent again after a lost
  // answer must get the same answer, because the client never re-signs on retry.
  it('T4.1 answers the same success when the same event is resent', async () => {
    const p = await pendingSignIn()
    const event = await signed(p.secretKey, 10011, bound(p))
    const first = await confirm(p, event)
    const second = await confirm(p, event)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual(await first.json())
  })

  // mobile 1.0.25+ verifier_client.dart: notFound is retried by the app; any other code
  // is a refusal that drops the sign-in. The app reads the code string only.
  describe('T4.2 refusals carry a code string and a non-200 status', () => {
    it('signin_not_found for an unknown code', async () => {
      const p = await pendingSignIn()
      const res = await confirm(p, await signed(p.secretKey, 10011, bound(p)), { code: 'D'.repeat(43) })
      // The app retries this one by its code, whatever the status; today's status class is pinned.
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).not.toBe(429)
      expect(((await res.json()) as { code?: unknown }).code).toBe('signin_not_found')
    })

    it('signin_used when a code already confirmed is sent with a different event', async () => {
      const p = await pendingSignIn()
      expect((await confirm(p, await signed(p.secretKey, 10011, bound(p)))).status).toBe(200)
      const other = await signed(p.secretKey, 10011, bound(p), Math.floor(Date.now() / 1000) - 5)
      expect(await refusal(await confirm(p, other))).toBe('signin_used')
    })

    it('signin_wrong_account when another key signs the event', async () => {
      const p = await pendingSignIn()
      const stranger = await signed(schnorr.utils.randomSecretKey(), 10011, bound(p))
      expect(await refusal(await confirm(p, stranger))).toBe('signin_wrong_account')
    })

    it('signin_not_yours when the start secret is not the one that started the sign-in', async () => {
      const p = await pendingSignIn()
      const event = await signed(p.secretKey, 10011, bound(p))
      expect(await refusal(await confirm(p, event, { start_secret: 'T'.repeat(43) }))).toBe('signin_not_yours')
    })

    it('signin_claim_mismatch when the event does not carry the binding', async () => {
      const p = await pendingSignIn()
      const event = await signed(p.secretKey, 10011, [['i', `${p.platform}:${p.identity}`, 'oauth', 'wrong-binding']])
      expect(await refusal(await confirm(p, event))).toBe('signin_claim_mismatch')
    })

    it('invalid_event when the signature does not verify', async () => {
      const p = await pendingSignIn()
      const event = { ...(await signed(p.secretKey, 10011, bound(p))), sig: 'b'.repeat(128) }
      expect(await refusal(await confirm(p, event))).toBe('invalid_event')
    })

    it('invalid_event when the event is not a kind 10011', async () => {
      const p = await pendingSignIn()
      expect(await refusal(await confirm(p, await signed(p.secretKey, 1, bound(p))))).toBe('invalid_event')
    })

    it('invalid_request when the code or start secret is missing', async () => {
      const p = await pendingSignIn()
      const event = await signed(p.secretKey, 10011, bound(p))
      expect(await refusal(await confirm(p, event, { code: undefined }))).toBe('invalid_request')
      expect(await refusal(await confirm(p, event, { start_secret: undefined }))).toBe('invalid_request')
    })
  })
})

describe('POST /auth/oauth/revoke (mobile verifier_client.dart revoke)', () => {
  // mobile verifier_client.dart revoke: the NIP-98 event travels in the JSON body, with
  // u = the exact request URL, and no Authorization header is sent.
  it('T4.3 removes the stored sign-in when the signed event is in the JSON body', async () => {
    const env = adapter.env().env
    const secretKey = schnorr.utils.randomSecretKey()
    const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))
    const claim = { platform: 'twitter', identity: 'synthetic-user', pubkey }
    await adapter.seedSignIn(env, claim)
    // What the app sees: the oauth claim verifies before the unlink and not after.
    const verified = async () => {
      const res = await call(target, 'POST', '/verify', { claims: [{ ...claim, proof: 'oauth' }] }, env)
      expect(res.status).toBe(200)
      return ((await res.json()) as { results: { verified: boolean }[] }).results[0].verified
    }
    expect(await verified()).toBe(true)

    const event = await signed(secretKey, 27235, [['u', `${BASE_URL}/auth/oauth/revoke`], ['method', 'POST']])
    const res = await call(target, 'POST', '/auth/oauth/revoke', { ...claim, event }, env)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).not.toBeNull()
    expect(typeof body).toBe('object')
    expect(Array.isArray(body)).toBe(false)
    expect(await verified()).toBe(false)
  })
})
