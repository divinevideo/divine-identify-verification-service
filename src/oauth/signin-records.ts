// ABOUTME: Saving sign-in records, confirmed or not, holding finished sign-ins
// ABOUTME: and reading the ones that count. Confirming is in confirm.ts (#113).
import type { Bindings, OAuthState, OAuthVerification, SignInCallbackResult } from '../types'
import { getOAuthVerification, storeOAuthVerification, oauthVerificationKey } from './state'
import { forgetHandleLookup } from './signin-account'
import { signInConfirmationMode, newConfirmCode, storePendingSignIn, type SignedInAccount } from './confirm'
import { isRecheckedLink, signInIsCurrent } from './signin-lifetime'

/** The event that confirmed a sign-in. */
export interface Confirmation {
  event_id: string
  created_at: number
}

// Bluesky sign-ins are saved under the handle and the DID, so a claim of
// either verifies; other platforms under the one identity.
function savedIdentities(account: SignedInAccount): string[] {
  return account.platform === 'bluesky' && account.account_id ? [account.identity, account.account_id] : [account.identity]
}

// Tidying up after earlier sign-ins is best effort; the new link is saved
// either way, and one step failing doesn't skip the other.
async function tidyEarlierBlueskySignIn(env: Bindings, pubkey: string, did: string, handle: string): Promise<void> {
  try {
    await forgetHandleLookup(env, handle)
  } catch (err) {
    console.warn('Bluesky sign-in: earlier handle lookup not cleared:', err)
  }
  try {
    // A handle change leaves a record under the old handle. Remove it while it
    // still belongs to this account, so it can't verify again if that handle
    // ever points back here.
    const previous = await getOAuthVerification(env.CACHE_KV, 'bluesky', did, pubkey)
    if (previous?.handle && previous.handle.toLowerCase() !== handle.toLowerCase()) {
      const old = await getOAuthVerification(env.CACHE_KV, 'bluesky', previous.handle, pubkey)
      if (old?.account_id === did) await env.CACHE_KV.delete(oauthVerificationKey('bluesky', previous.handle, pubkey))
    }
  } catch (err) {
    console.warn('Bluesky sign-in: earlier handle record not removed:', err)
  }
}

// After a handle change, an unconfirmed sign-in replaces the confirmed DID
// record too, so the handle and DID records stay a pair that unlinks together.
const sameHandle = (a: string | undefined, b: string | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase()

/**
 * Saves a sign-in record. With a confirmation it is a confirmed record; without
 * one (an app that can't confirm, before the switch) it never replaces a
 * confirmed record for the same account and handle that still counts.
 */
export async function saveSignIn(env: Bindings, pubkey: string, account: SignedInAccount, confirmation: Confirmation | null): Promise<void> {
  if (account.platform === 'bluesky' && account.account_id && account.handle) {
    await tidyEarlierBlueskySignIn(env, pubkey, account.account_id, account.handle)
  }
  const checkedAt = Math.floor(Date.now() / 1000)
  for (const identity of savedIdentities(account)) {
    if (!confirmation) {
      // Best effort: KV reads are eventually consistent, so a confirmed record
      // saved moments ago in another location may not be seen yet.
      const existing = await getOAuthVerification(env.CACHE_KV, account.platform, identity, pubkey)
      if (existing?.confirmed === true && existing.account_id === account.account_id && sameHandle(existing.handle, account.handle) &&
        signInIsCurrent(env, existing, checkedAt)) continue
    }
    await storeOAuthVerification(env.CACHE_KV, {
      platform: account.platform,
      identity,
      pubkey,
      verified: true,
      method: 'oauth',
      checked_at: checkedAt,
      ...(account.account_id ? { account_id: account.account_id } : {}),
      ...(account.handle ? { handle: account.handle } : {}),
      ...(confirmation ? { confirmed: true as const, confirm_event_id: confirmation.event_id, confirm_created_at: confirmation.created_at } : {}),
    })
  }
}

/**
 * The sign-in record for a claim, if it counts. Every reader goes through
 * here: once confirmation is required, only confirmed records count, and a
 * record counts only while its lifetime (signin-lifetime.ts) lasts.
 */
export async function getCountedSignIn(env: Bindings, platform: string, identity: string, pubkey: string): Promise<OAuthVerification | null> {
  const record = await getOAuthVerification(env.CACHE_KV, platform, identity, pubkey)
  if (!record) return null
  if (signInConfirmationMode(env) === 'required' && record.confirmed !== true) return null
  if (!signInIsCurrent(env, record, Math.floor(Date.now() / 1000))) return null
  return record
}

/**
 * Stores again, with no expiry, a re-checked link saved with the earlier 30-day
 * expiry, so it doesn't lapse while the account still matches. Its pair (the
 * Bluesky record under the other of handle and DID) goes with it, so the two
 * still unlink together. Called once the account was checked; best effort,
 * since a failed write leaves the record as it was and never fails the check.
 *
 * The account check counts as passed when Bluesky couldn't answer it
 * (signin-account.ts), so a record can be carried forward then. That is safe
 * because every later verification checks the account again.
 *
 * Once the claimed record is marked, later verifications of this claim skip this step, so a
 * pair whose write failed isn't tried again and keeps its old expiry. That is
 * preferred to retrying on every verification: the claimed link keeps counting
 * instead of lapsing at its old expiry, and only the pair's record may lapse.
 */
export async function keepSignInWithoutExpiry(env: Bindings, record: OAuthVerification): Promise<void> {
  if (record.stored_without_expiry === true || !isRecheckedLink(env, record)) return
  // The account check ran between reading the record and here, and an unlink
  // or a newer sign-in may have changed it, so each record is read again just
  // before it is written. KV reads can lag a change made elsewhere, so this
  // narrows the window rather than closing it.
  await storeAgainWithoutExpiry(env, record.identity, record, current => current.checked_at === record.checked_at)
  const others = new Set([record.handle, record.account_id]
    .filter((id): id is string => !!id && id.toLowerCase() !== record.identity.toLowerCase())
    .map(id => id.toLowerCase()))
  for (const id of others) await storeAgainWithoutExpiry(env, id, record, () => true)
}

// Stores the record under `identity` again with no expiry, while it is still a
// re-checked link of the same sign-in, matched by account and handle as
// unlinking pairs them, and hasn't been stored that way yet.
async function storeAgainWithoutExpiry(
  env: Bindings,
  identity: string,
  signIn: OAuthVerification,
  unchanged: (current: OAuthVerification) => boolean,
): Promise<void> {
  try {
    const current = await getOAuthVerification(env.CACHE_KV, signIn.platform, identity, signIn.pubkey)
    if (!current || current.stored_without_expiry === true || !isRecheckedLink(env, current)) return
    if (current.account_id !== signIn.account_id || current.handle !== signIn.handle || !unchanged(current)) return
    await storeOAuthVerification(env.CACHE_KV, current)
  } catch (err) {
    console.warn('Sign-in record not stored again without an expiry:', err)
  }
}

/**
 * How every sign-in callback ends once the provider confirmed the account.
 * Before the switch, the sign-in is saved unconfirmed so apps that can't
 * confirm keep working. A sign-in started with a start check is also held
 * for its owner to confirm, under a one-time code sent to the return address.
 */
export async function holdSignIn(env: Bindings, state: OAuthState, account: SignedInAccount): Promise<SignInCallbackResult> {
  // TODO(#113): remove once SIGNIN_CONFIRMATION is "required".
  if (signInConfirmationMode(env) === 'optional') await saveSignIn(env, state.pubkey, account, null)
  let confirmCode: string | undefined
  if (state.startCheck) {
    confirmCode = newConfirmCode()
    await storePendingSignIn(env.CACHE_KV, confirmCode, {
      ...account,
      pubkey: state.pubkey,
      startCheck: state.startCheck,
      finishedAt: Date.now(),
    })
  }
  return { success: true, returnUrl: state.returnUrl, identity: account.identity, ...(confirmCode ? { confirmCode } : {}) }
}
