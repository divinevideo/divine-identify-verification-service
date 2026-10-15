# Divine Identity Verification Service

A Cloudflare Worker that verifies [NIP-39](https://github.com/nostr-protocol/nips/blob/master/39.md) external identity claims for Divine. It fetches proof URLs server-side and checks that the claimed npub is present, working around the CORS limits that stop the browser from verifying most platforms directly. When someone links a GitHub, Twitter/X, Bluesky, Mastodon, Telegram, Discord, YouTube, or TikTok account to their Nostr identity, this service confirms the link is real so Divine can show a verified badge instead of a bare click-through.

Divine is a decentralized short-form video app that revives Vine's six-second format on Nostr. Cross-platform verification is how a profile proves it's genuinely the person it claims to be — an open, portable alternative to platform-owned checkmarks.

## Features

- **Eight platforms** — GitHub, Twitter/X, Bluesky, Mastodon, Telegram, Discord, YouTube, and TikTok, verified through a single API.
- **Two verification methods**: a *proof post* containing the user's npub, or an *OAuth login* (Twitter/X, Bluesky, and YouTube) that skips posting entirely. A sign-in link counts once the Divine account owner confirms it (until confirmation is required, a finished sign-in also counts unconfirmed for 24 hours); a confirmed Bluesky sign-in stays verified for 30 days or until it is unlinked, as long as the handle still points to the same account. TikTok uses proof posts while its production OAuth app is pending; existing TikTok OAuth results stay valid for up to a day.
- **Batch and single verification** — check up to 10 claims in one request, or verify a single claim over JSON or a shareable URL that returns HTML for browsers and JSON for API clients.
- **NIP-05 verification** — confirm that a NIP-05 identifier resolves to a given pubkey.
- **KV caching** — verified claims are cached for 24 hours, failures for 15 minutes, and platform outages for 5 minutes (answered with the code `temporarily_unavailable`, meaning "try again", not a rejection).
- **Limits on platform requests** — each request to a platform gets 5 seconds, counted through the end of its answer, and at most 1 MB of an answer is read. A whole claim's check gets 8 seconds, so a batch waits at most that long on its slowest claim. A platform that doesn't answer in time is reported like any other outage (`temporarily_unavailable`).
- **Rate limiting** — per-IP (60/min), per-pubkey (20/min), and per-platform (30/min) windows guard the Worker and upstream APIs.
- **Interactive landing page** — a self-service verification UI served at `/`, with Nostr login (browser signer, login.divine.video, bunker, or Nostr Connect), Quick Connect OAuth, linking with a post, a Publish step, a link manager, and a public lookup tool.
- **Embeddable** — a postMessage NIP-07 bridge lets the flow run inside a trusted Divine iframe using the host's existing signer, so no second login is required.
- **Stateless** — no database; state lives in Cloudflare KV, so the Worker scales horizontally.

## Architecture

The service is a single [Hono](https://hono.dev) app running on Cloudflare Workers (`src/index.ts`). Routes are split by concern under `src/routes/`:

- `POST /verify` — batch verification, up to 10 claims.
- `POST /verify/single` and `POST /api/verify` — single-claim verification (the `/api/verify` alias exists for divine-web compatibility).
- `GET /verify/:platform/*` — URL-based verification; returns HTML for browsers, JSON with `?format=json`.
- `GET /nip05/verify` — NIP-05 lookup.
- `GET /platforms` — list platforms currently available to clients; deployment configuration controls YouTube and TikTok availability. Sign-in platforms also report an `oauth` field for whether sign-in is set up.
- `GET /health` and `GET /api/health` — health checks.
- `/auth/*`: sign-in start (`POST /auth/:platform/start`; `GET` for app versions that can't confirm), provider callbacks, `POST /auth/confirm`, Nostr login, Bluesky client metadata, sign-in status, and revoke.
- `GET /` — the interactive landing page (returns JSON when the client asks for it).

Each platform is a verifier in `src/platforms/` behind a shared interface, wired up in `registry.ts`; adding a platform is a matter of adding a verifier rather than reshaping the service. OAuth handlers live in `src/oauth/`, and shared helpers (caching, rate limiting, validation, npub encoding) live in `src/utils/`.

Verification is layered: the Worker checks any OAuth login record for OAuth-capable platforms first, then the KV cache, and finally fetches the proof from the platform. Bluesky verification also understands AT Protocol identity-link records (`video.divine.identity.link`) alongside proof posts. Results carry provenance describing how the link was confirmed.

The service backs Divine's identity and trust surface: divine-web and Divine mobile call it on demand to render verified badges, and the published verification is written into the user's own signed Nostr identity event (NIP-39), so the proof stays portable and owned by the user rather than by any single platform.

### Linking an account by signing in

1. The client keeps a random start secret: 32 random bytes written as 43 base64url characters. It sends a hash of it, the start check. Both hashes in this flow (the start check and the binding in step 3) are SHA-256 over the UTF-8 text shown, meaning the 43-character strings and not the raw bytes, written as base64url without padding.

   ```http
   POST /auth/bluesky/start
   Content-Type: application/json

   {"pubkey":"<64 hex>","return_url":"https://verifier.divine.video/?signin=<id>","handle":"alice.bsky.social","start_check":"<base64url(sha256('divine-signin-start:' + secret))>"}
   ```

   The answer is `{"url":"https://…"}`, the provider page to open.
2. After the provider, the verifier returns to `return_url` with `platform` and `identity` in the query, and a one-time code after the `#`: `#oauth_confirm=<code>`. The code is valid for 10 minutes.
3. The owner signs their linked-accounts list (kind 10011). The new claim's tag carries a fourth value, `base64url(sha256('divine-signin-confirm:' + code + ':' + start_check))`. The client sends:

   ```http
   POST /auth/confirm
   Content-Type: application/json

   {"code":"<code>","start_secret":"<secret>","event":{…signed kind 10011…}}
   ```

   The answer is `{"linked":true,"platform":"bluesky","identity":"alice.bsky.social"}`. The client then publishes the same event to relays. Errors carry a `code`:
   - `invalid_request` (400: a malformed `code` or `start_secret`);
   - `signin_not_found` (expired or not visible yet; retry briefly);
   - `signin_used`;
   - `signin_wrong_account`;
   - `signin_not_yours`;
   - `signin_claim_mismatch`;
   - `invalid_event`.

Return addresses are limited to `https://verifier.divine.video/`, `https://verifyer.divine.video/` and `https://divine.video/app/callback` (any query or fragment).

## Getting started

Requires Node.js and a Cloudflare account with [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

```bash
npm install       # install dependencies
npm run dev       # run the Worker locally with Wrangler
npm test          # run the Vitest suite (watch mode)
npm run test:once # run the tests once, for CI
```

The page's nostr-tools code is served from `public/vendor/nostr-tools.mjs`, which is built from the pinned `nostr-tools` version and committed. After changing that version, run `npm run build:vendor` and commit the result; CI and `npm run deploy` run `npm run check:vendor`, which fails if the file differs from a fresh build.

## Configuration

Configuration lives in `wrangler.toml`.

**KV namespaces** (bound in `wrangler.toml`):

- `CACHE_KV` — verification result cache.
- `RATE_LIMIT_KV` — rate-limit counters.

**Vars:**

- `DISCORD_VERIFY_CHANNEL_ID` — the Discord channel used for message-based Discord verification.
- `TIKTOK_OAUTH_ENABLED` — set to `"true"` only after production OAuth credentials pass an end-to-end check; defaults to `"false"`.
- `SIGNIN_CONFIRMATION`: `"optional"` (default): every finished sign-in also counts unconfirmed for 24 hours, so app versions that can't confirm keep working. `"required"`: only confirmed sign-ins count, and `GET /auth/:platform/start` is refused. Capitals and surrounding spaces are ignored. Any other value, empty included, is treated as `"required"` and logged as a warning. `GET /health` reports the mode in effect as `signin_confirmation`.
- `SIGNIN_CODE_PLACEMENT`: `"fragment"` (default) or `"query"`: where the one-time code goes in the return address. Either way, a return with a code keeps none of the fragment the return address carried.

**Secrets** (set with `wrangler secret put …`, never committed):

- `GITHUB_TOKEN` — optional, raises the GitHub API rate limit.
- `YOUTUBE_API_KEY` — enables YouTube verification (the platform is hidden when unset).
- `DISCORD_BOT_TOKEN` — enables message-based Discord verification.
- `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET` — Twitter/X OAuth 2.0 credentials. Twitter sign-in is offered only when both are set along with `OAUTH_REDIRECT_BASE`; Twitter proof posts work without them.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Google OAuth 2.0 credentials, used for YouTube login.
- `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` — TikTok Login Kit credentials.
- `OAUTH_REDIRECT_BASE`: base URL for OAuth callbacks (for example `https://verifier.divine.video`), also used to validate return URLs against open redirects. Its origin's `/` is also accepted as a return address, for staging and local development.

See `PRD.md` for the full API contract and request/response shapes.

## Deployment

```bash
npm run deploy    # wrangler deploy to Cloudflare
```

The Worker is named `divine-identity-verification-service` in `wrangler.toml`. Set the required secrets in the target environment before deploying.

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)
