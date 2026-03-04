import type { Bindings, OAuthState } from '../types'
import { generatePKCE, generateRandomString } from './crypto'
import { storeOAuthState, getOAuthState, deleteOAuthState, storeOAuthVerification } from './state'

const TWITTER_AUTH_URL = 'https://twitter.com/i/oauth2/authorize'
const TWITTER_TOKEN_URL = 'https://api.twitter.com/2/oauth2/token'
const TWITTER_USER_URL = 'https://api.twitter.com/2/users/me'

export async function startTwitterOAuth(
  env: Bindings,
  pubkey: string,
  returnUrl: string,
): Promise<Response> {
  if (!env.TWITTER_CLIENT_ID || !env.OAUTH_REDIRECT_BASE) {
    return new Response(JSON.stringify({ error: 'Twitter OAuth not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { verifier, challenge } = await generatePKCE()
  const stateId = generateRandomString(16)

  const state: OAuthState = {
    platform: 'twitter',
    pubkey,
    codeVerifier: verifier,
    returnUrl,
    createdAt: Date.now(),
  }

  await storeOAuthState(env.CACHE_KV, stateId, state)

  const redirectUri = `${env.OAUTH_REDIRECT_BASE}/auth/twitter/callback`
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.TWITTER_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'users.read tweet.read',
    state: stateId,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  return Response.redirect(`${TWITTER_AUTH_URL}?${params}`, 302)
}

export async function handleTwitterCallback(
  env: Bindings,
  code: string,
  stateId: string,
): Promise<{ success: boolean; returnUrl: string; error?: string; identity?: string }> {
  const state = await getOAuthState(env.CACHE_KV, stateId)
  if (!state || state.platform !== 'twitter') {
    return { success: false, returnUrl: '/', error: 'Invalid or expired OAuth state' }
  }

  await deleteOAuthState(env.CACHE_KV, stateId)

  if (!env.TWITTER_CLIENT_ID || !env.TWITTER_CLIENT_SECRET || !env.OAUTH_REDIRECT_BASE) {
    return { success: false, returnUrl: state.returnUrl, error: 'Twitter OAuth not configured' }
  }

  const redirectUri = `${env.OAUTH_REDIRECT_BASE}/auth/twitter/callback`

  // Exchange code for token
  const tokenResponse = await fetch(TWITTER_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(`${env.TWITTER_CLIENT_ID}:${env.TWITTER_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: state.codeVerifier,
    }),
  })

  if (!tokenResponse.ok) {
    return { success: false, returnUrl: state.returnUrl, error: 'Twitter token exchange failed' }
  }

  let tokenData: { access_token?: string }
  try {
    tokenData = await tokenResponse.json() as { access_token?: string }
  } catch {
    return { success: false, returnUrl: state.returnUrl, error: 'Invalid response from Twitter token endpoint' }
  }
  if (!tokenData.access_token) {
    return { success: false, returnUrl: state.returnUrl, error: 'No access token in Twitter response' }
  }

  // Get user info
  const userResponse = await fetch(TWITTER_USER_URL, {
    headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
  })

  if (!userResponse.ok) {
    return { success: false, returnUrl: state.returnUrl, error: 'Failed to fetch Twitter user info' }
  }

  let userData: { data?: { username?: string; id?: string } }
  try {
    userData = await userResponse.json() as { data?: { username?: string; id?: string } }
  } catch {
    return { success: false, returnUrl: state.returnUrl, error: 'Invalid response from Twitter user endpoint' }
  }
  const identity = userData.data?.username
  if (!identity) {
    return { success: false, returnUrl: state.returnUrl, error: 'Twitter did not return a username' }
  }

  // Store OAuth verification
  await storeOAuthVerification(env.CACHE_KV, {
    platform: 'twitter',
    identity,
    pubkey: state.pubkey,
    verified: true,
    method: 'oauth',
    checked_at: Math.floor(Date.now() / 1000),
  })

  return { success: true, returnUrl: state.returnUrl, identity }
}
