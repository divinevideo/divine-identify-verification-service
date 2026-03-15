import type { OAuthState, OAuthVerification } from '../types'

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

export async function storeOAuthVerification(kv: KVNamespace, verification: OAuthVerification): Promise<void> {
  const key = oauthVerificationKey(verification.platform, verification.identity, verification.pubkey)
  await kv.put(key, JSON.stringify(verification), { expirationTtl: OAUTH_VERIFICATION_TTL })
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

export async function deleteOAuthVerification(
  kv: KVNamespace,
  platform: string,
  identity: string,
  pubkey: string
): Promise<void> {
  const key = oauthVerificationKey(platform, identity, pubkey)
  await kv.delete(key)
}
