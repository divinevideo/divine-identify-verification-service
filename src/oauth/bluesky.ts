import type { Bindings, OAuthState } from '../types'
import { generatePKCE, generateRandomString, generateDPoPKeyPair, importDPoPPrivateKey, createDPoPProof } from './crypto'
import { storeOAuthState, getOAuthState, deleteOAuthState, storeOAuthVerification } from './state'
import { buildNostrIdentityLinkRecord, DIVINE_IDENTITY_LINK_COLLECTION } from '../identity-link'
import { hexToNpub } from '../utils/npub'

type DidDocument = {
  alsoKnownAs?: string[]
  service?: Array<{ id?: string; serviceEndpoint?: string }>
}

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
  const didDoc = await resolveDidDocument(did)
  if (!didDoc) return null
  const pdsUrl = getPdsEndpoint(didDoc)
  if (!pdsUrl) return null

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

async function resolveDidDocument(did: string): Promise<DidDocument | null> {
  if (did.startsWith('did:plc:')) {
    const didResp = await fetch(`https://plc.directory/${did}`)
    if (!didResp.ok) return null
    try {
      return await didResp.json() as DidDocument
    } catch {
      return null
    }
  }

  if (did.startsWith('did:web:')) {
    const domain = decodeURIComponent(did.slice('did:web:'.length))
    // Block path traversal in did:web domains (e.g., did:web:evil.com%2F..%2Flocalhost)
    if (domain.includes('/') || domain.includes('\\')) return null
    const didWebUrl = `https://${domain}/.well-known/did.json`
    if (!isSafeUrl(didWebUrl)) return null
    const didResp = await fetch(didWebUrl)
    if (!didResp.ok) return null
    try {
      return await didResp.json() as DidDocument
    } catch {
      return null
    }
  }

  return null
}

function getPdsEndpoint(didDoc: DidDocument): string | null {
  const endpoint = didDoc.service?.find(s => s.id === '#atproto_pds')?.serviceEndpoint
  if (!endpoint || !isSafeUrl(endpoint)) return null
  return endpoint.replace(/\/+$/, '')
}

function getHandleFromDidDocument(didDoc: DidDocument): string | null {
  const atHandle = didDoc.alsoKnownAs?.find(a => a.startsWith('at://'))
  return atHandle ? atHandle.slice('at://'.length) : null
}

function linkRecordRkey(npub: string): string {
  // Deterministic key keeps one mutable record per user and proof type.
  return `nostr-${npub.toLowerCase()}`
}

async function postWithDpop(
  endpointUrl: string,
  accessToken: string,
  dpopPrivateJwk: JsonWebKey,
  dpopPublicJwk: JsonWebKey,
  body: unknown
): Promise<Response> {
  const privateKey = await importDPoPPrivateKey(dpopPrivateJwk)

  const attempt = async (tokenType: 'DPoP' | 'Bearer', nonce?: string) => {
    const proof = await createDPoPProof(privateKey, dpopPublicJwk, 'POST', endpointUrl, nonce)
    return fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `${tokenType} ${accessToken}`,
        'DPoP': proof,
      },
      body: JSON.stringify(body),
    })
  }

  let response = await attempt('DPoP')

  // Handle DPoP nonce challenge.
  const nonce = response.headers.get('DPoP-Nonce')
  if (nonce && response.status === 400) {
    response = await attempt('DPoP', nonce)
  }

  // Some servers still expect bearer for resource requests.
  if ((response.status === 401 || response.status === 403) && !response.ok) {
    response = await attempt('Bearer')
  }

  return response
}

async function writeNostrIdentityLinkRecord(
  did: string,
  pubkeyHex: string,
  accessToken: string,
  dpopPrivateJwk: JsonWebKey,
  dpopPublicJwk: JsonWebKey
): Promise<{ uri?: string; error?: string }> {
  const didDoc = await resolveDidDocument(did)
  if (!didDoc) return { error: 'Unable to resolve DID document' }

  const pdsEndpoint = getPdsEndpoint(didDoc)
  if (!pdsEndpoint) return { error: 'Unable to resolve ATProto PDS endpoint' }

  const npub = hexToNpub(pubkeyHex)
  const record = buildNostrIdentityLinkRecord(npub)
  const rkey = linkRecordRkey(npub)

  const response = await postWithDpop(
    `${pdsEndpoint}/xrpc/com.atproto.repo.putRecord`,
    accessToken,
    dpopPrivateJwk,
    dpopPublicJwk,
    {
      repo: did,
      collection: DIVINE_IDENTITY_LINK_COLLECTION,
      rkey,
      record,
      validate: false,
    }
  )

  if (!response.ok) {
    return { error: `Identity link write failed (${response.status})` }
  }

  try {
    const data = await response.json() as { uri?: string }
    return { uri: data.uri || `at://${did}/${DIVINE_IDENTITY_LINK_COLLECTION}/${rkey}` }
  } catch {
    return { uri: `at://${did}/${DIVINE_IDENTITY_LINK_COLLECTION}/${rkey}` }
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

async function processBlueskyToken(
  tokenResp: Response,
  state: OAuthState,
  env: Bindings,
): Promise<{ success: boolean; returnUrl: string; error?: string; identity?: string }> {
  let tokenData: { sub?: string; access_token?: string }
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
    const didDoc = await resolveDidDocument(did)
    if (didDoc) {
      const resolvedHandle = getHandleFromDidDocument(didDoc)
      if (resolvedHandle) handle = resolvedHandle
    }
  } catch {
    // Use DID as identity if handle resolution fails
  }

  // Best effort: persist a durable identity-link record in the user's AT repo.
  if (tokenData.access_token && state.dpopPrivateJwk && state.dpopPublicJwk) {
    const linkWrite = await writeNostrIdentityLinkRecord(
      did,
      state.pubkey,
      tokenData.access_token,
      state.dpopPrivateJwk,
      state.dpopPublicJwk
    )
    if (linkWrite.error) {
      console.warn('Bluesky identity-link write failed:', linkWrite.error)
    }
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
  })
  // Also index by DID so clients can verify either handle or DID identities.
  if (did !== handle) {
    await storeOAuthVerification(env.CACHE_KV, {
      platform: 'bluesky',
      identity: did,
      pubkey: state.pubkey,
      verified: true,
      method: 'oauth',
      checked_at: checkedAt,
    })
  }

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
