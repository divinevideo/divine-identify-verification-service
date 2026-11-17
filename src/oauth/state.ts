import type { OAuthState, OAuthVerification } from '../types'
import { FIXED_SIGNIN_LIFETIME_DAYS, keepsUntilUnlinked } from './signin-lifetime'

const STATE_TTL = 600 // 10 minutes for OAuth flow
const OAUTH_VERIFICATION_TTL = 24 * 60 * 60 // 24 hours

export function oauthStateKey(state: string): string {
  return `oauth_state:${state}`
}

export function oauthVerificationKey(platform: string, identity: string, pubkey: string): string {
  return `oauth_verified:${platform}:${identity.toLowerCase()}:${pubkey}`
}

export async function storeOAuthState(kv: KVNamespace, stateId: string, state: OAuthState): Promise<void> {
  await kv.put(oauthStateKey(stateId), JSON.stringify(state), { expirationTtl: STATE_TTL })
}

export async function getOAuthState(kv: KVNamespace, stateId: string): Promise<OAuthState | null> {
  const raw = await kv.get(oauthStateKey(stateId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as OAuthState
  } catch {
    return null
  }
}

export async function deleteOAuthState(kv: KVNamespace, stateId: string): Promise<void> {
  await kv.delete(oauthStateKey(stateId))
}

const CONFIRMED_TTL_SECONDS = FIXED_SIGNIN_LIFETIME_DAYS * 24 * 60 * 60

// A confirmed Bluesky sign-in saved with its DID is stored with no expiry and marked `kept`,
// so it lasts until its owner unlinks it (#90). Every other confirmed sign-in is stored for
// 30 days, and an unconfirmed one for a day. The age check (signin-lifetime.ts) counts such a
// record at any age; one without a DID is stored for 30 days like the other platforms'. Any
// `kept` mark passed in is dropped, so only this function sets it.
// Rolling the code back below #90 leaves kept records behind: see Rollback
// in docs/production-deployment.md.
export async function storeOAuthVerification(kv: KVNamespace, verification: OAuthVerification): Promise<void> {
  const key = oauthVerificationKey(verification.platform, verification.identity, verification.pubkey)
  const { kept: _kept, ...record } = verification
  if (keepsUntilUnlinked(record)) {
    await kv.put(key, JSON.stringify({ ...record, kept: true }))
    return
  }
  const ttl = record.confirmed === true ? CONFIRMED_TTL_SECONDS : OAUTH_VERIFICATION_TTL
  await kv.put(key, JSON.stringify(record), { expirationTtl: ttl })
}

export async function getOAuthVerification(
  kv: KVNamespace,
  platform: string,
  identity: string,
  pubkey: string
): Promise<OAuthVerification | null> {
  const key = oauthVerificationKey(platform, identity, pubkey)
  const raw = await kv.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as OAuthVerification
  } catch {
    return null
  }
}

// A Bluesky sign-in saved under both a handle and a DID is removed under both,
// so unlinking either one leaves nothing behind. The other record goes only
// while it still belongs to this sign-in: after a handle change, the DID record
// belongs to the newer one. The requested record goes last, so an unlink that
// fails partway can be retried. Other platforms save each link under its one
// identity, so only that record goes, even when another link shares its
// account ID.
// Two best-effort paths can leave a record behind: a read of the requested or
// paired record that is a stale or cached miss, and a failed delete of the
// old-handle record after a handle change. Before #90 such a leftover expired
// within 30 days; a kept one now stays until removed. It shows only if its
// owner's profile names it again.
export async function deleteOAuthVerification(
  kv: KVNamespace,
  platform: string,
  identity: string,
  pubkey: string,
  checkedRecord?: OAuthVerification | null
): Promise<void> {
  const record = checkedRecord === undefined ? await getOAuthVerification(kv, platform, identity, pubkey) : checkedRecord
  if (platform === 'bluesky' && record?.account_id) {
    const others = new Set([record.handle, record.account_id]
      .filter((id): id is string => !!id && id.toLowerCase() !== identity.toLowerCase())
      .map(id => id.toLowerCase()))
    for (const id of others) {
      const other = await getOAuthVerification(kv, platform, id, pubkey)
      if (other?.account_id === record.account_id && other.handle === record.handle) {
        await kv.delete(oauthVerificationKey(platform, id, pubkey))
      }
    }
  }
  await kv.delete(oauthVerificationKey(platform, identity, pubkey))
}
