import type { Bindings, OAuthState } from '../types'
import { generatePKCE, generateRandomString, generateDPoPKeyPair, importDPoPPrivateKey, createDPoPProof } from './crypto'
import { storeOAuthState, getOAuthState, deleteOAuthState, storeOAuthVerification } from './state'

/** Validate that a URL is HTTPS and points to a public host (SSRF protection) */
function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr)
    if (url.protocol !== 'https:') return false
    const hostname = url.hostname
    // Block private IPs, localhost, internal domains
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false
    if (hostname.startsWith('[') || hostname.includes(':')) return false
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false
    if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.corp')) return false
    return true
  } catch {
    return false
  }
}

// AT Protocol OAuth: discover the authorization server for a handle
async function resolveAuthServer(handle: string): Promise<{
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  pushedAuthorizationRequestEndpoint: string
} | null> {
  // 1. Resolve handle to PDS
  const resolveUrl = `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
  const resolveResp = await fetch(resolveUrl)
  if (!resolveResp.ok) return null
  let resolveData: { did?: string }
  try {
    resolveData = await resolveResp.json() as { did?: string }
  } catch {
    return null
  }
  const did = resolveData.did
  if (!did) return null

  // 2. Get PDS from DID document
  let pdsUrl: string | null = null
  if (did.startsWith('did:plc:')) {
    const didResp = await fetch(`https://plc.directory/${did}`)
    if (!didResp.ok) return null
    let didDoc: { service?: Array<{ id: string; serviceEndpoint: string }> }
    try {
      didDoc = await didResp.json() as typeof didDoc
    } catch { return null }
    pdsUrl = didDoc.service?.find(s => s.id === '#atproto_pds')?.serviceEndpoint || null
  } else if (did.startsWith('did:web:')) {
    const domain = decodeURIComponent(did.slice('did:web:'.length))
    // Block path traversal in did:web domains (e.g., did:web:evil.com%2F..%2Flocalhost)
    if (domain.includes('/') || domain.includes('\\')) return null
    const didWebUrl = `https://${domain}/.well-known/did.json`
    if (!isSafeUrl(didWebUrl)) return null
    const didResp = await fetch(didWebUrl)
    if (!didResp.ok) return null
    let didDoc: { service?: Array<{ id: string; serviceEndpoint: string }> }
    try {
      didDoc = await didResp.json() as typeof didDoc
    } catch { return null }
    pdsUrl = didDoc.service?.find(s => s.id === '#atproto_pds')?.serviceEndpoint || null
  }

  if (!pdsUrl || !isSafeUrl(pdsUrl)) return null

  // 3. Get authorization server from PDS resource metadata
  const resourceResp = await fetch(`${pdsUrl}/.well-known/oauth-protected-resource`)
  if (!resourceResp.ok) return null
  let resourceMeta: { authorization_servers?: string[] }
  try {
    resourceMeta = await resourceResp.json() as typeof resourceMeta
  } catch { return null }
  const issuer = resourceMeta.authorization_servers?.[0]
  if (!issuer || !isSafeUrl(issuer)) return null

  // 4. Get authorization server metadata
  const authResp = await fetch(`${issuer}/.well-known/oauth-authorization-server`)
  if (!authResp.ok) return null
  let authMeta: {
    issuer: string
    authorization_endpoint: string
    token_endpoint: string
    pushed_authorization_request_endpoint: string
  }
  try {
    authMeta = await authResp.json() as typeof authMeta
  } catch { return null }

  // Validate all discovered endpoints are safe HTTPS URLs
  if (!isSafeUrl(authMeta.authorization_endpoint) ||
      !isSafeUrl(authMeta.token_endpoint) ||
      !isSafeUrl(authMeta.pushed_authorization_request_endpoint)) {
    return null
  }

  return {
    issuer: authMeta.issuer,
    authorizationEndpoint: authMeta.authorization_endpoint,
    tokenEndpoint: authMeta.token_endpoint,
    pushedAuthorizationRequestEndpoint: authMeta.pushed_authorization_request_endpoint,
  }
}

export async function startBlueskyOAuth(
  env: Bindings,
  pubkey: string,
  handle: string,
  returnUrl: string,
): Promise<Response> {
  if (!env.OAUTH_REDIRECT_BASE) {
    return new Response(JSON.stringify({ error: 'OAuth not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Discover authorization server
  const authServer = await resolveAuthServer(handle)
  if (!authServer) {
    return new Response(JSON.stringify({ error: 'Could not discover Bluesky authorization server for this handle' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { verifier, challenge } = await generatePKCE()
  const stateId = generateRandomString(16)
  const { publicJwk, privateJwk } = await generateDPoPKeyPair()

  const redirectUri = `${env.OAUTH_REDIRECT_BASE}/auth/bluesky/callback`
  // client_id is the URL to client metadata (hosted by this worker)
  const clientId = `${env.OAUTH_REDIRECT_BASE}/auth/bluesky/client-metadata.json`

  // Store state with DPoP keys
  const state: OAuthState = {
    platform: 'bluesky',
    pubkey,
    codeVerifier: verifier,
    returnUrl,
    createdAt: Date.now(),
    dpopPrivateJwk: privateJwk,
    dpopPublicJwk: publicJwk,
    issuer: authServer.issuer,
    tokenEndpoint: authServer.tokenEndpoint,
  }
  await storeOAuthState(env.CACHE_KV, stateId, state)

  // PAR: Push Authorization Request (required by AT Protocol OAuth)
  const privateKey = await importDPoPPrivateKey(privateJwk)
  const dpopProof = await createDPoPProof(
    privateKey,
    publicJwk,
    'POST',
    authServer.pushedAuthorizationRequestEndpoint,
  )

  const parBody = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'atproto',
    state: stateId,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_hint: handle,
  })

  const parResp = await fetch(authServer.pushedAuthorizationRequestEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'DPoP': dpopProof,
    },
    body: parBody,
  })

  if (!parResp.ok) {
    return new Response(JSON.stringify({ error: 'Bluesky authorization request failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let parData: { request_uri?: string }
  try {
    parData = await parResp.json() as typeof parData
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid response from Bluesky authorization server' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (!parData.request_uri) {
    return new Response(JSON.stringify({ error: 'Missing request_uri from Bluesky authorization server' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Redirect to authorization endpoint
  const authParams = new URLSearchParams({
    client_id: clientId,
    request_uri: parData.request_uri,
  })

  return Response.redirect(`${authServer.authorizationEndpoint}?${authParams}`, 302)
}

export async function handleBlueskyCallback(
  env: Bindings,
  code: string,
  stateId: string,
  iss: string,
): Promise<{ success: boolean; returnUrl: string; error?: string; identity?: string }> {
  const state = await getOAuthState(env.CACHE_KV, stateId)
  if (!state || state.platform !== 'bluesky') {
    return { success: false, returnUrl: '/', error: 'Invalid or expired OAuth state' }
  }

  await deleteOAuthState(env.CACHE_KV, stateId)

  // Verify issuer matches
  if (iss !== state.issuer) {
    return { success: false, returnUrl: state.returnUrl, error: 'Issuer mismatch' }
  }

  if (!state.dpopPrivateJwk || !state.dpopPublicJwk || !state.tokenEndpoint || !env.OAUTH_REDIRECT_BASE) {
    return { success: false, returnUrl: state.returnUrl, error: 'Incomplete OAuth state' }
  }

  const privateKey = await importDPoPPrivateKey(state.dpopPrivateJwk)
  const clientId = `${env.OAUTH_REDIRECT_BASE}/auth/bluesky/client-metadata.json`
  const redirectUri = `${env.OAUTH_REDIRECT_BASE}/auth/bluesky/callback`

  // Exchange code for token with DPoP
  const dpopProof = await createDPoPProof(
    privateKey,
    state.dpopPublicJwk,
    'POST',
    state.tokenEndpoint,
  )

  const tokenResp = await fetch(state.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'DPoP': dpopProof,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: state.codeVerifier,
    }),
  })

  if (!tokenResp.ok) {
    // Handle DPoP nonce requirement (common in AT Proto)
    const dpopNonce = tokenResp.headers.get('DPoP-Nonce')
    if (dpopNonce && tokenResp.status === 400) {
      // Retry with nonce
      const dpopProofRetry = await createDPoPProof(
        privateKey,
        state.dpopPublicJwk,
        'POST',
        state.tokenEndpoint,
        dpopNonce,
      )

      const retryResp = await fetch(state.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'DPoP': dpopProofRetry,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: state.codeVerifier,
        }),
      })

      if (!retryResp.ok) {
        return { success: false, returnUrl: state.returnUrl, error: 'Bluesky token exchange failed' }
      }

      return await processBlueskyToken(retryResp, state, env)
    }

    return { success: false, returnUrl: state.returnUrl, error: 'Bluesky token exchange failed' }
  }

  return await processBlueskyToken(tokenResp, state, env)
}

async function processBlueskyToken(
  tokenResp: Response,
  state: OAuthState,
  env: Bindings,
): Promise<{ success: boolean; returnUrl: string; error?: string; identity?: string }> {
  let tokenData: { sub?: string }
  try {
    tokenData = await tokenResp.json() as typeof tokenData
  } catch {
    return { success: false, returnUrl: state.returnUrl, error: 'Invalid response from Bluesky token endpoint' }
  }

  // sub is the user's DID
  const did = tokenData.sub
  if (!did) {
    return { success: false, returnUrl: state.returnUrl, error: 'No DID in token response' }
  }

  // Resolve DID to handle for identity
  let handle = did
  try {
    if (did.startsWith('did:plc:')) {
      const didResp = await fetch(`https://plc.directory/${did}`)
      if (didResp.ok) {
        const didDoc = await didResp.json() as { alsoKnownAs?: string[] }
        const atHandle = didDoc.alsoKnownAs?.find(a => a.startsWith('at://'))
        if (atHandle) handle = atHandle.slice('at://'.length)
      }
    }
  } catch {
    // Use DID as identity if handle resolution fails
  }

  // Store OAuth verification
  await storeOAuthVerification(env.CACHE_KV, {
    platform: 'bluesky',
    identity: handle,
    pubkey: state.pubkey,
    verified: true,
    method: 'oauth',
    checked_at: Math.floor(Date.now() / 1000),
  })

  return { success: true, returnUrl: state.returnUrl, identity: handle }
}

export function blueskyClientMetadata(baseUrl: string): object {
  return {
    client_id: `${baseUrl}/auth/bluesky/client-metadata.json`,
    client_name: 'Divine Identity Verification',
    client_uri: 'https://divine.video',
    redirect_uris: [`${baseUrl}/auth/bluesky/callback`],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'atproto',
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  }
}
