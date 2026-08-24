# Divine Identity Verification Service

A Cloudflare Worker that verifies [NIP-39](https://github.com/nostr-protocol/nips/blob/master/39.md) external identity claims for Divine. It fetches proof URLs server-side and checks that the claimed npub is present, working around the CORS limits that stop the browser from verifying most platforms directly. When someone links a GitHub, Twitter/X, Bluesky, Mastodon, Telegram, Discord, YouTube, or TikTok account to their Nostr identity, this service confirms the link is real so Divine can show a verified badge instead of a bare click-through.

Divine is a decentralized short-form video app that revives Vine's six-second format on Nostr. Cross-platform verification is how a profile proves it's genuinely the person it claims to be — an open, portable alternative to platform-owned checkmarks.

## Features

- **Eight platforms** — GitHub, Twitter/X, Bluesky, Mastodon, Telegram, Discord, YouTube, and TikTok, verified through a single API.
- **Two verification methods** — a *proof post* containing the user's npub, or an *OAuth login* (Twitter/X, Bluesky, and YouTube) that skips posting entirely. TikTok uses proof posts while its production OAuth app is pending; existing OAuth results remain valid as a fallback.
- **Batch and single verification** — check up to 10 claims in one request, or verify a single claim over JSON or a shareable URL that returns HTML for browsers and JSON for API clients.
- **NIP-05 verification** — confirm that a NIP-05 identifier resolves to a given pubkey.
- **KV caching** — verified claims are cached for 24 hours, failures for 15 minutes, and upstream platform errors for 5 minutes.
- **Rate limiting** — per-IP (60/min), per-pubkey (20/min), and per-platform (30/min) windows guard the Worker and upstream APIs.
- **Interactive landing page** — a self-service verification UI served at `/`, with Nostr login (browser signer, login.divine.video, bunker, or Nostr Connect), Quick Connect OAuth, an advanced proof-post flow, a link manager, and a public lookup tool.
- **Embeddable** — a postMessage NIP-07 bridge lets the flow run inside a trusted Divine iframe using the host's existing signer, so no second login is required.
- **Stateless** — no database; state lives in Cloudflare KV, so the Worker scales horizontally.

## Architecture

The service is a single [Hono](https://hono.dev) app running on Cloudflare Workers (`src/index.ts`). Routes are split by concern under `src/routes/`:

- `POST /verify` — batch verification, up to 10 claims.
- `POST /verify/single` and `POST /api/verify` — single-claim verification (the `/api/verify` alias exists for divine-web compatibility).
- `GET /verify/:platform/*` — URL-based verification; returns HTML for browsers, JSON with `?format=json`.
- `GET /nip05/verify` — NIP-05 lookup.
- `GET /platforms` — list supported platforms (YouTube and TikTok appear conditionally).
- `GET /health` and `GET /api/health` — health checks.
- `/auth/*` — OAuth authorization and callbacks, Nostr login, Bluesky client metadata, OAuth status, and revoke.
- `GET /` — the interactive landing page (returns JSON when the client asks for it).

Each platform is a verifier in `src/platforms/` behind a shared interface, wired up in `registry.ts`; adding a platform is a matter of adding a verifier rather than reshaping the service. OAuth handlers live in `src/oauth/`, and shared helpers (caching, rate limiting, validation, npub encoding) live in `src/utils/`.

Verification is layered: the Worker checks the KV cache first, then any cached OAuth verification for OAuth-capable platforms, and finally fetches the proof from the platform. Bluesky verification also understands AT Protocol identity-link records (`video.divine.identity.link`) alongside proof posts. Results carry provenance describing how the link was confirmed.

The service backs Divine's identity and trust surface: divine-web and Divine mobile call it on demand to render verified badges, and the published verification is written into the user's own signed Nostr identity event (NIP-39), so the proof stays portable and owned by the user rather than by any single platform.

## Getting started

Requires Node.js and a Cloudflare account with [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

```bash
npm install       # install dependencies
npm run dev       # run the Worker locally with Wrangler
npm test          # run the Vitest suite (watch mode)
npm run test:once # run the tests once, for CI
```

## Configuration

Configuration lives in `wrangler.toml`.

**KV namespaces** (bound in `wrangler.toml`):

- `CACHE_KV` — verification result cache.
- `RATE_LIMIT_KV` — rate-limit counters.

**Vars:**

- `DISCORD_VERIFY_CHANNEL_ID` — the Discord channel used for message-based Discord verification.
- `TIKTOK_OAUTH_ENABLED` — set to `"true"` only after production OAuth credentials pass an end-to-end check; defaults to `"false"`.

**Secrets** (set with `wrangler secret put …`, never committed):

- `GITHUB_TOKEN` — optional, raises the GitHub API rate limit.
- `YOUTUBE_API_KEY` — enables YouTube verification (the platform is hidden when unset).
- `DISCORD_BOT_TOKEN` — enables message-based Discord verification.
- `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET` — Twitter/X OAuth 2.0 credentials.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Google OAuth 2.0 credentials, used for YouTube login.
- `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` — TikTok Login Kit credentials.
- `OAUTH_REDIRECT_BASE` — base URL for OAuth callbacks (for example `https://verifier.divine.video`), also used to validate return URLs against open redirects.

See `PRD.md` for the full API contract and request/response shapes.

## Deployment

```bash
npm run deploy    # wrangler deploy to Cloudflare
```

The Worker is named `divine-identity-verification-service` in `wrangler.toml`. Set the required secrets in the target environment before deploying.

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)
