# divine-identity-verification-service

A lightweight Cloudflare Worker that verifies [NIP-39](https://github.com/nostr-protocol/nips/blob/master/39.md) external identity claims for the Divine ecosystem. It fetches proof URLs server-side and checks for the claimed npub, which works around the CORS limits that stop the browser from verifying most platforms directly.

Divine is a decentralized short-form video app reviving Vine's 6-second format, built on Nostr. When someone links a GitHub, Twitter, Mastodon, Telegram, Discord, Bluesky, YouTube, or TikTok account to their Nostr identity, this service confirms the link is real so the app can show a verified badge instead of a bare click-through.

## What it does

- Verifies NIP-39 identity claims across all supported platforms in a single request.
- Caches results in KV for sub-second responses on repeat checks.
- Runs stateless and horizontally scalable, with no database to manage.
- Adds new platforms through config rather than redeployment.
- Handles OAuth-based verification flows for platforms that need it.

## Endpoints

- `POST /verify` — verify one or more identity claims.
- `GET /platforms` — list supported platforms.
- `GET /nip05` — NIP-05 lookups.
- `GET /auth/*` — OAuth authorization and callback flows.
- `GET /health` — health check.

See `PRD.md` for the full API contract and request/response shapes.

## Development

```bash
npm install       # install dependencies
npm run dev       # run the Worker locally with Wrangler
npm test          # run the Vitest suite
npm run test:once # run tests in CI mode
npm run deploy    # deploy to Cloudflare
```

Configuration lives in `wrangler.toml`. Platform API keys and OAuth credentials are set through Wrangler secrets — never commit them.

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)
