# TikTok App Review — Submission Collateral

Copy-paste-ready text for the TikTok developer portal when submitting the production app for review (see plan Task 6 in `docs/superpowers/plans/2026-06-23-tiktok-oauth-production.md`). This is **not** code or config; it goes into TikTok's portal fields.

**Config recap (for cross-checking against the portal):**
- App name: Divine Verifier
- Redirect URI: `https://verifier.divine.video/auth/tiktok/callback`
- Scopes: `user.info.basic`, `user.info.profile`
- Privacy: `https://divine.video/privacy` · Terms: `https://divine.video/terms`

---

## 1. Scope justification

Paste into each scope's usage/justification field when requesting scopes for the production app.

### `user.info.basic`
Required by Login Kit to authenticate the user and confirm that the person completing the flow controls the TikTok account. We use it solely to establish a successful, user-consented sign-in. Divine Verifier does not post content and takes no action on the user's behalf.

### `user.info.profile`
We read the account's **username** (the public @handle) to create a "verified link." Divine Verifier lets a person prove they own an external account and records a cryptographically signed identity tag (NIP-39, of the form `tiktok:<username>`) on their decentralized Nostr profile, so others can confirm the account is genuinely theirs. The username is the identifier we display and publish; without `user.info.profile` we cannot read it and the verification cannot be completed. Access is read-only, we do not post to TikTok, and we do not store TikTok access or refresh tokens (they are discarded immediately after the one-time username read).

---

## 2. Reviewer instructions

Paste into the review-notes / description field of the submission. The attached demo video shows the same flow end to end.

### What Divine Verifier does
Divine Verifier lets a person prove they own external social accounts (TikTok, plus GitHub, Bluesky, and others) and attach those proofs to their decentralized Divine / Nostr identity. For TikTok, the user signs in with TikTok Login Kit; we read their username and record a signed "verified link" on their profile so others can confirm the account is really theirs. We do not post to TikTok and we do not retain TikTok tokens.

### How to test the TikTok integration
1. Open `https://verifier.divine.video/?tiktok_oauth_review=1` in a web browser. This review URL exposes TikTok Quick Connect while the public picker remains hidden from production users.
2. The verifier first requires a Divine (Nostr) sign-in so the verified link can be published to a profile. **[Matt: decide one — provide a throwaway test Divine account here, OR state "this prerequisite sign-in is shown in the attached demo video."]**
3. Scroll to "Verify Here" and complete the Nostr sign-in.
4. Choose **TikTok** and use **Quick Connect** (sign in with TikTok). No posting is required.
5. TikTok's consent screen appears, requesting basic profile access and username. Approve it.
6. You are returned to the verifier, which shows the TikTok account as verified (the @username is displayed and can be published to the Nostr profile).

The complete end-to-end flow is shown in the attached demo video, recorded on `https://verifier.divine.video`.

### Data we access
- `user.info.basic` — to authenticate the TikTok sign-in.
- `user.info.profile` — to read the @username, which is the verified identifier.

Read-only. No posting. Access and refresh tokens are discarded after the one-time verification.

---

## Open items before submitting
- [ ] Decide on reviewer access for step 2: throwaway test Divine account vs "see demo video." A test account materially lowers rejection risk, since reviewers often try the flow themselves.
- [ ] Record the demo video on `https://verifier.divine.video` (domain must match the submitted URL).
- [ ] Confirm the production app has BOTH scopes enabled (plan Task 7, Step 2b).
- [ ] Keep `TIKTOK_OAUTH_ENABLED` set to `"false"` until the approved production credentials pass the Task 7 end-to-end check.
