# Production releases

The `CI` workflow tests every PR and main push. Only a successful **main** push
or an explicit **main** `workflow_dispatch` can reach production. Manual replay
uses the selected main commit, reruns all checks, and refuses it if main has
since advanced. No PR event can deploy.

## Prerequisites — complete before enabling

An authorized operator must configure these out of band. This change does not
create credentials, environments, resources, routes, or runtime secrets.

1. Verify account `c84e7a9bf7ed99cb41b8e73566568c75` owns the existing
   `divine-identity-verification-service` Worker and the custom domain
   `verifier.divine.video`. Verify `CACHE_KV` and `RATE_LIMIT_KV` against
   `wrangler.toml`, and retain existing runtime secrets. The release script
   rechecks the account, domain attachment, active deployment, and KV bindings.
2. Create or verify a GitHub environment named **production**, with required
   reviewers, restricted to main deployments. Choose the authorized approvers
   and prevent unapproved activation using the repository's environment policy.
   The readiness job refuses a missing environment or missing reviewer rule
   before the deployment job references it. Do not rely on GitHub's automatic
   creation of an unprotected environment.
3. Set environment variable `CLOUDFLARE_ACCOUNT_ID` to the verified account.
   Provide environment secret `CLOUDFLARE_API_TOKEN`: a token scoped only to
   that account, with **Workers Scripts: Edit** and **Workers KV Storage: Read**.
   Workers Scripts permission also allows domain inspection. Confirm the token can
   read versions, deployments, domain attachment and existing KV namespaces,
   and upload/activate versions. Do not grant zone/DNS edits, KV writes, or
   resource provisioning. This is a CI deployment credential, not a replacement
   for Worker runtime secrets; never copy OAuth/application secrets into GitHub.
4. After verifying these prerequisites and choosing the environment protections,
   set repository variable `PRODUCTION_CD_ENABLED=true`. Without this deliberate
   enablement, main's release-readiness job fails visibly and **does not deploy**.

The workflow's GitHub token has only `contents: read`, except the readiness job
also has `actions: read` to inspect environment protections. GitHub's environment
approval happens before the Cloudflare credential is made available. Pin
Wrangler in the lockfile and use `npm ci`; actions are pinned to commit SHAs.
Update those pins through reviewed changes.

## What a release changes

`npm run deploy:production` is CI-only; it rejects other repositories, PRs,
non-main refs, unexpected events, and a different account. It uses the checked
source SHA and locked Wrangler to upload a tagged version with this repository's
build hook and assets, then activates that exact version at 100%.

Version upload/activation intentionally replaces `wrangler deploy` in CD: it
does **not** update triggers, routes, domains, schedules, or provision resources.
It retains existing secrets and dashboard-only vars (`keep_vars=true`); explicit
vars in `wrangler.toml` remain authoritative. It does not enable new features or
fill in missing provider credentials. There are no database migrations in this
release. A future binding/schema migration must document compatibility and its
ordering before activation; do not use this flow to apply an incompatible one.

Production jobs share one non-cancelling lock. After acquiring it, and again
after upload, the script refuses an obsolete main SHA. It also refuses a gradual
rollout or an active version changed by an operator during upload. All other
deployment mechanisms must honor the same operational release exclusion; the
provider API has no compare-and-swap activation, so do not deploy manually in
parallel with CI.

Success requires the provider to report the uploaded version active at 100%,
with its source-SHA tag intact, followed by a read-only, uncached `GET /health`
returning the expected service and `status: ok`. It sends no identity verification,
OAuth, publication, or other side-effecting test traffic. This health response is
not itself source provenance; the provider version/tag supplies that evidence.

## Results and first controlled release

The run summary and `production-release-<run id>-<attempt>` artifact retain
`production-release.json` for 90 days: source SHA, provider version, prior
version, deployment ID, environment, timestamps, run/attempt, and success/failure.
A post-activation failure stays red and records the activated version; it never
silently rolls back. Inspect Cloudflare's current deployment before retrying.

Before calling CD operational, perform one authorized controlled main merge:
observe checks passing for its SHA, approve the production environment, verify
the artifact matches Cloudflare's active version/tag, and confirm `/health`.
Also exercise a failing check and a non-main manual dispatch: neither may reach
activation. Local tests and `wrangler versions upload --dry-run` do not establish
this production acceptance criterion. No production activation is performed as
part of local validation or PR publication.

## Rollback (operator-authorized, never automatic)

1. Stop/disable new CI activations and wait for any in-flight production job to
   finish. Record its run and the provider's active deployment before acting.
2. Select a previously verified version from a successful release artifact and
   inspect its bindings and compatibility. **Fix forward instead** if this would
   cross an incompatible browser-vendor change; see the README's asset-cache
   caveat. Versions do not restore KV data or external/provider state.
3. With existing authorized Cloudflare access, use the pinned CLI from a checked
   checkout: `npm exec -- wrangler versions deploy <known-good-version>@100% --yes --message "operator rollback"`.
   This activates an existing version; it does not undo routes or resources.
4. Read the active deployment/version again, run only the safe `/health` GET,
   and record the result and original source SHA in the incident/release record.
   Reconcile main with the fix before re-enabling CD; replaying an obsolete main
   run is deliberately refused.

Rolling back below #90 also affects stored Bluesky sign-in links (#90):

- Kept records stay stored with no expiry under the older code, and nothing in
  the older code ends them.
- The older age check stops counting any link confirmed more than 30 days
  earlier at once, so those owners see `signin_expired` until they sign in again.
- Retired records are not affected: the older code ignores `retired`, and their
  30-day expiry ends them.
- Records the older code saves during the rollback have a 30-day expiry and no
  `kept` mark. Rolling forward again means re-running the keep script below.

References: [Wrangler versions and deployments](https://developers.cloudflare.com/workers/wrangler/commands/workers/#versions),
[rollback limitations](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## Keeping existing Bluesky sign-in links (one time, #90)

Before #90, every confirmed sign-in link was stored for 30 days. After the #90
deploy, new confirmed Bluesky links saved with the account's DID are stored with
no expiry. `scripts/keep-bluesky-links.mjs` gives the links already stored the
same treatment: it re-puts each eligible record with no expiry and `kept: true`
added, and changes nothing else.

Run it only on Matt's go, right after the #90 deploy is live. It needs a
`CLOUDFLARE_API_TOKEN` with Workers KV Storage edit access.

1. Dry run: `node scripts/keep-bluesky-links.mjs`. It writes nothing and prints
   one JSON line of counts (`listed`, `expiring`, `eligible`, `kept`, `changed`,
   `skipped`). `kept` is 0 on a dry run.
2. Write: `node scripts/keep-bluesky-links.mjs --write` (optionally
   `--pace-ms N`, default 300, the pause between API calls).

3. Dry run again: `eligible` should be 0 and `expiring` should have dropped by
   the number kept in step 2. That confirms in production that the write cleared
   each expiry.

Running it again is safe: records already stored with no expiry are skipped. The
script reads each record again just before writing it, and skips one that
changed (counted in `changed`). That narrows, but does not close, a window in
which a link unlinked a moment earlier is written back: Cloudflare documents KV
as eventually consistent ("changes may take up to 60 seconds or more to be
visible", and "Negative lookups indicating that the key does not exist are also
cached") without saying whether REST API reads are fresher
([how KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)).
If a link was unlinked in the minute before the script reached it, it can come
back kept; unlinking it again removes it. Two paths can also leave a kept record
behind when an unlink is best effort (a read that is a stale or cached miss, and
a failed delete of the old-handle record after a handle change). Before #90 such
a leftover expired within 30 days; a kept one now stays until removed, and shows
only if its owner's profile names it again. If Cloudflare rate-limits the run, the
script stops with a message; run it again to continue. It prints counts only,
never key names, values or URLs.

Links stored more than 30 days before the deploy have already expired and can't
be kept; their owners link again. The script is transitional: remove it once it
has run in production (`TODO(#90)`).
