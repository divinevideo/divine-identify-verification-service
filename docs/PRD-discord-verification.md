# PRD: Discord Identity Verification for NIP-39

## Overview

Add Discord as a supported platform for NIP-39 identity verification across the Divine ecosystem. Users will prove they own a Discord account by creating a Discord server whose name or description contains their Nostr public key (npub), then linking a permanent invite code as the proof.

## Problem

Divine users are active on Discord but cannot link their Discord identity to their Nostr profile. Discord is the only major social platform used by our community that lacks NIP-39 support. Users want to show their Discord presence alongside GitHub, Twitter, Bluesky, and other linked accounts.

## Why Discord is Different

Unlike other platforms where users post a message containing their npub, Discord's API does not allow unauthenticated access to message content. However, Discord's **Invite API** (`GET /api/v10/invites/{code}`) is fully public and returns guild (server) metadata — including the server name and description — without any authentication.

This is the same approach used by [Keyoxide](https://docs.keyoxide.org/service-providers/discord/), the most widely adopted decentralized identity verification system.

## User Flow

### Linking a Discord Account

1. User navigates to **Settings > Linked Accounts** in divine-web
2. Selects **Discord** from the platform dropdown
3. Enters their **Discord username** (e.g. `alice`)
4. Sees instructions:
   > **Step 1: Create a proof server**
   >
   > Create a new Discord server (or use one you own). Set the server **name** or **description** to the verification text below. Then create a **permanent invite link** (set to never expire).
5. Copies the verification text: `Verifying that I control the following Nostr public key: "npub1abc..."`
6. Enters the **invite code** (e.g. `AbCdEf` from `discord.gg/AbCdEf`)
7. Clicks **Link Account**
8. System auto-verifies via the verifyer service and shows result

### Verification (Server-Side)

```
POST /api/verify
{
  "platform": "discord",
  "identity": "alice",
  "proof": "AbCdEf",
  "pubkey": "aabbccdd..."
}
```

The verifyer service:

1. Calls `GET https://discord.com/api/v10/invites/{proof}`
2. Extracts `guild.name` and `guild.description` from the response
3. Converts the hex pubkey to npub bech32
4. Checks if either field contains the npub
5. Returns `{ verified: true }` or `{ verified: false, error: "..." }`

## NIP-39 Tag Format

```json
["i", "discord:alice", "AbCdEf"]
```

- **Platform**: `discord`
- **Identity**: Discord username (new-style, no discriminator)
- **Proof**: Discord invite code (the part after `discord.gg/`)

## Technical Specification

### Verifyer Service Changes

#### New File: `src/platforms/discord.ts`

```typescript
import type { PlatformVerifier } from './base'

interface DiscordInviteResponse {
  guild?: {
    id: string
    name: string
    description: string | null
  }
  code: string
  expires_at: string | null
}

export class DiscordVerifier implements PlatformVerifier {
  readonly name = 'discord'
  readonly label = 'Discord'

  async verify(
    identity: string,
    proof: string,
    npub: string,
  ): Promise<{ verified: boolean; error?: string }> {
    // Validate invite code format (alphanumeric, hyphens)
    if (!/^[a-zA-Z0-9-]+$/.test(proof)) {
      return { verified: false, error: 'Invalid invite code format' }
    }

    const url = `https://discord.com/api/v10/invites/${encodeURIComponent(proof)}`

    let response: Response
    try {
      response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      })
    } catch {
      return { verified: false, error: 'Failed to fetch Discord invite' }
    }

    if (response.status === 404) {
      return { verified: false, error: 'Invite not found or expired' }
    }

    if (!response.ok) {
      return { verified: false, error: `Discord API error: ${response.status}` }
    }

    const data: DiscordInviteResponse = await response.json()

    if (!data.guild) {
      return { verified: false, error: 'Invite does not point to a server' }
    }

    // Check if invite has expired
    if (data.expires_at) {
      const expiresAt = new Date(data.expires_at)
      if (expiresAt < new Date()) {
        return { verified: false, error: 'Invite has expired — create a permanent invite' }
      }
    }

    // Search guild name and description for npub
    const searchText = [
      data.guild.name ?? '',
      data.guild.description ?? '',
    ].join(' ')

    if (searchText.includes(npub)) {
      return { verified: true }
    }

    return {
      verified: false,
      error: 'npub not found in server name or description',
    }
  }
}
```

#### Update: `src/platforms/registry.ts`

Add `'discord'` case to the `getVerifier` switch statement:

```typescript
case 'discord': return new DiscordVerifier()
```

#### Update: `src/types.ts`

Add `'discord'` to the `Platform` union type.

#### New File: `src/platforms/discord.test.ts`

Test cases:

| Case | Scenario | Expected |
|------|----------|----------|
| Happy path | Guild name contains npub | `{ verified: true }` |
| Description match | Guild description contains npub | `{ verified: true }` |
| Not found | Invite 404 | `{ verified: false, error: 'Invite not found or expired' }` |
| No guild | Invite to group DM (no guild) | `{ verified: false, error: 'Invite does not point to a server' }` |
| Expired | `expires_at` is in the past | `{ verified: false, error: 'Invite has expired...' }` |
| No npub | Guild exists but no npub in name/desc | `{ verified: false, error: 'npub not found...' }` |
| Invalid code | Special characters in proof | `{ verified: false, error: 'Invalid invite code format' }` |
| Network error | Fetch timeout | `{ verified: false, error: 'Failed to fetch Discord invite' }` |

### Client Changes (divine-web)

#### `src/hooks/useExternalIdentities.ts`

Add Discord to `PLATFORM_CONFIG`:

```typescript
discord: {
  label: 'Discord',
  profileUrl: (id) => `https://discord.com/users/${id}`,
  proofUrl: (_id, proof) => `https://discord.gg/${proof}`,
  verificationText: (npub) => [
    `Verifying that I control the following Nostr public key: "${npub}"`,
  ],
  canVerifyInBrowser: false,
},
```

#### `src/pages/LinkedAccountsSettingsPage.tsx`

Add Discord entries to:

- `PLATFORM_ICONS` — Discord icon (SVG)
- `PROOF_PLACEHOLDERS` — `'Invite code (e.g. AbCdEf from discord.gg/AbCdEf)'`
- `IDENTITY_PLACEHOLDERS` — `'Discord username'`
- `PROOF_INSTRUCTIONS` — Instructions to create a server, set the name/description, create permanent invite

## Discord Invite API Reference

### Endpoint

```
GET https://discord.com/api/v10/invites/{code}
```

### Auth Required

None.

### Response (relevant fields)

```json
{
  "code": "AbCdEf",
  "expires_at": null,
  "guild": {
    "id": "123456789",
    "name": "Verifying that I control the following Nostr public key: \"npub1abc...\"",
    "description": "Optional longer description with npub"
  }
}
```

### Rate Limits

Discord's public API has rate limits. The invite endpoint allows roughly **50 requests per second** per IP. Our per-pubkey rate limit (20/min) keeps us well under this.

### Failure Modes

| HTTP Status | Meaning |
|---|---|
| 200 | Success |
| 404 | Invite doesn't exist or was revoked |
| 429 | Rate limited (includes `Retry-After` header) |
| 5xx | Discord outage |

## Edge Cases & Considerations

### Server Name Length

Discord server names are limited to **100 characters**. An npub is 63 characters, plus the verification prefix. The full verification text `Verifying that I control the following Nostr public key: "npub1..."` is ~130 characters — too long for the name alone.

**Solutions (in priority order):**
1. Use the server **description** (up to 300 characters for Community servers)
2. Use a shorter name format: just the npub (e.g. `npub1abc...xyz`)
3. Check **both** name and description for the npub (not the full sentence)

**Recommendation:** Search for just the npub string (63 chars) in both name and description. The instructions should suggest putting it in the description for Community servers, or using the npub alone as the server name. The verification text shown to copy should be the full sentence, but verification only needs to find the npub substring.

### Community vs Non-Community Servers

- **Non-Community servers**: Have a name (100 chars) but no description field in the API response (`description: null`)
- **Community servers**: Have both name (100 chars) and description (300 chars)

Users who don't enable Community features must put the npub in the server **name**. The instructions should mention this.

### Invite Expiration

Users must create **permanent** (never-expiring) invites. The verifyer should check `expires_at` and warn if the invite will expire. An expired invite means the proof is no longer verifiable.

### Server Deletion

If a user deletes the proof server, their verification becomes invalid. The cache TTL (24h verified, 15min failed) handles this naturally — re-verification will fail after cache expiry.

### Identity Validation

Discord usernames:
- 2-32 characters
- Lowercase alphanumeric, periods, underscores
- No consecutive periods
- Cannot start/end with period

The verifyer does **not** validate that the Discord username matches the server owner, because the invite API doesn't expose the server owner's username. The proof is that the user *controls* a server with their npub in it — similar to how GitHub gist verification checks gist ownership.

**Note:** Unlike other platforms, we cannot verify the invite creator matches the claimed identity. The trust model is: "I control a Discord server that publicly claims this npub." This is the same trust model Keyoxide uses.

## Scope

### In Scope

- Discord platform handler in verifyer service
- Discord platform config in divine-web client
- Discord icon, placeholders, and instructions in the settings UI
- Unit tests for the Discord verifier
- Caching and rate limiting (existing infrastructure)

### Out of Scope

- Discord OAuth verification (could be added later)
- Discord bot for message-based verification
- Verifying Discord username matches server owner
- Discord Rich Presence or Activity integration

## Rollout

1. **Phase 1**: Deploy verifyer service with Discord handler
2. **Phase 2**: Deploy divine-web with Discord in platform list
3. Both can be developed in parallel; the client gracefully handles unsupported platforms (falls back to "Check proof" link)

## Success Metrics

- Number of users linking Discord accounts
- Discord verification success rate (compared to other platforms)
- Support tickets related to Discord linking flow
