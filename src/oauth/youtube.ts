import type { Bindings, OAuthState } from '../types'
import { generatePKCE, generateRandomString } from './crypto'
import { storeOAuthState, getOAuthState, deleteOAuthState, storeOAuthVerification } from './state'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const YOUTUBE_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels'

export async function startYouTubeOAuth(
  env: Bindings,
  pubkey: string,
  returnUrl: string,
): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.OAUTH_REDIRECT_BASE) {
    return new Response(JSON.stringify({ error: 'YouTube OAuth not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { verifier, challenge } = await generatePKCE()
  const stateId = generateRandomString(16)

  const state: OAuthState = {
    platform: 'youtube',
    pubkey,
    codeVerifier: verifier,
    returnUrl,
    createdAt: Date.now(),
  }

  await storeOAuthState(env.CACHE_KV, stateId, state)

  const redirectUri = `${env.OAUTH_REDIRECT_BASE}/auth/youtube/callback`
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
    state: stateId,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'online',
  })

  return Response.redirect(`${GOOGLE_AUTH_URL}?${params}`, 302)
}

export async function handleYouTubeCallback(
  env: Bindings,
  code: string,
  stateId: string,
): Promise<{ success: boolean; returnUrl: string; error?: string; identity?: string }> {
  const state = await getOAuthState(env.CACHE_KV, stateId)
  if (!state || state.platform !== 'youtube') {
    return { success: false, returnUrl: '/', error: 'Invalid or expired OAuth state' }
  }

  await deleteOAuthState(env.CACHE_KV, stateId)

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.OAUTH_REDIRECT_BASE) {
    return { success: false, returnUrl: state.returnUrl, error: 'YouTube OAuth not configured' }
  }

  const redirectUri = `${env.OAUTH_REDIRECT_BASE}/auth/youtube/callback`

  // Exchange code for token
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code_verifier: state.codeVerifier,
    }),
  })

  if (!tokenResponse.ok) {
    return { success: false, returnUrl: state.returnUrl, error: 'Google token exchange failed' }
  }

  let tokenData: { access_token?: string }
  try {
    tokenData = await tokenResponse.json() as { access_token?: string }
  } catch {
    return { success: false, returnUrl: state.returnUrl, error: 'Invalid response from Google token endpoint' }
  }
  if (!tokenData.access_token) {
    return { success: false, returnUrl: state.returnUrl, error: 'No access token in Google response' }
  }

  // Fetch authenticated user's YouTube channel
  const channelResponse = await fetch(`${YOUTUBE_CHANNELS_URL}?part=snippet&mine=true`, {
    headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
  })

  if (!channelResponse.ok) {
    return { success: false, returnUrl: state.returnUrl, error: 'Failed to fetch YouTube channel info' }
  }

  let channelData: { items?: Array<{ id?: string; snippet?: { customUrl?: string; title?: string } }> }
  try {
    channelData = await channelResponse.json() as typeof channelData
  } catch {
    return { success: false, returnUrl: state.returnUrl, error: 'Invalid response from YouTube channels endpoint' }
  }

  const channel = channelData.items?.[0]
  if (!channel?.id) {
    return { success: false, returnUrl: state.returnUrl, error: 'No YouTube channel found for this account' }
  }

  // Use customUrl (handle) if available, otherwise channel ID
  const identity = channel.snippet?.customUrl || channel.id

  // Store OAuth verification
  await storeOAuthVerification(env.CACHE_KV, {
    platform: 'youtube',
    identity,
    pubkey: state.pubkey,
    verified: true,
    method: 'oauth',
    checked_at: Math.floor(Date.now() / 1000),
  })

  return { success: true, returnUrl: state.returnUrl, identity }
}
