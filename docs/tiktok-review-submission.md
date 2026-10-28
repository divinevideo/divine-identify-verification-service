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
Divine Verifier lets a person prove they own external social accounts (TikTok, plus GitHub, Bluesky, and others) and attach those proofs to their decentralized Divine / Nostr identity. For TikTok, the user signs in with TikTok Login Kit and we read their username. The user then publishes a signed "verified link" to their profile, so others can confirm the account is really theirs. The link counts only once the user publishes it. We do not post to TikTok and we do not retain TikTok tokens.

### How to test the TikTok integration
1. Open `https://verifier.divine.video/?tiktok_oauth_review=1` in a web browser. This review URL enables TikTok Quick Connect for one hour so it remains available through the sign-in redirects, while the public picker stays hidden from production users. The review setting is remembered only on the address it was turned on, so open the review page on this exact address rather than an alias domain.
2. The verifier first requires a Divine (Nostr) sign-in so the verified link can be published to a profile. **[Matt: decide one — provide a throwaway test Divine account here, OR state "this prerequisite sign-in is shown in the attached demo video."]**
3. Scroll to "Verify Here". In Step 1, press **Sign in with Divine login** (or **Use a Nostr extension**) and complete the sign-in. Use the same browser for every step that follows, not a private window, and don't clear site data: the page remembers the sign-in in that browser.
4. In Step 2, in the **Quick Connect** card ("Sign in, no posting"), choose **TikTok** under Platform and press **Continue to secure sign-in**. No posting is required.
5. TikTok's consent screen appears, requesting basic profile access and username. Approve it.
6. You are returned to the verifier page. It says "Signed in to TikTok as" followed by your TikTok username, then "Publish to link it to your Divine account." and scrolls down to the **Publish to my profile** button in Step 3.
7. In Step 3, press **Publish to my profile** within 10 minutes of being returned from TikTok. If your signer asks you to approve a signature, approve it. This step confirms that the person who signed in to TikTok is the owner of the Divine account; the link does not count until it is done.
8. The page reports how many relays it published to and says "Your Nostr profile link is now updated." To see the link, press **Load my links** under "Manage verified links"; the TikTok account is listed. If it isn't listed right away, wait a few seconds and press **Load my links** again.

The complete end-to-end flow is shown in the attached demo video, recorded on `https://verifier.divine.video`.

### Data we access
- `user.info.basic` — to authenticate the TikTok sign-in.
- `user.info.profile` — to read the @username, which is the verified identifier.

Read-only. No posting. Access and refresh tokens are discarded after the one-time verification.

---

## Open items before submitting
- [ ] Decide on reviewer access for step 2: throwaway test Divine account vs "see demo video." A test account materially lowers rejection risk, since reviewers often try the flow themselves.
- [ ] Record the demo video on `https://verifier.divine.video` (domain must match the submitted URL). It must show the Publish step (step 7), since the link does not count without it.
- [ ] Confirm the production app has BOTH scopes enabled (plan Task 7, Step 2b).
- [ ] Keep `TIKTOK_OAUTH_ENABLED` set to `"false"` until the approved production credentials pass the Task 7 end-to-end check.
