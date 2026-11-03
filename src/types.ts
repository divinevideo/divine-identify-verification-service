import type { VerificationMethod, VerificationProvenance } from './identity-link'

export type Bindings = {
  CACHE_KV: KVNamespace
  RATE_LIMIT_KV: KVNamespace
  GITHUB_TOKEN?: string
  // YouTube Data API v3 key — set via wrangler secret put YOUTUBE_API_KEY
  YOUTUBE_API_KEY?: string
  // Discord bot token — set via wrangler secret put DISCORD_BOT_TOKEN
  DISCORD_BOT_TOKEN?: string
  // Discord channel ID for verification messages (e.g. #verify channel in the Divine server)
  DISCORD_VERIFY_CHANNEL_ID?: string
  // OAuth — set via wrangler secret
  TWITTER_CLIENT_ID?: string
  TWITTER_CLIENT_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  TIKTOK_CLIENT_KEY?: string
  TIKTOK_CLIENT_SECRET?: string
  TIKTOK_OAUTH_ENABLED?: string
  // Base URL for OAuth callbacks (e.g., https://verifier.divine.video)
  OAUTH_REDIRECT_BASE?: string
  // "required" (what wrangler.toml sets, #113) counts only confirmed sign-ins.
  // Unset or "optional" counts unconfirmed sign-ins for a day; any other
  // value, empty included, is treated as "required".
  SIGNIN_CONFIRMATION?: string
  // "query" puts the sign-in's one-time code in the query instead of after the #.
  SIGNIN_CODE_PLACEMENT?: string
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
  // Bluesky: the account and handle the sign-in started with
  did?: string
  handle?: string
  // Hash of the start secret the client keeps (#113). Absent for a sign-in
  // started without one, which can never be confirmed.
  startCheck?: string
}

export interface OAuthVerification {
  platform: OAuthPlatform
  identity: string
  pubkey: string
  verified: true
  method: 'oauth'
  checked_at: number
  // The provider's permanent account ID: a Bluesky DID, an X user ID, a
  // YouTube channel ID or a TikTok open_id. Only Bluesky's handle is checked
  // against it so far.
  account_id?: string
  // The linked handle, so unlinking by handle or by DID removes both records.
  handle?: string
  // Set once the account owner confirmed the sign-in (#113). Records without
  // it stop counting when confirmation is required.
  confirmed?: true
  // The confirming event, so a later unlink can tell a newer list from an older one (#76).
  confirm_event_id?: string
  confirm_created_at?: number
}

export type Platform = 'github' | 'twitter' | 'mastodon' | 'telegram' | 'bluesky' | 'discord' | 'youtube' | 'tiktok'

export type VerificationCode =
  | 'discord_invalid_proof_format'
  | 'discord_dm_link'
  | 'discord_channel_link'
  | 'discord_invite_refused'
  | 'discord_not_configured'
  | 'discord_bot_no_access'
  | 'discord_message_not_found'
  | 'discord_api_error'
  | 'discord_author_mismatch'
  | 'discord_message_content_unavailable'
  | 'discord_npub_not_in_message'
  | 'temporarily_unavailable'
  | 'signin_expired'
  | 'signin_account_changed'

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
  /**
   * Stable machine-readable reason the claim isn't verified; see
   * PlatformVerifier.verify. `temporarily_unavailable` means it couldn't be
   * checked right now, not that it was rejected.
   */
  code?: VerificationCode
  method?: VerificationMethod
  provenance?: VerificationProvenance
  /** The proof to publish instead of the one sent: tidied, or resolved by the platform check (see PlatformVerifier.verify). */
  canonical_proof?: string
  /** The account to publish instead of the one sent: tidied, or named on the server that holds it (see PlatformVerifier.verify). */
  canonical_identity?: string
  checked_at: number
  cached: boolean
}

export interface CachedResult {
  verified: boolean
  error?: string
  /**
   * Stable machine-readable reason the claim isn't verified; see
   * PlatformVerifier.verify. `temporarily_unavailable` means it couldn't be
   * checked right now, not that it was rejected.
   */
  code?: VerificationCode
  method?: VerificationMethod
  provenance?: VerificationProvenance
  /** Only the platform check's own values; tidied values are worked out per request, never cached. */
  canonical_proof?: string
  canonical_identity?: string
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
  // Whether this deployment can check a proof post for this platform. Sign-in
  // is reported separately, by oauth, and does not affect this flag.
  supported: boolean
  // Whether sign-in (OAuth) is set up for this platform, matching what
  // /auth/:platform/start would do. Present only for the platforms that
  // offer a sign-in path (twitter, bluesky, youtube, tiktok).
  oauth?: boolean
}

export interface SignInCallbackResult {
  success: boolean
  returnUrl: string
  error?: string
  identity?: string
  // The one-time code the owner confirms with, for a sign-in started with a start check.
  confirmCode?: string
}
