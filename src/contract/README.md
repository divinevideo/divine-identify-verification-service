# App contract suite

These tests pin what the Divine apps (mobile 1.0.24 to 1.0.27 and divine-web) read from this
service: field names, types, statuses and codes the clients branch on. They do not pin wording
the clients ignore. Any successor to this worker must pass the whole suite before
`verifier.divine.video` is moved to it. Run just this suite with `npm run test:contract`.

| Client | Version | Calls |
|---|---|---|
| divine-mobile | 1.0.24 | `/verify`, `/verify/single`, `/platforms`, revoke; legacy `GET /auth/:platform/start` |
| divine-mobile | 1.0.25 | the above, with `POST /auth/:platform/start`, the return, and `POST /auth/confirm`; `/platforms` read for `label` and `supported` |
| divine-mobile | 1.0.26 | as 1.0.25, and `/platforms` `oauth` hides the sign-in button |
| divine-mobile | 1.0.27 | reads this service as 1.0.26 does |
| divine-mobile | #10726 (open PR, unreleased) | as 1.0.27, and reads `code` `signin_expired` and `signin_account_changed` from the verify endpoints and `signin_expires_after_days` from `/platforms` |
| divine-web | main | `POST /api/verify`, links to `GET /verify/:platform/:identity/:proof` |
| outside callers of the old host's `/verified` | following the `verify.divine.video` redirect | `GET /verified/<pubkey>`, `GET /verified?platform=&identity=` |
| verifier page | this repo | revoke with the signed list (T4.4) |

Any client may also revoke with the NIP-98 event in the `Authorization` header (T4.5).

## Running it against another implementation

The suite picks its target in one place: `adapter.ts`. Write a `ContractAdapter` (see
`harness.ts`) for the successor and export it from `adapter.ts` in place of `verifierAdapter`.
Every test file and `signin-driver.ts` import the adapter from there.

`verifier-adapter.ts` is the only file that imports this Worker or knows its storage keys. The
other files depend only on `harness.ts`, `adapter.ts`, `signin-driver.ts`, Vitest and the
`@noble/curves` and `@scure/base` packages, so they can be copied as they are.

An adapter has:

- `target`: `(request, env) => Promise<Response>`.
- `env(config)`: a fresh environment for one test. It must also replace global `fetch` with one
  that throws (`failEveryFetch()` in `harness.ts`), so a platform request a test did not stub
  fails loudly.
- Three seeders, the only place internal storage appears:
  - `seedSignIn`: a confirmed sign-in that answers its claim as verified.
  - `seedCachedVerified`: a verified result from an earlier proof check.
  - `exhaustRateLimit`: makes the `pubkey`, `platform` or `ip` limit read as spent for an id.

### What the target must allow

**It runs in this process.** The tests stub platforms with `vi.stubGlobal('fetch', ...)`, so the
target's outgoing requests must go through this realm's global `fetch`. The suite cannot run
against `wrangler dev` or a deployed URL.

**It reads relays through global `fetch`.** `/verified` reads people's lists from relays by
calling `fetch` with `Upgrade: websocket`, as the Workers runtime allows. `fakeRelays` in
`harness.ts` stubs that call and serves each listed relay's events, so the target must make the
upgrade through this realm's global `fetch` too.

**It reads these requests as this worker does.** Requests go to `https://verifier.divine.video/...`.
The client IP arrives in the `cf-connecting-ip` header. One 1.0.24 test sends
`sec-fetch-mode: navigate` to stand for a browser navigation.

**It honors these configuration names**, or its adapter translates them (`ContractConfig` in
`harness.ts`). Setting a name to `undefined` means "not configured".

- `OAUTH_REDIRECT_BASE`, `SIGNIN_CONFIRMATION`, `SIGNIN_CODE_PLACEMENT`
- `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `YOUTUBE_API_KEY`
- `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_OAUTH_ENABLED`
- `DISCORD_BOT_TOKEN`

`SIGNIN_SETUPS` in `signin-driver.ts` lists the configurations that turn each sign-in on and off.

**It calls these provider URLs, and reads these answers.** The stubs answer only these, and any
other request throws. Where a proof check's request throws, the tests expect the answer
`temporarily_unavailable`.

- Twitter:
  - Start returns a provider `url` whose query carries `state`.
  - `POST https://api.twitter.com/2/oauth2/token` answers `{ access_token }`.
  - `GET https://api.twitter.com/2/users/me...` answers `{ data: { id, username } }`.
- Bluesky:
  - `...com.atproto.identity.resolveHandle?handle=...` (any host) answers `{ did }`.
  - `https://plc.directory/<did>` answers a DID document with `alsoKnownAs: ["at://<handle>"]` and
    a `#atproto_pds` service.
  - `<pds>/.well-known/oauth-protected-resource` answers `{ authorization_servers: [<issuer>] }`.
  - `<issuer>/.well-known/oauth-authorization-server` answers the authorization, token and PAR
    endpoints.
  - The PAR request's `URLSearchParams` body carries `state`; it answers `{ request_uri }`.
  - The token endpoint answers `{ sub: <did>, access_token }`. The callback carries `code`,
    `state` and `iss`.
- YouTube and TikTok: start makes no provider request.
- Discord: `GET https://discord.com/api/v10/channels/<channel>/messages/<message>` answers 403,
  404 with a JSON `code`, or 200 with `{ author: { username }, content }`.
- Proof checks for other platforms (GitHub in these tests): every request answers 404 `{}`, or
  throws to stand for an outage.
