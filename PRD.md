Divine Identity Verification Service                                                                                                                                                                                                    
                                                                  
  Overview                                                                                                                                                                                                                                     
                                                                  
  A lightweight, standalone microservice that verifies NIP-39 external identity claims by fetching proof URLs server-side and checking for npub presence. Solves the CORS limitation that prevents browser-based verification for most         
  platforms.                                                                                                                                                                                                                                   

  Problem

  Divine-web can only auto-verify GitHub identity claims in-browser (GitHub API is CORS-friendly). Twitter, Mastodon, Telegram, and future platforms all block browser fetches. Users currently see "Proof linked" with a manual click-through
  link instead of a verified/unverified badge.

  Goals

  - Verify NIP-39 identity claims for all supported platforms
  - Sub-second response times for cached verifications
  - Stateless, horizontally scalable
  - Simple API that divine-web calls on-demand
  - Extensible to new platforms without redeployment (config-driven)

  ---
  API Design

  POST /verify

  Verify one or more identity claims in a single request.

  Request:
  {
    "claims": [
      {
        "pubkey": "abc123...hex",
        "platform": "twitter",
        "identity": "jack",
        "proof": "1234567890"
      },
      {
        "pubkey": "abc123...hex",
        "platform": "mastodon",
        "identity": "mastodon.social/@alice",
        "proof": "109876543210"
      }
    ]
  }

  Response:
  {
    "results": [
      {
        "platform": "twitter",
        "identity": "jack",
        "verified": true,
        "checked_at": 1709500000,
        "cached": true
      },
      {
        "platform": "mastodon",
        "identity": "mastodon.social/@alice",
        "verified": false,
        "error": "npub not found in proof content",
        "checked_at": 1709500000,
        "cached": false
      }
    ]
  }

  GET /verify/:platform/:identity/:proof?pubkey=<hex>

  Single-claim convenience endpoint. Same response shape as one item from the batch response.

  GET /platforms

  Returns supported platforms and their configuration (for client feature detection).

  {
    "platforms": {
      "github": { "label": "GitHub", "supported": true },
      "twitter": { "label": "Twitter / X", "supported": true },
      "mastodon": { "label": "Mastodon", "supported": true },
      "telegram": { "label": "Telegram", "supported": true },
      "bluesky": { "label": "Bluesky", "supported": true }
    }
  }

  GET /health

  Standard health check.

  ---
  Verification Logic Per Platform

  ┌───────────┬──────────────────────────────────────────────────┬──────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────┐
  │ Platform  │                Proof URL Pattern                 │                     Fetch Method                     │                   Verification Check                    │
  ├───────────┼──────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ GitHub    │ https://api.github.com/gists/{proof}             │ JSON API                                             │ Check gist file content contains npub                   │
  ├───────────┼──────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ Twitter/X │ https://x.com/{identity}/status/{proof}          │ HTML scrape or nitter/API                            │ Page/API content contains npub (with quotes per NIP-39) │
  ├───────────┼──────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ Mastodon  │ https://{instance}/@{user}/{proof}               │ ActivityPub JSON (Accept: application/activity+json) │ content field contains npub (with quotes per NIP-39)    │
  ├───────────┼──────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ Telegram  │ https://t.me/{proof}                             │ HTML scrape (?embed=1 widget)                        │ Page content contains npub                              │
  ├───────────┼──────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ Bluesky   │ https://bsky.app/profile/{identity}/post/{proof} │ AT Protocol API (public.api.bsky.app)                │ Post text contains npub                                 │
  └───────────┴──────────────────────────────────────────────────┴──────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────┘

  NIP-39 verification text formats:
  - GitHub: Verifying that I control the following Nostr public key: <npub>
  - Twitter: Verifying my account on nostr My Public Key: "<npub>" (quoted)
  - Mastodon: Verifying that I control the following Nostr public key: "<npub>" (quoted)
  - Telegram: Verifying that I control the following Nostr public key: <npub> (no quotes)

  The service should check for the npub string anywhere in the proof content as a fallback, since some users may use slightly different phrasing.

  ---
  Caching

  ┌───────────────────────────────────┬────────────┬──────────────────────────────────┐
  │               Layer               │    TTL     │             Purpose              │
  ├───────────────────────────────────┼────────────┼──────────────────────────────────┤
  │ Verified claims                   │ 24 hours   │ Proofs rarely change once set    │
  ├───────────────────────────────────┼────────────┼──────────────────────────────────┤
  │ Failed claims                     │ 15 minutes │ Allow retries after fixing proof │
  ├───────────────────────────────────┼────────────┼──────────────────────────────────┤
  │ Platform errors (rate limit, 5xx) │ 5 minutes  │ Back off on platform issues      │
  └───────────────────────────────────┴────────────┴──────────────────────────────────┘

  Cache key: {platform}:{identity}:{proof}:{pubkey_prefix_8chars}

  Storage: Redis or in-memory (service is stateless — cache is optimization, not requirement). Can start with in-memory and add Redis when scaling.

  ---
  Rate Limiting

  ┌──────────────┬────────────────────────────┬──────────────────────────────┐
  │    Limit     │           Value            │            Scope             │
  ├──────────────┼────────────────────────────┼──────────────────────────────┤
  │ Per IP       │ 60 requests/minute         │ Prevent abuse                │
  ├──────────────┼────────────────────────────┼──────────────────────────────┤
  │ Per pubkey   │ 20 verifications/minute    │ Prevent enumeration          │
  ├──────────────┼────────────────────────────┼──────────────────────────────┤
  │ Per platform │ 30 outbound fetches/minute │ Respect upstream rate limits │
  ├──────────────┼────────────────────────────┼──────────────────────────────┤
  │ Batch size   │ 10 claims max per POST     │ Bound single request cost    │
  └──────────────┴────────────────────────────┴──────────────────────────────┘

  Platform-specific upstream limits to respect:
  - GitHub API: 60 req/hr unauthenticated, 5000/hr with token
  - Mastodon ActivityPub: varies per instance, typically generous
  - Twitter: scraping is fragile; consider nitter instances or paid API
  - Telegram embed widget: no documented limit but be conservative

  ---
  Platform Fetch Strategies

  GitHub — Most reliable. Use API with optional auth token for higher rate limits.

  Twitter/X — Hardest platform. Options in priority order:
  1. Twitter API v2 with Bearer token (requires developer account, $100/mo basic tier)
  2. Syndication API: https://syndication.twitter.com/srv/timeline-profile/screen-name/{user} (free, may break)
  3. Nitter instances as proxy (unreliable, instances go down)
  4. Direct HTML scrape with headless rendering (heavy, last resort)

  Recommendation: Start with syndication API, fall back to marking as "unable to verify" rather than failing silently. Add Twitter API v2 when budget allows.

  Mastodon — Reliable via ActivityPub. Fetch with Accept: application/activity+json header to get structured JSON. Each instance is independent so rate limits are per-instance.

  Telegram — Use embed widget (?embed=1) which returns lightweight HTML. Parse for npub in message text.

  Bluesky — Use public AT Protocol API at public.api.bsky.app. No auth required for public posts. Very reliable.

  ---
  Architecture

  divine-web (browser)
      │
      ▼
  Verification Service (stateless)
      │
      ├── Cache layer (Redis / in-memory)
      │
      ├── Platform adapters
      │   ├── GitHubAdapter    → api.github.com
      │   ├── TwitterAdapter   → syndication API / nitter
      │   ├── MastodonAdapter  → ActivityPub JSON
      │   ├── TelegramAdapter  → t.me embed widget
      │   └── BlueskyAdapter   → public.api.bsky.app
      │
      └── Rate limiter (per-IP, per-pubkey, per-platform)

  Deployment options (pick one):
  - Cloud Run (scales to zero, pay-per-request)
  - Fly.io (simple, cheap, persistent Redis add-on)
  - Cloudflare Worker (if keeping logic simple, KV for cache)

  Recommendation: Cloud Run — consistent with existing Divine infra, scales to zero when idle, easy Redis Memorystore attachment later.

  ---
  divine-web Integration

  Update useExternalIdentities.ts:

  // Current: only GitHub auto-verifies
  // New: all platforms go through verification service

  async function verifyIdentityClaim(identity, pubkey) {
    const response = await fetch(`${VERIFY_SERVICE_URL}/verify`, {
      method: 'POST',
      body: JSON.stringify({
        claims: [{ pubkey, platform: identity.platform,
                   identity: identity.identity, proof: identity.proof }]
      })
    });
    const { results } = await response.json();
    return { verified: results[0].verified, error: results[0].error };
  }

  Update LinkedAccounts.tsx: Remove the canVerifyInBrowser branching — all platforms now show the same verified/unverified badge UX.

  ---
  Non-Goals (v1)

  - Proactive crawling — Only verify on-demand, not scan all kind 10011 events
  - Storing results in Nostr — No publishing verification attestation events
  - OAuth flows — No "connect your Twitter account" UX; NIP-39 is proof-based
  - Content moderation — Just check npub presence, don't evaluate proof quality
  - Webhook/push notifications — Polling/on-demand only

  Future Considerations (v2)

  - Funnelcake integration: Funnelcake could call the verification service when indexing kind 10011 events and cache results alongside user profiles, eliminating the need for divine-web to call the service directly
  - Verification attestation events: Service could publish kind 30039 (or similar) events attesting to verification results, letting other clients consume them
  - More platforms: Reddit, Discord, LinkedIn, personal websites (via .well-known), DNS TXT records
  - Batch pre-verification: When loading a feed with many authors, batch-verify all their identities in one call
  - Admin dashboard: Monitor verification success rates, platform health, cache hit ratios

  ---
  Success Metrics

  - Verification latency: < 500ms for cached, < 3s for uncached
  - Cache hit rate: > 80% after warm-up
  - Platform success rate: > 95% for GitHub/Mastodon/Bluesky, > 80% for Twitter/Telegram
  - Uptime: 99.5% (non-critical path — divine-web gracefully degrades to "Proof linked" if service is down)
