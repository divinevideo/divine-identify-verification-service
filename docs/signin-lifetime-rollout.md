# Sign-in retention and rollout limits

This describes the behavior proposed in [PR #163](https://github.com/divinevideo/divine-identify-verification-service/pull/163), reviewed at c890f134da301384890e848f5dbafa714b1b9a6d. It is not a deployment record or acceptance of the retention exception.

## Retention decision still needed

[Issue #90](https://github.com/divinevideo/divine-identify-verification-service/issues/90) requires confirmation and working unlink support before links are kept indefinitely. Confirmation is implemented; [#76](https://github.com/divinevideo/divine-identify-verification-service/issues/76) remains open. A person using the verifier page with the Divine login cannot currently sign the request that removes the stored sign-in record.

Removing a link from the published profile can hide its badge in clients, but does not revoke the stored record. Direct handle verification can still succeed while the handle matches, or when Bluesky cannot answer. A DID claim can remain verified indefinitely, even after account deletion, because it is compared to the stored DID without contacting Bluesky.

A maintainer must decide whether working unlink support lands first or whether to accept those consequences explicitly. This document does not choose either outcome. Changing a closing reference or documenting the risk does not supply that decision.

## What an account check means

- A confirmed Bluesky record with an account ID has no age limit. Handle claims resolve the handle and compare its DID with the stored account ID. A successful lookup can be reused for one hour; a missing-handle answer for five minutes. An unavailable lookup preserves the match.
- DID claims only compare the claimed DID with the stored account ID. They do not check whether the account still exists.
- Confirmed records on X, YouTube and TikTok, and Bluesky records without an account ID, count for 30 days from `checked_at`. They are stored without an expiry even after they stop counting. Unconfirmed records keep their one-day storage and verification lifetime where confirmation is optional.
- The lifetime and account checks do not consult whether new sign-ins are enabled. Turning a platform's sign-in off does not revoke its existing records. X, YouTube and TikTok have no account re-check here, so a renamed or transferred handle can count for the remainder of the 30 days. Decide whether that is acceptable before enabling those sign-ins.

The implementation is in `src/oauth/signin-account.ts`, `src/oauth/signin-lifetime.ts`, `src/oauth/signin-records.ts`, and `src/oauth/state.ts`.

## Carrying old Bluesky records forward

Only confirmed Bluesky records with an account ID are carried forward. After an account check passes, the verification routes store the handle/DID pair again without an expiry, preserving the original sign-in time. The partner is written first and the claimed record last. A failed write is retried on a later verification while the record remains available.

`POST /verify`, `POST /verify/single`, its `POST /api/verify` alias, and `GET /verify/:platform/*` share this path. `GET /auth/:platform/status` applies the lifetime and account checks but does not carry records forward. A client that only polls status can therefore lose its old link when its original storage expiry arrives. Check client usage before relying on migration through verification traffic.

Re-reading before each write reduces races with unlink and replacement, but KV is eventually consistent. A stale read can still recreate a record that was just unlinked. Previously that record had a bounded storage expiry; a recreated record now has none and can remain until another successful unlink. Tests using immediate-consistency mocks cannot prove this race is closed.

A retained record whose handle now points elsewhere also returns `signin_account_changed` before the verifier reads a proof post. Without a storage expiry, that record can block proof-post verification indefinitely unless it is revoked or replaced by a new sign-in. This makes the missing unlink path consequential beyond whether a badge remains visible.

The PR describes the earliest old Bluesky expiries as around 2026-11-13 and targets deployment before about 2026-11-06. Those dates come from its rollout assessment, not from the lifetime code. Unchecked records still expire; they are not migrated in bulk. Removal of the transitional carry-forward and marker still needs a tracking issue and the repository's `TODO(#issue)` marker.

## Deployment and rollback

Merging is not proof of deployment. The CI workflow requires `PRODUCTION_CD_ENABLED=true` and a protected production environment before its deployment job can proceed. The repository variable was absent at review on 2026-11-03. A maintainer still needs to name an authorized deploy owner and confirm the actual deployed version; no owner is assigned by this note.

The PR reports that a throwaway-key experiment through Cloudflare's API removed an existing expiry when a key was rewritten without one. That is not a test through the Worker's KV binding. After an authorized deployment, check a synthetic legacy pair carried forward through the Worker: both keys should have no expiration in the KV listing. Then exercise unlink and check that both identities stop verifying. Keep real identities and keys out of public artifacts. No deployment or production experiment was performed for this documentation change.

Rolling back to the PR's base, 3f68df4a44a7e1df0c04b2247d020474f3338ce7, does not restore storage expiries. That version has no read-time age check, so confirmed X, YouTube or TikTok records written without an expiry can keep counting indefinitely after rollback. An authorized rollback needs a version that preserves the age check, or an explicit plan to retire those records. Merely turning new sign-ins off does not remove them.
