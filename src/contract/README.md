# App contract suite

These tests pin what the Divine apps (mobile 1.0.24 to 1.0.26 and divine-web) read from this
service: field names, types, statuses and codes the clients branch on. They do not pin wording
the clients ignore. Any successor to this worker must pass the whole suite before
`verifier.divine.video` is moved to it.

To run the suite against another implementation, supply your own `ContractAdapter` (see `harness.ts`) in place of
`verifierAdapter`, which runs this Worker in process. The adapter holds the `ContractTarget`
(`(request, env) => Promise<Response>`), builds an environment whose platform `fetch` throws on any
unexpected call, and has three seeders (`seedSignIn`, `seedCachedVerified`, `exhaustRateLimit`). Seeding is the only
place internal storage layouts appear; the tests themselves touch no keys. Run just this suite with `npm run test:contract`.

| Client | Version | Calls |
|---|---|---|
| divine-mobile | 1.0.24 | `/verify`, `/verify/single`, `/platforms`, revoke; legacy `GET /auth/:platform/start` |
| divine-mobile | 1.0.25 | the above, with `POST /auth/:platform/start`, the return, and `POST /auth/confirm`; `/platforms` read for `label` and `supported` |
| divine-mobile | 1.0.26 | as 1.0.25, and `/platforms` `oauth` hides the sign-in button |
| divine-web | main | `POST /api/verify`, links to `GET /verify/:platform/:identity/:proof` |
