export type Bindings = {
  CACHE_KV: KVNamespace
  RATE_LIMIT_KV: KVNamespace
  GITHUB_TOKEN?: string
  // YouTube Data API v3 key — set via wrangler secret put YOUTUBE_API_KEY
  YOUTUBE_API_KEY?: string
  // OAuth — set via wrangler secret
  TWITTER_CLIENT_ID?: string
  TWITTER_CLIENT_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  TIKTOK_CLIENT_KEY?: string
  TIKTOK_CLIENT_SECRET?: string
  // Base URL for OAuth callbacks (e.g., https://verify.divine.video)
  OAUTH_REDIRECT_BASE?: string
}

export type OAuthPlatform = 'twitter' | 'bluesky' | 'youtube' | 'tiktok'

export interface OAuthState {
  platform: OAuthPlatform
  pubkey: string
  codeVerifier: string
  returnUrl: string
  createdAt: number
  // Bluesky-specific: DPoP keypair (exported JWK) and authorization server
  dpopPrivateJwk?: JsonWebKey
  dpopPublicJwk?: JsonWebKey
  issuer?: string
  tokenEndpoint?: string
}

export interface OAuthVerification {
  platform: OAuthPlatform
  identity: string
  pubkey: string
  verified: true
  method: 'oauth'
  checked_at: number
}

export type Platform = 'github' | 'twitter' | 'mastodon' | 'telegram' | 'bluesky' | 'discord' | 'youtube' | 'tiktok'

export interface VerifyClaim {
  pubkey: string
  platform: Platform
  identity: string
  proof: string
}

export interface VerifyResult {
  platform: Platform
  identity: string
  verified: boolean
  error?: string
  checked_at: number
  cached: boolean
}

export interface CachedResult {
  verified: boolean
  error?: string
  checked_at: number
  type: 'verified' | 'failed' | 'platform_error'
}

export interface Nip05VerifyResult {
  name: string
  domain: string
  pubkey: string
  verified: boolean
  error?: string
  checked_at: number
  cached: boolean
}

export interface PlatformInfo {
  label: string
  supported: boolean
}
