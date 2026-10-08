# video.divine.identity.link v0

Status: Draft v0 (implementation profile)

## Goal

Provide a generic AT Protocol record for linking an AT identity to external protocol identities (Nostr first, but reusable for ActivityPub, Farcaster, and others).

This record is not Divine-exclusive in behavior. Any verifier can independently evaluate it from public data.

## Collection

- Collection: `video.divine.identity.link`
- Record type: `video.divine.identity.link`
- Key: `any` (the verifier reads these records but no longer writes them: its Bluesky sign-in asks only for the `atproto` scope, which can't create records)

## Record schema

```json
{
  "$type": "video.divine.identity.link",
  "version": 1,
  "target": {
    "protocol": "nostr",
    "id": "npub1...",
    "uri": "nostr:npub1..."
  },
  "proof": {
    "type": "oauth",
    "material": "atproto-oauth",
    "challenge": "optional",
    "createdAt": "2026-03-06T00:00:00.000Z"
  },
  "gateway": {
    "domain": "optional.example",
    "did": "optional-gateway-did"
  },
  "source": {
    "app": "divine-identify-verification-service"
  }
}
```

## Field requirements

- `$type`: required, exact string `video.divine.identity.link`
- `version`: required, integer `1`
- `target.protocol`: required, lowercase protocol id (e.g. `nostr`, `activitypub`, `farcaster`)
- `target.id`: required, protocol-native stable identifier
- `target.uri`: optional canonical URI for the target identity
- `proof.type`: required (`oauth`, `signature`, `profile_backlink`, `gateway_attestation`, or extension)
- `proof.material`: optional short descriptor or URI for proof context
- `proof.challenge`: optional challenge string
- `proof.createdAt`: required ISO-8601 timestamp
- `gateway`: optional provenance for bridge/gateway-produced links
- `source.app`: optional producer identifier

## Verification model

Verifiers should evaluate links using protocol-specific profiles.

### Nostr profile (v0)

A Nostr link passes when:

1. Record `$type` and `version` match this spec.
2. `target.protocol == "nostr"`.
3. `target.id` equals the expected `npub` (case-insensitive compare allowed for safety).
4. Optionally, if `target.uri` exists, it should normalize to `nostr:<target.id>`.

For stronger confidence, combine this with bilateral evidence (e.g. NIP-39 event pointing back to the AT URI).

## Provenance and gateway handling

`gateway` fields are informational attestation metadata and should not be treated as authority by default.

Recommended trust policy:

1. Prefer direct bilateral proofs.
2. Treat gateway attestations as additional evidence.
3. Maintain local trust config for known gateways (`trusted`, `observed`, `blocked`).
4. Include provenance in API responses so clients can apply their own policy.

## Backward compatibility

Legacy proof-post verification remains valid as fallback. Implementations should prefer identity-link records first, then fall back to legacy post-text checks.

## Versioning

- Backward-compatible additions: optional fields only.
- Breaking changes: bump `version` and publish a migration profile.
