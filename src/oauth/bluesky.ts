import type { Bindings, OAuthState } from '../types'
import { generatePKCE, generateRandomString, generateDPoPKeyPair, importDPoPPrivateKey, createDPoPProof } from './crypto'
import { storeOAuthState, getOAuthState, deleteOAuthState, storeOAuthVerification, getOAuthVerification, oauthVerificationKey } from './state'
import { forgetHandleLookup } from './signin-account'
import { getHandleFromDidDocument, getPdsEndpoint, isSafeUrl, resolveDidDocument, resolveHandle } from '../atproto'

// The authorization server a PDS (resource server) declares.
async function pdsAuthorizationServer(pdsUrl: string): Promise<string | null> {
  const resourceResp = await fetch(`${pdsUrl}/.well-known/oauth-protected-resource`)
  if (!resourceResp.ok) return null
  let resourceMeta: { authorization_servers?: string[] }
  try {
    resourceMeta = await resourceResp.json() as typeof resourceMeta
  } catch { return null }
  const issuer = resourceMeta.authorization_servers?.[0]
  if (!issuer || !isSafeUrl(issuer)) return null
  return issuer
}

// AT Protocol OAuth: discover the authorization server for a handle
async function resolveAuthServer(handle: string): Promise<{
  did: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  pushedAuthorizationRequestEndpoint: string
} | null> {
  // 1. Resolve handle to PDS
  const did = await resolveHandle(handle)
  if (!did) return null

  // 2. Get PDS from DID document
  const didDoc = await resolveDidDocument(did)
  if (!didDoc) return null
  const pdsUrl = getPdsEndpoint(didDoc)
  if (!pdsUrl) return null

  // 3. Get authorization server from PDS resource metadata
  const issuer = await pdsAuthorizationServer(pdsUrl)
  if (!issuer) return null

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

  // The metadata must describe the server it was fetched from
  if (authMeta.issuer !== issuer) return null

  // Validate all discovered endpoints are safe HTTPS URLs
  if (!isSafeUrl(authMeta.authorization_endpoint) ||
      !isSafeUrl(authMeta.token_endpoint) ||
      !isSafeUrl(authMeta.pushed_authorization_request_endpoint)) {
    return null
  }

  return {
    did,
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
    did: authServer.did,
    handle: handle.toLowerCase(),
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

  // AT Protocol OAuth requires DPoP nonce exchange: the auth server rejects
  // the first PAR request with a use_dpop_nonce error and a DPoP-Nonce header.
  // We retry once with the nonce included in the DPoP proof.
  let parResp = await fetch(authServer.pushedAuthorizationRequestEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'DPoP': dpopProof,
    },
    body: parBody,
  })

  if (!parResp.ok) {
    const dpopNonce = parResp.headers.get('DPoP-Nonce')
    if (dpopNonce) {
      const dpopProofWithNonce = await createDPoPProof(
        privateKey,
        publicJwk,
        'POST',
        authServer.pushedAuthorizationRequestEndpoint,
        dpopNonce,
      )
      parResp = await fetch(authServer.pushedAuthorizationRequestEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'DPoP': dpopProofWithNonce,
        },
        body: parBody,
      })
    }
  }

  if (!parResp.ok) {
    let detail = ''
    try { detail = await parResp.text() } catch {}
    console.error('Bluesky PAR failed:', parResp.status, detail)
    return new Response(JSON.stringify({ error: 'Bluesky authorization request failed', status: parResp.status, detail }), {
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

async function confirmedHandle(did: string, state: OAuthState): Promise<string | null> {
  const failed = (check: string) => {
    console.warn(`Bluesky sign-in not confirmed: ${check}`)
    return null
  }
  if (!state.did || !state.handle) return failed('state')
  if (did !== state.did) return failed('account')
  try {
    const didDoc = await resolveDidDocument(did)
    if (!didDoc) return failed('did_document')
    const pdsUrl = getPdsEndpoint(didDoc)
    if (!pdsUrl || await pdsAuthorizationServer(pdsUrl) !== state.issuer) return failed('authorization_server')
    // The first handle a DID document lists is the one it claims
    if (getHandleFromDidDocument(didDoc)?.toLowerCase() !== state.handle) return failed('handle')
    return state.handle
  } catch {
    return failed('lookup')
  }
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

  // Confirm the account, as the AT Protocol OAuth spec requires: it is the one
  // the sign-in started with, its PDS uses the authorization server the sign-in
  // went through, and its DID document claims the handle the person entered.
  const handle = await confirmedHandle(did, state)
  if (!handle) {
    return { success: false, returnUrl: state.returnUrl, error: 'Bluesky account not confirmed' }
  }

  // Tidying up after earlier sign-ins is best effort; the new link is saved
  // either way, and one step failing doesn't skip the other.
  try {
    await forgetHandleLookup(env, handle)
  } catch (err) {
    console.warn('Bluesky sign-in: earlier handle lookup not cleared:', err)
  }
  try {
    // A handle change leaves a record under the old handle. Remove it while it
    // still belongs to this account, so it can't verify again if that handle
    // ever points back here.
    const previous = await getOAuthVerification(env.CACHE_KV, 'bluesky', did, state.pubkey)
    if (previous?.handle && previous.handle.toLowerCase() !== handle.toLowerCase()) {
      const old = await getOAuthVerification(env.CACHE_KV, 'bluesky', previous.handle, state.pubkey)
      if (old?.account_id === did) await env.CACHE_KV.delete(oauthVerificationKey('bluesky', previous.handle, state.pubkey))
    }
  } catch (err) {
    console.warn('Bluesky sign-in: earlier handle record not removed:', err)
  }

  const checkedAt = Math.floor(Date.now() / 1000)

  // Store OAuth verification
  await storeOAuthVerification(env.CACHE_KV, {
    platform: 'bluesky',
    identity: handle,
    pubkey: state.pubkey,
    verified: true,
    method: 'oauth',
    checked_at: checkedAt,
    account_id: did,
    handle,
  })
  // Also index by DID so clients can verify either handle or DID identities.
  await storeOAuthVerification(env.CACHE_KV, {
    platform: 'bluesky',
    identity: did,
    pubkey: state.pubkey,
    verified: true,
    method: 'oauth',
    checked_at: checkedAt,
    account_id: did,
    handle,
  })

  return { success: true, returnUrl: state.returnUrl, identity: handle }
}

export function blueskyClientMetadata(baseUrl: string): object {
  return {
    client_id: `${baseUrl}/auth/bluesky/client-metadata.json`,
    client_name: 'Divine Identity Verification',
    client_uri: baseUrl,
    redirect_uris: [`${baseUrl}/auth/bluesky/callback`],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'atproto',
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  }
}
