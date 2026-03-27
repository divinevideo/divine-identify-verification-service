# PRD: User-Initiated Verification Removal

## Status
- Owner: Divine Verifyer team
- Type: Product + implementation PRD
- Scope: `divine-identify-verification-service` (verifyer UI + worker API)
- Last updated: 2026-03-15

## Summary
Users can publish identity links to their Nostr profile today, but cannot remove a link from the Verifyer UI. This plan adds a first-class remove flow that:
- Removes selected `i` tags from the latest `kind:10011` identity event (NIP-39).
- Attempts OAuth cache revocation for OAuth-backed platforms.
- For Bluesky, attempts deletion of the `video.divine.identity.link` AT Protocol record created during OAuth.
- Preserves signer ownership checks and existing relay publish behavior.

## Prerequisites
### Publish and read flows must migrate to kind 10011
The verifier's `publishIdentityTagToNostr()` currently writes `i` tags into `kind:0` (profile metadata). NIP-39 specifies `kind:10011` for external identity claims, and divine-web already uses kind 10011 for both publish and removal.

This migration is included in this work (Slice 0). The changes:
- `publishIdentityTagToNostr()`: publish to kind 10011 instead of kind 0. Content is empty string (identity data lives entirely in `i` tags).
- `fetchProfile()`: rename to `fetchIdentityEvent()`, query `kinds: [10011]` instead of `kinds: [0]`.
- `doLookup()`: read `i` tags from both kind 10011 and kind 0, preferring kind 10011 when both exist. This ensures the lookup and manage UI shows all existing links regardless of when they were created.

No batch migration is needed. Users who linked accounts before the migration have `i` tags in kind 0. Those remain visible through the dual-read lookup. When a user next adds, removes, or re-verifies any link, that action publishes a kind 10011 event, which becomes authoritative. The old kind 0 `i` tags become inert (NIP-39-compliant clients read kind 10011).

### divine-web already supports removal
divine-web's `LinkedAccountsSettingsPage` already lets users remove identity claims from kind 10011 via `useRemoveIdentity()`. The verifier UI adds value beyond what divine-web provides in two ways:
1. OAuth cache revocation (divine-web has no path to clear verifyer's KV cache).
2. Accessibility for users who don't use divine-web (e.g., mobile-only users managing identities via the standalone verifyer tool).

## Current-State Inventory (Code-Aligned)
### Frontend (`src/index.ts`)
- Existing publish flow:
  - `publishIdentityTagToNostr()` loads current profile via `fetchProfile()`, replaces matching `i` tag, signs, and publishes through `publishEventToRelay()`.
  - Currently publishes to `kind:0`. Migrating to `kind:10011` in Slice 0.
- Existing signer/auth flow:
  - Browser signer login creates a NIP-98 event (`kind:27235`) in `connectBrowserSigner()` and sends it to `/auth/nostr/login`.
- Existing lookup flow:
  - `doLookup()` parses `kind:0` `i` tags for display/verification.
  - Migrating to read both `kind:10011` and `kind:0` in Slice 0.

### Backend (`src/routes/auth.ts`)
- Existing auth capability:
  - `POST /auth/nostr/login` validates NIP-98 event via `login.divine.video`.
- Existing OAuth capability:
  - `GET /auth/:platform/start`, callbacks, and `GET /auth/:platform/status`.
- Missing today:
  - No API to revoke cached OAuth verification entries.

### OAuth State Helpers (`src/oauth/state.ts`)
- Existing:
  - `oauthVerificationKey()`, `storeOAuthVerification()`, `getOAuthVerification()`.
- Missing today:
  - `deleteOAuthVerification()`.

### Bluesky Identity-Link Record (`src/identity-link.ts`, `src/oauth/bluesky.ts`)
- Existing:
  - Bluesky OAuth flow writes a `video.divine.identity.link` record to the user's AT Protocol repo via `com.atproto.repo.putRecord`.
  - Record key: `nostr-{npub}` (deterministic, one per Nostr identity).
  - Written as best-effort (failure doesn't block OAuth success).
- Missing today:
  - No `com.atproto.repo.deleteRecord` call to clean up the identity-link record on removal.

## Problem
- Users need a direct, non-technical unlink path.
- OAuth cache entries live for up to 24 hours, so unlinking only profile tags is insufficient for immediate de-verification.
- For Bluesky, the OAuth flow creates a persistent `video.divine.identity.link` record in the user's AT Protocol repo that is not cleaned up on unlink.

## Goals
1. Users can view linked verifications for the active account.
2. Users can remove a selected verification with confirmation.
3. Removal updates profile tags and attempts OAuth cache revoke.
4. Flow is idempotent, secure, and understandable.

## Non-Goals
- Deleting historical Nostr events.
- Deleting user-created proof content on external platforms (gists, tweets, posts).
- Changing identity standards beyond current NIP-39 `i` tags.

## UX Requirements
### Manage Section
- Add a new card under Verify Here: `Manage verified links`.
- Populate from current active pubkey identity event (`kind:10011`, `i` tags). Fall back to `kind:0` for profiles published before the migration.
- Columns:
  - Platform
  - Identity
  - Proof/reference
  - Action (`Remove`)

### Remove Confirmation
- Title: `Remove this verification?`
- Body: `This unlinks <platform:identity> from your Nostr profile.`
- Note: `Relay updates may take a short moment.`
- Buttons:
  - `Cancel`
  - `Remove verification` (destructive)

### States
- Loading: `Removing verification...`
- Success: `Verification removed from your Nostr profile.`
- Partial success: `Removed from profile, but OAuth cache revoke did not complete.`
- Error: actionable message (signer mismatch, relay failure, auth error).

## Functional Requirements
1. List linked verifications from current profile tags.
2. Remove all matching duplicates for selected `platform:identity`.
3. Preserve all non-target tags exactly.
4. Require active signer session and pubkey ownership match.
5. Publish new `kind:10011` event to existing relay set (`PROFILE_RELAYS`).
6. For OAuth platforms (`twitter`, `bluesky`, `youtube`, `tiktok`), attempt revoke after successful publish.
7. For Bluesky, attempt deletion of `video.divine.identity.link` AT Protocol record (best-effort, non-blocking).
7. Idempotency:
  - Missing target tag should still return success (`already removed` semantics).
  - Missing OAuth KV key should still return `revoked:true`.

## Technical Design
### Frontend Changes (`src/index.ts`)
Add manage-link UI and behavior to existing inline script:
- `loadLinkedVerificationsForActivePubkey()`
  - Reuse `getActivePubkey()` and `fetchProfile(relay, pubkey)`.
  - Parse `i` tags into normalized rows:
    - `platform` = part before first `:`
    - `identity` = remainder after first `:`
    - `proof` = `tag[2] || ''`
- `renderLinkedVerifications(rows)`
  - Render table/list and per-row remove button.
- `removeLinkedVerification(platform, identity)`
  - Validate signer and pubkey ownership exactly as publish flow does now.
  - Fetch latest profile.
  - Build `nextTags` by removing matching `i` tags:
    - `tag[0] === 'i'`
    - `tag[1].toLowerCase() === (platform + ':' + identity).toLowerCase()`
  - Sign and publish `kind:10011` via existing `publishEventToRelay()`.
  - If publish succeeds and platform is OAuth-capable, call `POST /auth/oauth/revoke`.
  - Refresh manage list.

Note: `loadLinkedVerificationsForActivePubkey()` should query both `kind:10011` and `kind:0` to find `i` tags. This covers profiles published before migration to kind 10011. Removal always publishes to kind 10011 only.

Add helper for authenticated backend calls:
- `buildNip98Event(url, method)` (extractable from existing logic in `connectBrowserSigner()`).
- Use signer to create event for `/auth/oauth/revoke` auth payload.

### Backend Changes (`src/routes/auth.ts`)
Add endpoint:
- `POST /auth/oauth/revoke`

Request body:
```json
{
  "platform": "bluesky",
  "identity": "alice.bsky.social",
  "pubkey": "64-char-hex",
  "event": { "kind": 27235, "...": "NIP-98 signed event" }
}
```

Behavior:
1. Validate JSON/body fields.
2. Validate platform is OAuth-supported.
3. Validate `pubkey` and normalize.
4. Verify `event` through same upstream trust path used by `/auth/nostr/login` (`login.divine.video`).
5. Ensure authenticated pubkey equals body pubkey.
6. Delete OAuth verification key from `CACHE_KV`.
7. For Bluesky: attempt `com.atproto.repo.deleteRecord` to remove the `video.divine.identity.link` record (rkey: `nostr-{npub}`). Requires stored OAuth token or re-auth. Best-effort; failure is non-blocking.
8. Return `200 { revoked: true, platform, identity, atproto_record_deleted: true|false }` (Bluesky) or `200 { revoked: true, platform, identity }` (other platforms).

Recommended refactor:
- Extract shared helper from `/auth/nostr/login` for login.divine.video verification to avoid duplicated event validation/fetch logic.

Error model:
- `400` invalid input
- `401` auth/pubkey mismatch
- `429` rate limit exceeded
- `502` upstream login verification unavailable
- `500` unexpected server error

### OAuth Helper Changes (`src/oauth/state.ts`)
Add:
- `deleteOAuthVerification(kv, platform, identity, pubkey): Promise<void>`
  - Use existing `oauthVerificationKey(...)` normalization behavior.
  - No-op success if key missing (idempotent).

## Security Requirements
- Do not trust client pubkey without verified signed event.
- Destructive actions require signer-authenticated request.
- Reuse existing rate-limit middleware pattern for revoke route.
- Avoid logging raw auth event payloads.

## Observability
Log structured events:
- `verification_remove_started`
- `verification_remove_published`
- `verification_remove_failed`
- `oauth_revoke_succeeded`
- `oauth_revoke_failed`

Track:
- Remove success rate
- Median remove latency
- Relay publish success ratio
- OAuth revoke failure ratio

## Implementation Slices
### Slice 0: Migrate to kind 10011
1. Rename `fetchProfile()` to `fetchIdentityEvent()`. Change query from `kinds: [0]` to `kinds: [10011]`.
2. Add `fetchProfileLegacy()` that queries `kind:0` and extracts `i` tags only.
3. Update `doLookup()` to call both, merge results (kind 10011 takes precedence if both exist for same pubkey).
4. Update `publishIdentityTagToNostr()` to publish `kind:10011` with empty content string.
5. Update UI copy: "kind 0 profile" references become "identity event" or similar.
6. Tests: verify publish emits kind 10011, verify lookup reads from both kinds, verify kind 10011 takes precedence.

### Slice 1: Backend revoke path
1. Add `deleteOAuthVerification()` in `src/oauth/state.ts`.
2. Add `POST /auth/oauth/revoke` in `src/routes/auth.ts`.
3. Refactor shared NIP-98 verification helper reused by `/auth/nostr/login` and revoke.
4. Add backend tests for revoke validation/auth/idempotency.

### Slice 2: Frontend manage/remove flow
1. Add manage card markup in Verify Here section.
2. Add linked-verification loader + renderer.
3. Add remove action with confirmation + status handling.
4. Add NIP-98 auth event helper for revoke API calls.
5. Integrate list refresh after remove attempts.

### Slice 3: Hardening and polish
1. Add retries or clearer UX for partial relay acceptance.
2. Add partial-success warning when revoke fails after publish success.
3. Validate mobile/desktop usability and error text quality.
4. Update docs and deployment notes.

## Test Plan
### Unit
- `oauthVerificationKey()` + `deleteOAuthVerification()` key behavior.
- Tag filtering removes only selected `platform:identity`.
- Frontend parser handles multi-colon identities and duplicate tags.

### Backend Route Tests
- `POST /auth/oauth/revoke` rejects invalid body/platform/pubkey.
- Rejects auth event mismatch.
- Returns `revoked:true` when key exists.
- Returns `revoked:true` when key is already absent.

### E2E
1. Login signer.
2. Publish a link.
3. Confirm link appears in new Manage section and lookup.
4. Remove link from Manage section.
5. Confirm link no longer appears in Manage section.
6. Confirm lookup no longer includes removed link.
7. Confirm OAuth fallback no longer verifies revoked OAuth identity.

## Acceptance Criteria
### Product
1. Users can see linked verifications for active pubkey in one screen.
2. Users can remove one verification with confirmation.
3. Clear loading/success/error messaging.

### Functional
1. Remove publishes a new `kind:10011` excluding target `i` tag(s).
2. Non-target tags and content remain unchanged.
3. Requires signer session and pubkey match.
4. Success requires at least one relay acceptance.
5. OAuth revoke attempted for OAuth platforms and idempotent.
6. Publish success + revoke failure produces partial-success warning.

### API
1. `POST /auth/oauth/revoke` validates inputs and platform.
2. Rejects mismatched or invalid auth events.
3. Returns `200 revoked:true` on delete or missing key.

### Quality
1. New tests pass.
2. Existing publish flow behavior remains intact.
3. No unhandled browser errors in remove flow.

## Risks and Mitigations
- Relay inconsistency:
  - Success UI notes propagation delay.
- Stale profile reads:
  - Always refetch latest profile before mutate+publish.
- Duplicate tags:
  - Remove all duplicates for selected key.
- Upstream auth outage:
  - Revoke failure is non-blocking if unlink publish succeeded.
- Bluesky AT Protocol record deletion:
  - Requires a valid OAuth token. If the user's token has expired or been revoked, the record persists in their AT repo. This is acceptable: the Nostr-side `i` tag removal is the authoritative unlink. The AT record is supplementary.
- Kind 0 / kind 10011 legacy data:
  - Users who published `i` tags via the verifier before the kind 10011 migration have tags in kind 0 only. The dual-read lookup (Slice 0) surfaces these. Any subsequent add/remove action publishes to kind 10011, effectively migrating that user. Stale kind 0 `i` tags are harmless (NIP-39-compliant clients ignore them).

## Rollout and Rollback
- Rollout:
  - Deploy backend revoke endpoint first, then frontend remove UI.
- Rollback:
  - UI can be hidden without affecting existing verify/publish flow.
  - Revoke endpoint removal does not affect current OAuth start/callback/status routes.

## Out of Scope Notes
- User-created proof content (gists, tweets, posts) remains visible on external platforms.
- Historical Nostr events remain discoverable but superseded by latest replaceable event.
- Migrating existing kind 0 `i` tags to kind 10011 (separate effort, see Prerequisites).
- divine-mobile NIP-39 support (no current implementation).
