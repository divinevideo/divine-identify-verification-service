import type { OAuthState, OAuthVerification } from '../types'

const STATE_TTL = 600 // 10 minutes for OAuth flow
const OAUTH_VERIFICATION_TTL = 24 * 60 * 60 // 24 hours
// TODO(#90): keep Bluesky sign-ins until they are unlinked; the issue lists what has to land first.
const BLUESKY_SIGNIN_TTL = 30 * 24 * 60 * 60 // 30 days, not renewed by checks

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

// A Bluesky sign-in lasts 30 days: it is tied to the account's DID, which is
// checked against the handle when the claim is verified. Other platforms keep
// the 24-hour record until their sign-ins get the same check.
export async function storeOAuthVerification(kv: KVNamespace, verification: OAuthVerification): Promise<void> {
  const key = oauthVerificationKey(verification.platform, verification.identity, verification.pubkey)
  const ttl = verification.platform === 'bluesky' && verification.account_id ? BLUESKY_SIGNIN_TTL : OAUTH_VERIFICATION_TTL
  await kv.put(key, JSON.stringify(verification), { expirationTtl: ttl })
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

// A sign-in saved under both a handle and a DID is removed under both, so
// unlinking either one leaves nothing behind. The other record goes only while
// it still belongs to this sign-in: after a handle change, the DID record
// belongs to the newer one. The requested record goes last, so an unlink that
// fails partway can be retried.
export async function deleteOAuthVerification(
  kv: KVNamespace,
  platform: string,
  identity: string,
  pubkey: string
): Promise<void> {
  const record = await getOAuthVerification(kv, platform, identity, pubkey)
  if (record?.account_id) {
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
