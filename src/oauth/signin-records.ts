// ABOUTME: Saving sign-in records, confirmed or not, holding finished sign-ins
// ABOUTME: and reading the ones that count. Confirming is in confirm.ts (#113).
import type { Bindings, OAuthState, OAuthVerification, SignInCallbackResult } from '../types'
import { getOAuthVerification, storeOAuthVerification, oauthVerificationKey } from './state'
import { forgetHandleLookup } from './signin-account'
import { forgetBlueskyAccountStatus } from './bluesky-account-status'
import { signInConfirmationMode, newConfirmCode, storePendingSignIn, type SignedInAccount } from './confirm'
import { confirmationGate } from './confirmation-gate'
import { confirmationAccess, type ConfirmationAccess } from './confirmation-access'
import { signInIsCurrent } from './signin-lifetime'
import { signInLinksAreOff } from './signin-switch'
import { forgetYouTubeHandleLookup } from '../platforms/youtube-handle'
import { parseYouTubeIdentity } from '../utils/youtube-identity'

/** The event that confirmed a sign-in. */
export interface Confirmation {
  event_id: string
  created_at: number
}

// Bluesky sign-ins are saved under the handle and the DID, so a claim of
// either verifies; other platforms under the one identity. Confirming accepts
// a claim of exactly these.
export function savedIdentities(account: SignedInAccount): string[] {
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
  // An account reactivated since an inactive answer was remembered verifies at once.
  try {
    await forgetBlueskyAccountStatus(env, did)
  } catch (err) {
    console.warn('Bluesky sign-in: earlier account status not cleared:', err instanceof Error ? err.name : 'unknown')
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

// A YouTube sign-in named by its handle is checked by looking the handle up
// (signin-account.ts), and that lookup is remembered for a day. A handle can
// pass to another channel within that day, so a fresh sign-in forgets it.
// Best effort, like the Bluesky tidying above: the sign-in is saved either way.
async function forgetEarlierYouTubeLookup(env: Bindings, identity: string): Promise<void> {
  if (parseYouTubeIdentity(identity)?.kind !== 'handle') return
  try {
    await forgetYouTubeHandleLookup(env.CACHE_KV, identity)
  } catch (err) {
    console.warn('YouTube sign-in: earlier handle lookup not cleared:', err instanceof Error ? err.name : 'unknown')
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
  if (account.platform === 'youtube') await forgetEarlierYouTubeLookup(env, account.identity)
  const checkedAt = Math.floor(Date.now() / 1000)
  // Read once so the handle and DID records of one link carry the same mark.
  const accessRequired = confirmationGate(env) === 'on'
  for (const identity of savedIdentities(account)) {
    if (!confirmation) {
      // Best effort: KV reads are eventually consistent, so a confirmed record
      // saved moments ago in another location may not be seen yet.
      const existing = await getOAuthVerification(env.CACHE_KV, account.platform, identity, pubkey)
      if (existing?.confirmed === true && existing.account_id === account.account_id && sameHandle(existing.handle, account.handle) &&
        signInIsCurrent(existing, checkedAt)) continue
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
      ...(accessRequired ? { access_required: true as const } : {}),
      ...(confirmation ? { confirmed: true as const, confirm_event_id: confirmation.event_id, confirm_created_at: confirmation.created_at } : {}),
    })
  }
}

export type SignInStanding = { counted: OAuthVerification } | { counted: null; reason: 'none' | 'needs_confirmation' }

/**
 * Whether the sign-in record for a claim counts, and if not, why. Every reader
 * goes through here: once confirmation is required, only confirmed records
 * count, and a record counts only while its lifetime (signin-lifetime.ts)
 * lasts. A record also doesn't count while its platform's links are switched
 * off (signin-switch.ts). A record saved while the Confirmation gate was on
 * (access_required) counts only while its owner has Confirmation and the gate
 * is still on; an unavailable access check counts. Records are never deleted
 * here, so a link counts again once access returns or the gate is turned off.
 */
export async function signInStanding(
  env: Bindings,
  platform: string,
  identity: string,
  pubkey: string,
  accessFor: (pubkey: string) => Promise<ConfirmationAccess> = (pk) => confirmationAccess(env, pk),
): Promise<SignInStanding> {
  const none = { counted: null, reason: 'none' } as const
  if (signInLinksAreOff(env, platform)) return none
  const record = await getOAuthVerification(env.CACHE_KV, platform, identity, pubkey)
  if (!record) return none
  if (signInConfirmationMode(env) === 'required' && record.confirmed !== true) return none
  if (!signInIsCurrent(record, Math.floor(Date.now() / 1000))) return none
  if (record.access_required === true && confirmationGate(env) === 'on') {
    const access = await accessFor(pubkey)
    if (access !== 'yes') {
      console.info(`${platform} confirmation check for a saved link (on): ${access}`)
      if (access === 'no') return { counted: null, reason: 'needs_confirmation' }
    }
  }
  return { counted: record }
}

/** The sign-in record for a claim, if it counts (see signInStanding). The single reader. */
export async function getCountedSignIn(env: Bindings, platform: string, identity: string, pubkey: string): Promise<OAuthVerification | null> {
  return (await signInStanding(env, platform, identity, pubkey)).counted
}

/**
 * How every sign-in callback ends once the provider confirmed the account.
 * Before the switch, the sign-in is saved unconfirmed so apps that can't
 * confirm keep working. A sign-in started with a start check is also held
 * for its owner to confirm, under a one-time code sent to the return address.
 */
export async function holdSignIn(env: Bindings, state: OAuthState, account: SignedInAccount): Promise<SignInCallbackResult> {
  // TODO(#113): remove once SIGNIN_CONFIRMATION is "required".
  if (signInConfirmationMode(env) === 'optional') {
    // A sign-in that began before its platform's links were switched off must
    // leave nothing behind, neither a record nor a held sign-in with a code:
    // the return reports it as not completed, and a code that revives if the
    // switch is cleared would contradict that.
    if (signInLinksAreOff(env, state.platform)) return { success: true, returnUrl: state.returnUrl, identity: account.identity }
    // While the gate is shadow or on, /auth/confirm is the only route that
    // saves a record: it checks Confirmation only after the owner has proved
    // their key. state.pubkey is unproven here, so checking it would reveal
    // whether any pubkey has Confirmation.
    if (confirmationGate(env) === 'off') await saveSignIn(env, state.pubkey, account, null)
  }
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
