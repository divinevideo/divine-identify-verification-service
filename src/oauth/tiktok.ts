import type { Bindings, OAuthState } from '../types'
import { generatePKCE, generateRandomString } from './crypto'
import { storeOAuthState, getOAuthState, deleteOAuthState, storeOAuthVerification } from './state'

const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/'
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/'
const TIKTOK_USER_URL = 'https://open.tiktokapis.com/v2/user/info/'

export async function startTikTokOAuth(
  env: Bindings,
  pubkey: string,
  returnUrl: string,
): Promise<Response> {
  if (!env.TIKTOK_CLIENT_KEY || !env.OAUTH_REDIRECT_BASE) {
    return new Response(JSON.stringify({ error: 'TikTok OAuth not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { verifier, challenge } = await generatePKCE()
  const stateId = generateRandomString(16)

  const state: OAuthState = {
    platform: 'tiktok',
    pubkey,
    codeVerifier: verifier,
    returnUrl,
    createdAt: Date.now(),
  }

  await storeOAuthState(env.CACHE_KV, stateId, state)

  const redirectUri = `${env.OAUTH_REDIRECT_BASE}/auth/tiktok/callback`
  const params = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    response_type: 'code',
    scope: 'user.info.basic',
    redirect_uri: redirectUri,
    state: stateId,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  return Response.redirect(`${TIKTOK_AUTH_URL}?${params}`, 302)
}

export async function handleTikTokCallback(
  env: Bindings,
  code: string,
  stateId: string,
): Promise<{ success: boolean; returnUrl: string; error?: string; identity?: string }> {
  const state = await getOAuthState(env.CACHE_KV, stateId)
  if (!state || state.platform !== 'tiktok') {
    return { success: false, returnUrl: '/', error: 'Invalid or expired OAuth state' }
  }

  await deleteOAuthState(env.CACHE_KV, stateId)

  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET || !env.OAUTH_REDIRECT_BASE) {
    return { success: false, returnUrl: state.returnUrl, error: 'TikTok OAuth not configured' }
  }

  const redirectUri = `${env.OAUTH_REDIRECT_BASE}/auth/tiktok/callback`

  // Exchange code for token
  const tokenResponse = await fetch(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: state.codeVerifier,
    }),
  })

  if (!tokenResponse.ok) {
    return { success: false, returnUrl: state.returnUrl, error: 'TikTok token exchange failed' }
  }

  let tokenData: { access_token?: string }
  try {
    tokenData = await tokenResponse.json() as { access_token?: string }
  } catch {
    return { success: false, returnUrl: state.returnUrl, error: 'Invalid response from TikTok token endpoint' }
  }
  if (!tokenData.access_token) {
    return { success: false, returnUrl: state.returnUrl, error: 'No access token in TikTok response' }
  }

  // Fetch user info
  const userResponse = await fetch(`${TIKTOK_USER_URL}?fields=display_name,username`, {
    headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
  })

  if (!userResponse.ok) {
    return { success: false, returnUrl: state.returnUrl, error: 'Failed to fetch TikTok user info' }
  }

  let userData: { data?: { user?: { username?: string; display_name?: string } } }
  try {
    userData = await userResponse.json() as typeof userData
  } catch {
    return { success: false, returnUrl: state.returnUrl, error: 'Invalid response from TikTok user endpoint' }
  }

  const identity = userData.data?.user?.username
  if (!identity) {
    return { success: false, returnUrl: state.returnUrl, error: 'TikTok did not return a username' }
  }

  // Store OAuth verification
  await storeOAuthVerification(env.CACHE_KV, {
    platform: 'tiktok',
    identity,
    pubkey: state.pubkey,
    verified: true,
    method: 'oauth',
    checked_at: Math.floor(Date.now() / 1000),
  })

  return { success: true, returnUrl: state.returnUrl, identity }
}
