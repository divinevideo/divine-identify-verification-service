function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function base64urlEncode(str: string): string {
  return base64url(new TextEncoder().encode(str))
}

export function generateRandomString(length: number): string {
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  return base64url(array)
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = generateRandomString(32)
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = base64url(new Uint8Array(hash))
  return { verifier, challenge }
}

export async function generateDPoPKeyPair(): Promise<{
  privateKey: CryptoKey
  publicJwk: JsonWebKey
  privateJwk: JsonWebKey
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as JsonWebKey
  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey) as JsonWebKey
  return { privateKey: keyPair.privateKey, publicJwk, privateJwk }
}

export async function importDPoPPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )
}

export async function createDPoPProof(
  privateKey: CryptoKey,
  publicJwk: JsonWebKey,
  method: string,
  url: string,
  nonce?: string,
  accessToken?: string,
): Promise<string> {
  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
  }

  const payload: Record<string, unknown> = {
    jti: generateRandomString(16),
    htm: method,
    htu: url,
    iat: Math.floor(Date.now() / 1000),
  }

  if (nonce) payload.nonce = nonce
  if (accessToken) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken))
    payload.ath = base64url(new Uint8Array(hash))
  }

  const headerB64 = base64urlEncode(JSON.stringify(header))
  const payloadB64 = base64urlEncode(JSON.stringify(payload))
  const signingInput = `${headerB64}.${payloadB64}`

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput)
  )

  const signatureB64 = base64url(new Uint8Array(signature))
  return `${headerB64}.${payloadB64}.${signatureB64}`
}
