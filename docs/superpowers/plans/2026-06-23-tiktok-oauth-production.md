# TikTok OAuth — Production Approval & Launch Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement the code tasks. Steps use checkbox (`- [ ]`) syntax for tracking. Note: several tasks here are **external** (TikTok developer portal, video recording, app review) and cannot be code-executed — they are owner-assigned checklists with explicit acceptance criteria.

**Goal:** Take the (already-working, sandbox-verified) TikTok OAuth verification flow from sandbox/target-users to a TikTok-approved production app, and declare the feature deployed.

**Architecture:** The OAuth handler (`src/oauth/tiktok.ts`) and routes (`src/routes/auth.ts`) are complete and proven end-to-end against the sandbox app. The remaining work is (a) one site change TikTok's review requires, (b) possible domain-verification plumbing, and (c) the TikTok production app submission/review lifecycle, then a credentials cutover.

**Tech Stack:** Cloudflare Workers, Hono, TypeScript, Vitest, Wrangler. TikTok Login Kit (OAuth 2.0 + PKCE).

## Global Constraints

- Worker host / `OAUTH_REDIRECT_BASE`: `https://verifier.divine.video` (exact).
- TikTok callback (must match byte-for-byte in app config): `https://verifier.divine.video/auth/tiktok/callback`.
- Scopes: `user.info.basic,user.info.profile` (comma-separated). `user.info.profile` unlocks `username`.
- Privacy Policy URL: `https://divine.video/privacy`. Terms URL: `https://divine.video/terms`. (Already set in the TikTok app config; must also be visible on the site.)
- App identity (in TikTok app config): name "Divine Verifier", Divine logo icon, description — already set in sandbox.
- Secrets are per-worker via `wrangler secret put`; single environment (no `[env]` blocks). Currently loaded with the **sandbox** key (`sbaw…`).
- Production linkage target (see memory `project_tiktok_account_target_linkage`): TikTok `@divine.video` → `divinehq.divine.video`, never the relay admin pubkey.
- No Co-Authored-By in commits. Feature branches target `main`.

---

### Task 1: Add visible Privacy Policy + Terms links to the site footer

TikTok review requires the Privacy Policy and Terms of Service to be visible on the site itself ("without menu navigation"), not just declared in app config. The current footer (`src/index.ts:2498`) links only to `divine.video`.

**Files:**
- Modify: `src/index.ts:2498-2500` (footer markup)
- Test: `src/index.test.ts`

**Interfaces:**
- Consumes: the default `worker.fetch(new Request('https://verifier.divine.video/'))` returns the landing HTML.
- Produces: served HTML at `/` contains anchors to `https://divine.video/privacy` and `https://divine.video/terms`.

- [ ] **Step 1: Write the failing test**

```typescript
// add to src/index.test.ts
describe('verifier footer', () => {
  it('exposes visible privacy and terms links (required for TikTok review)', async () => {
    const response = await worker.fetch(
      new Request('https://verifier.divine.video/'),
      {} as never,
    )
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('https://divine.video/privacy')
    expect(html).toContain('https://divine.video/terms')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.ts -t "privacy and terms"`
Expected: FAIL — `html` does not contain the privacy/terms URLs.

- [ ] **Step 3: Add the links to the footer**

```html
<footer>
  <p>Part of <a href="https://divine.video">divine.video</a>. Open source. Own what you make.</p>
  <p><a href="https://divine.video/privacy">Privacy Policy</a> &middot; <a href="https://divine.video/terms">Terms of Service</a></p>
</footer>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/index.test.ts -t "privacy and terms"`
Expected: PASS

- [ ] **Step 5: Full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat(verifier): add visible privacy + terms links for TikTok review"
```

---

### Task 2: Land PR #14 and bring `main` in sync with prod

PR #14 (`feat/tiktok-oauth-wireup`, the scope fix + tests) is currently a draft and prod is running the unmerged branch build. Task 1's footer commit should ride on the same branch so a single merge makes `main == prod`.

**Files:** none (process task).

- [ ] **Step 1:** Confirm Task 1's commit is on `feat/tiktok-oauth-wireup` and pushed (`git push`).
- [ ] **Step 2:** Self-review the PR diff one more time; mark PR #14 **ready for review** (`gh pr ready 14`).
- [ ] **Step 3:** After approval, merge to `main` (`gh pr merge 14 --squash` or per repo convention).
- [ ] **Step 4:** Deploy `main`: `npm run deploy`.
- [ ] **Step 5:** Log the deploy: `~/code/support-trust-safety/scripts/log-deploy.sh` (workspace convention).
- [ ] **Acceptance:** `git log origin/main -1` shows the merge; `curl https://verifier.divine.video/` shows the privacy/terms links live.

---

### Task 3: Create the Production app and import sandbox config (OWNER: Matt, TikTok portal)

**Files:** none (external — TikTok developer portal).

- [ ] **Step 1:** In the app, switch the environment selector from the sandbox to **Production**, creating a Production **Draft**.
- [ ] **Step 2:** Use "import configuration from sandbox" to carry over Login Kit, redirect URI, scopes, name, icon, description, and the privacy/terms URLs.
- [ ] **Step 3:** Verify the Production draft has, exactly:
  - Redirect URI `https://verifier.divine.video/auth/tiktok/callback`
  - Scopes `user.info.basic` + `user.info.profile`
  - Privacy `https://divine.video/privacy`, Terms `https://divine.video/terms`
  - Name "Divine Verifier", Divine logo, description present.
- [ ] **Acceptance:** Production draft saves without validation errors except (expected) the demo-video and review-submission requirements.

---

### Task 4: Domain verification for `verifier.divine.video` (OWNER: Matt + Claude, conditional)

The production app will likely require URL-property/domain verification (sandbox did not). The method TikTok offers determines who does what.

**Files (only if hosted-file challenge):**
- Create/modify: `src/routes/health.ts` or a new `src/routes/well-known.ts` route serving the exact verification file/string at the exact path TikTok specifies.
- Modify: `src/index.ts` (mount the route).

- [ ] **Step 1 (Matt):** In the Production app, start domain verification for `verifier.divine.video` and note the method offered:
  - **DNS TXT record** → Matt adds the TXT record in Cloudflare DNS for `divine.video`/`verifier`. No code.
  - **Hosted file at a path** (e.g. `/.well-known/tiktok-developers-site-verification.txt`) → Claude adds a worker route returning the exact contents.
  - **Meta tag** → Claude adds the meta tag to the `<head>` in `src/index.ts`.
- [ ] **Step 2 (Claude, if file/meta):** Implement the route/tag with the exact value, add a test asserting the path returns the expected body / the head contains the tag, commit, and deploy.
- [ ] **Step 3 (Matt):** Click "Verify" in the portal.
- [ ] **Acceptance:** TikTok portal shows `verifier.divine.video` as a verified property.

---

### Task 5: Record demo video(s) and write reviewer instructions (OWNER: Matt records, Claude drafts)

TikTok requires 1–5 videos (≤50 MB each) showing the complete end-to-end Login Kit flow **on `verifier.divine.video`** (the domain in the video must match the submitted URL). The flow requires a Nostr login, which reviewers won't have — so the video and written notes must make the flow self-evident.

**Files:** none in repo (assets live in the TikTok submission). Claude produces draft text.

- [ ] **Step 1 (Claude):** Draft **scope justification** text: why `user.info.basic` (display name) and `user.info.profile` (username) are needed — to confirm the user controls the TikTok account they assert in their NIP-39 decentralized-identity record on Nostr.
- [ ] **Step 2 (Claude):** Draft **reviewer instructions**: step-by-step from opening `verifier.divine.video`, logging in via login.divine.video (Matt's account is used for the recording), clicking connect-TikTok, authorizing, and the resulting verified link — including what data we request and that tokens are discarded.
- [ ] **Step 3 (Matt):** Record the screen capture of the full flow using his own account.
- [ ] **Acceptance:** Video(s) under 50 MB each, domain in frame is `verifier.divine.video`, flow shown start to finish; reviewer-notes text finalized.

---

### Task 6: Submit for review and iterate (OWNER: Matt, TikTok portal)

**Files:** none (external).

- [ ] **Step 1:** Attach demo video(s), scope justifications, and reviewer notes to the Production draft.
- [ ] **Step 2:** Submit for review.
- [ ] **Step 3:** On rejection, capture the stated reason, address it (most likely: domain mismatch, scope justification, or reviewer-couldn't-complete), and resubmit. Common fixes live in Tasks 4–5.
- [ ] **Acceptance:** TikTok marks the app **Approved** for production.

---

### Task 7: Production credentials cutover (OWNER: Matt + Claude)

**Files:** none (secrets only).

- [ ] **Step 1 (Matt):** From the approved Production app, copy the production client key + secret.
- [ ] **Step 2 (Matt):** Replace the sandbox secrets:
  ```bash
  cd ~/code/divine-identify-verification-service
  npx wrangler secret put TIKTOK_CLIENT_KEY
  npx wrangler secret put TIKTOK_CLIENT_SECRET
  ```
  (Secrets are hot — no redeploy needed.)
- [ ] **Step 3 (Claude):** Verify the live start endpoint now uses the production key (no `sbaw` prefix):
  ```bash
  curl -s -o /dev/null -D - "https://verifier.divine.video/auth/tiktok/start?pubkey=<64-hex>&return_url=https://verifier.divine.video/" | grep -i location
  ```
  Expected: `client_key=` is the production key, `scope=user.info.basic,user.info.profile`.
- [ ] **Step 4 (Matt):** Full round-trip test with a **normal, non-target-user** TikTok account → expect `oauth_verified=true&identity=<handle>`.
- [ ] **Acceptance:** A non-target-user account completes verification.

---

### Task 8: Link the brand account and declare deployed (OWNER: Matt + Claude)

**Files:** docs/CLAUDE.md updates as needed.

- [ ] **Step 1 (Matt):** Resolve `divinehq.divine.video` to its hex pubkey.
- [ ] **Step 2 (Matt):** Authenticated **as `divinehq.divine.video`**, run the TikTok OAuth flow so the binding is to divinehq's key (NOT the admin pubkey), then publish the NIP-39 `i` tag (`tiktok:divine.video`) signed by divinehq's key.
- [ ] **Step 3 (Claude):** Confirm via `/auth/tiktok/status?pubkey=<divinehq-hex>&identity=divine.video` → `verified:true`, and that the NIP-39 event is present on the relay.
- [ ] **Step 4 (Claude):** Update the memory `project_tiktok_account_target_linkage` to record the linkage as done; note the feature as shipped in the appropriate doc.
- [ ] **Step 5 (Matt):** Log the deploy and announce TikTok OAuth verification as available to all users.
- [ ] **Acceptance:** TikTok `@divine.video` is NIP-39-linked to `divinehq.divine.video`; feature declared deployed.

---

## Dependencies / open items
- `divine.video/privacy` and `divine.video/terms` must be live, reachable pages (confirmed as the URLs to use; verify they resolve before Task 6).
- Domain-verification method is unknown until Task 4 Step 1 reveals it.
- TikTok review turnaround is open-ended (days to weeks); Tasks 7–8 are gated on approval.
