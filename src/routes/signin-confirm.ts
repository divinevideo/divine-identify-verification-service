// ABOUTME: POST /auth/confirm: the Divine account owner confirms a sign-in by
// ABOUTME: signing the linked-accounts list that carries the bound claim (#113).
import { Hono } from 'hono'
import type { Bindings, OAuthPlatform } from '../types'
import { checkRateLimit, RATE_LIMITS } from '../utils/rate-limit'
import { readJsonBody } from '../utils/json-body'
import { verifyEventSignature, asLinkedAccountsList, LINKED_ACCOUNTS_MAX_SECONDS_AHEAD } from '../utils/nostr-event'
import {
  getUsedCode, storeUsedCode, getPendingSignIn, deletePendingSignIn,
  startCheckFor, confirmBindingFor, isSignInToken, sameToken,
} from '../oauth/confirm'
import { saveSignIn, savedIdentities } from '../oauth/signin-records'
import { signInLinksAreOff } from '../oauth/signin-switch'

const confirm = new Hono<{ Bindings: Bindings }>()

const CONFIRM_BODY_LIMIT = 65536

const REFUSALS = {
  not_found: { status: 404, code: 'signin_not_found', error: 'This sign-in couldn\'t be confirmed. Sign in again.' },
  used: { status: 409, code: 'signin_used', error: 'This sign-in was already used. Sign in again.' },
  wrong_account: { status: 401, code: 'signin_wrong_account', error: 'Sign in with the Divine account that started this sign-in.' },
  no_start_check: { status: 401, code: 'signin_not_yours', error: 'This sign-in was started somewhere else.' },
  not_yours: { status: 401, code: 'signin_not_yours', error: 'This sign-in was started somewhere else.' },
  claim_mismatch: { status: 401, code: 'signin_claim_mismatch', error: 'This confirmation doesn\'t match the sign-in. Sign in again.' },
  // 403, not 5xx: apps retry 5xx and signin_not_found, and this refusal is final until the operator clears the switch.
  links_off: { status: 403, code: 'signin_unavailable', error: 'Sign-in links for this platform are switched off right now.' },
  invalid_event: { status: 400, code: 'invalid_event', error: 'The confirmation must be a signed linked-accounts list (kind 10011).' },
} as const

type Refusal = keyof typeof REFUSALS

confirm.post('/confirm', async (c) => {
  const refuse = (reason: Refusal, platform: OAuthPlatform | null) => {
    console.info(`${platform ?? 'unknown'} sign-in confirmation refused: ${reason}`)
    const { status, code, error } = REFUSALS[reason]
    return c.json({ error, code }, status)
  }

  const clientIp = c.req.header('cf-connecting-ip') || 'unknown'
  const ipLimit = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.ip, clientIp)
  if (!ipLimit.allowed) return c.json({ error: 'Rate limit exceeded' }, 429)

  const read = await readJsonBody(c, CONFIRM_BODY_LIMIT)
  if (!read.ok) return read.response
  const body = (read.body && typeof read.body === 'object' ? read.body : {}) as Record<string, unknown>
  const { code, start_secret: startSecret } = body
  if (!isSignInToken(code) || !isSignInToken(startSecret)) {
    return c.json({ error: 'Invalid or missing code or start_secret', code: 'invalid_request' }, 400)
  }

  const event = asLinkedAccountsList(body.event)
  if (!event || event.created_at > Math.floor(Date.now() / 1000) + LINKED_ACCOUNTS_MAX_SECONDS_AHEAD) return refuse('invalid_event', null)
  if (!(await verifyEventSignature(event)).ok) return refuse('invalid_event', null)

  // The same event sent again (its first answer was lost) gets the same answer.
  const used = await getUsedCode(c.env.CACHE_KV, code)
  if (used) {
    // Even a repeat of a finished confirmation: while the links are withdrawn, no confirm answers as linked.
    if (signInLinksAreOff(c.env, used.platform)) return refuse('links_off', used.platform)
    if (used.event_id === event.id) return c.json({ linked: true, platform: used.platform, identity: used.identity })
    return refuse('used', used.platform)
  }

  const pending = await getPendingSignIn(c.env.CACHE_KV, code)
  if (!pending) return refuse('not_found', null)
  // These refusals keep the code: someone else trying it mustn't cancel the owner's link.
  if (event.pubkey !== pending.pubkey) return refuse('wrong_account', pending.platform)
  if (!pending.startCheck) return refuse('no_start_check', pending.platform)
  if (!sameToken(await startCheckFor(startSecret), pending.startCheck)) return refuse('not_yours', pending.platform)

  const binding = await confirmBindingFor(code, pending.startCheck)
  const claims = savedIdentities(pending).map(id => `${pending.platform}:${id}`.toLowerCase())
  const bound = event.tags.some(tag => tag[0] === 'i' && typeof tag[1] === 'string'
    && claims.includes(tag[1].toLowerCase()) && typeof tag[3] === 'string' && sameToken(tag[3], binding))
  if (!bound) return refuse('claim_mismatch', pending.platform)
  // Last, so every other refusal keeps its precedence. Like them it keeps the
  // code.
  if (signInLinksAreOff(c.env, pending.platform)) return refuse('links_off', pending.platform)

  const account = { platform: pending.platform, identity: pending.identity, account_id: pending.account_id, handle: pending.handle }
  // Saved first, then marked used, then the pending sign-in removed: a failed
  // write leaves the code usable for a retry instead of losing the link.
  await saveSignIn(c.env, pending.pubkey, account, { event_id: event.id, created_at: event.created_at })
  await storeUsedCode(c.env.CACHE_KV, code, { event_id: event.id, platform: pending.platform, identity: pending.identity })
  // Only tidying up: the link is saved and the code is marked used, and the
  // pending sign-in expires on its own.
  try {
    await deletePendingSignIn(c.env.CACHE_KV, code)
  } catch {
    console.warn(`${pending.platform} sign-in confirmed: pending not removed`)
  }
  console.info(`${pending.platform} sign-in confirmed`)
  return c.json({ linked: true, platform: pending.platform, identity: pending.identity })
})

export default confirm
