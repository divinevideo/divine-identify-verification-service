# Verification Removal + Kind 10011 Migration — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users unlink external identity verifications from the verifyer UI, and align the service with NIP-39 kind 10011.

**Architecture:** The verifier's frontend (`src/index.ts`) handles Nostr relay communication (fetch, sign, publish) in inline JS. The backend (`src/routes/auth.ts`) handles OAuth flows and will gain a revoke endpoint. OAuth state lives in Cloudflare KV (`CACHE_KV`). All identity data is stored as `i` tags in Nostr replaceable events.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, Vitest with `@cloudflare/vitest-pool-workers`, WebSocket (Nostr relay protocol)

**Spec:** `docs/verification-removal-plan.md`

**PR:** https://github.com/divinevideo/divine-identify-verification-service/pull/4

**Security note:** The existing codebase uses `innerHTML` for rendering in the inline frontend. New rendering code follows the same pattern but uses `escapeHtml()` (already present in the codebase) for all user-supplied values. All data rendered in the manage table (platform names, identities, proofs) comes from the user's own signed Nostr events, not from untrusted third parties.

---

## Chunk 1: Kind 10011 Migration + Backend Revoke

### Task 1: `deleteOAuthVerification` helper

**Files:**
- Modify: `src/oauth/state.ts` (add function after line 51)
- Test: `src/oauth/state.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

Create `src/oauth/state.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { oauthVerificationKey, deleteOAuthVerification, storeOAuthVerification, getOAuthVerification } from './state'

// Minimal KV mock for Workers pool
function createMockKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
  } as unknown as KVNamespace
}

describe('oauthVerificationKey', () => {
  it('normalizes identity to lowercase', () => {
    const key = oauthVerificationKey('twitter', 'AliceJones', 'aabb')
    expect(key).toBe('oauth_verified:twitter:alicejones:aabb')
  })
})

describe('deleteOAuthVerification', () => {
  let kv: KVNamespace

  beforeEach(() => {
    kv = createMockKV()
  })

  it('deletes an existing verification entry', async () => {
    await storeOAuthVerification(kv, {
      platform: 'twitter',
      identity: 'alice',
      pubkey: 'aabb',
      verified: true,
      method: 'oauth',
      checked_at: Date.now(),
    })
    const before = await getOAuthVerification(kv, 'twitter', 'alice', 'aabb')
    expect(before).not.toBeNull()

    await deleteOAuthVerification(kv, 'twitter', 'alice', 'aabb')

    const after = await getOAuthVerification(kv, 'twitter', 'alice', 'aabb')
    expect(after).toBeNull()
  })

  it('succeeds silently when key does not exist (idempotent)', async () => {
    await deleteOAuthVerification(kv, 'bluesky', 'nobody', 'ccdd')
    const result = await getOAuthVerification(kv, 'bluesky', 'nobody', 'ccdd')
    expect(result).toBeNull()
  })

  it('normalizes identity case for deletion', async () => {
    await storeOAuthVerification(kv, {
      platform: 'bluesky',
      identity: 'Alice.Bsky.Social',
      pubkey: 'eeff',
      verified: true,
      method: 'oauth',
      checked_at: Date.now(),
    })

    await deleteOAuthVerification(kv, 'bluesky', 'alice.bsky.social', 'eeff')

    const after = await getOAuthVerification(kv, 'bluesky', 'Alice.Bsky.Social', 'eeff')
    expect(after).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run src/oauth/state.test.ts`
Expected: FAIL — `deleteOAuthVerification` is not exported

- [ ] **Step 3: Implement `deleteOAuthVerification`**

Add to end of `src/oauth/state.ts`:

```typescript
export async function deleteOAuthVerification(
  kv: KVNamespace,
  platform: string,
  identity: string,
  pubkey: string
): Promise<void> {
  const key = oauthVerificationKey(platform, identity, pubkey)
  await kv.delete(key)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run src/oauth/state.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/code/divine-identify-verification-service
git add src/oauth/state.ts src/oauth/state.test.ts
git commit -m "feat: add deleteOAuthVerification helper with tests"
```

---

### Task 2: `POST /auth/oauth/revoke` endpoint

**Files:**
- Modify: `src/routes/auth.ts` (add route, update import)
- Test: `src/routes/auth.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

Create `src/routes/auth.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import app from '../index'
import type { Bindings } from '../types'

function createMockKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
  } as unknown as KVNamespace
}

function createTestEnv(): Bindings {
  return {
    CACHE_KV: createMockKV(),
    RATE_LIMIT_KV: createMockKV(),
  }
}

function buildNip98Event(pubkey: string) {
  return {
    id: 'a'.repeat(64),
    pubkey,
    sig: 'b'.repeat(128),
    kind: 27235,
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
    content: '',
  }
}

describe('POST /auth/oauth/revoke', () => {
  const testPubkey = 'aa'.repeat(32)

  it('rejects missing body fields', async () => {
    const env = createTestEnv()
    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env)
    expect(res.status).toBe(400)
  })

  it('rejects unsupported platform', async () => {
    const env = createTestEnv()
    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'github',
        identity: 'user',
        pubkey: testPubkey,
        event: buildNip98Event(testPubkey),
      }),
    }, env)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toMatch(/OAuth/)
  })

  it('rejects invalid pubkey', async () => {
    const env = createTestEnv()
    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'twitter',
        identity: 'user',
        pubkey: 'not-a-pubkey',
        event: buildNip98Event('not-a-pubkey'),
      }),
    }, env)
    expect(res.status).toBe(400)
  })

  it('rejects pubkey mismatch between body and event', async () => {
    const env = createTestEnv()
    const otherPubkey = 'cc'.repeat(32)
    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'twitter',
        identity: 'user',
        pubkey: testPubkey,
        event: buildNip98Event(otherPubkey),
      }),
    }, env)
    expect(res.status).toBe(401)
  })

  it('returns revoked:true and deletes KV entry', async () => {
    const env = createTestEnv()
    const key = `oauth_verified:twitter:alice:${testPubkey}`
    await env.CACHE_KV.put(key, JSON.stringify({ verified: true }))

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pubkey: testPubkey }),
    }))

    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'twitter',
        identity: 'alice',
        pubkey: testPubkey,
        event: buildNip98Event(testPubkey),
      }),
    }, env)
    expect(res.status).toBe(200)
    const data = await res.json() as { revoked: boolean; platform: string; identity: string }
    expect(data.revoked).toBe(true)
    expect(data.platform).toBe('twitter')
    expect(data.identity).toBe('alice')

    const after = await env.CACHE_KV.get(key)
    expect(after).toBeNull()

    vi.restoreAllMocks()
  })

  it('returns revoked:true even when KV entry already absent (idempotent)', async () => {
    const env = createTestEnv()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pubkey: testPubkey }),
    }))

    const res = await app.request('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'bluesky',
        identity: 'alice.bsky.social',
        pubkey: testPubkey,
        event: buildNip98Event(testPubkey),
      }),
    }, env)
    expect(res.status).toBe(200)
    const data = await res.json() as { revoked: boolean }
    expect(data.revoked).toBe(true)

    vi.restoreAllMocks()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run src/routes/auth.test.ts`
Expected: FAIL — route returns 404

- [ ] **Step 3: Implement the revoke endpoint**

In `src/routes/auth.ts`:

Update import (line 6):
```typescript
import { getOAuthVerification, deleteOAuthVerification } from '../oauth/state'
```

Add before `export default auth`:

```typescript
const OAUTH_PLATFORMS = new Set(['twitter', 'bluesky', 'youtube', 'tiktok'])

auth.post('/oauth/revoke', async (c) => {
  const clientIp = c.req.header('cf-connecting-ip') || 'unknown'
  const ipLimit = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.ip, clientIp)
  if (!ipLimit.allowed) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }

  let body: { platform?: string; identity?: string; pubkey?: string; event?: Record<string, unknown> }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const { platform, identity, pubkey, event } = body
  if (!platform || !identity || !pubkey || !event) {
    return c.json({ error: 'Missing required fields: platform, identity, pubkey, event' }, 400)
  }
  if (!OAUTH_PLATFORMS.has(platform)) {
    return c.json({ error: `OAuth revoke only supported for: ${[...OAUTH_PLATFORMS].join(', ')}` }, 400)
  }
  if (!isValidHexPubkey(pubkey)) {
    return c.json({ error: 'Invalid pubkey (64-char hex required)' }, 400)
  }
  if (typeof event.pubkey !== 'string' || event.kind !== 27235) {
    return c.json({ error: 'Invalid NIP-98 event' }, 400)
  }

  const normalizedBodyPubkey = normalizePubkey(pubkey)
  const eventPubkey = typeof event.pubkey === 'string' ? normalizePubkey(event.pubkey) : ''
  if (normalizedBodyPubkey !== eventPubkey) {
    return c.json({ error: 'Pubkey mismatch: body pubkey does not match event pubkey' }, 401)
  }

  const encodedEvent = btoa(JSON.stringify(event))
  let upstreamResp: Response
  try {
    upstreamResp = await fetch(`${DIVINE_LOGIN_BASE}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Authorization': `Nostr ${encodedEvent}`,
        'Content-Type': 'application/json',
        'Origin': 'https://divine.video',
      },
      body: '{}',
    })
  } catch {
    return c.json({ error: 'Failed to reach login.divine.video' }, 502)
  }

  if (!upstreamResp.ok) {
    return c.json({ error: 'NIP-98 verification failed' }, 401)
  }

  await deleteOAuthVerification(c.env.CACHE_KV, platform, identity, normalizedBodyPubkey)

  return c.json({ revoked: true, platform, identity })
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run src/routes/auth.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Run full test suite**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run`
Expected: All existing tests still pass

- [ ] **Step 6: Commit**

```bash
cd ~/code/divine-identify-verification-service
git add src/routes/auth.ts src/routes/auth.test.ts src/oauth/state.ts
git commit -m "feat: add POST /auth/oauth/revoke endpoint with NIP-98 auth"
```

---

### Task 3: Migrate `fetchProfile` to kind 10011 with dual-read

**Files:**
- Modify: `src/index.ts` (lines ~2001-2029: `fetchProfile`, lines ~1772-1812: `publishIdentityTagToNostr`, lines ~1875-1944: `doLookup`)
- Test: `src/kind-migration.test.ts` (new file)

Note: `src/index.ts` is a 3000+ line file with inline HTML and JS. The functions live inside a `<script>` block served to the browser. Tests verify the served HTML contains correct kind numbers.

- [ ] **Step 1: Write tests that verify kind 10011 usage in served page**

Create `src/kind-migration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import app from './index'

function createTestEnv() {
  return {
    CACHE_KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
    } as unknown as KVNamespace,
    RATE_LIMIT_KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, caches_used: 0 }),
    } as unknown as KVNamespace,
  }
}

describe('kind 10011 migration', () => {
  it('publish function uses kind 10011, not kind 0', async () => {
    const res = await app.request('/', {}, createTestEnv())
    const html = await res.text()
    expect(html).toContain('kind: 10011')
    expect(html).not.toMatch(/unsignedEvent\s*=\s*\{[^}]*kind:\s*0/)
  })

  it('fetchIdentityEvent queries kind 10011', async () => {
    const res = await app.request('/', {}, createTestEnv())
    const html = await res.text()
    expect(html).toContain('fetchIdentityEvent')
    expect(html).toContain('kinds: [10011]')
  })

  it('doLookup reads from both kind 10011 and kind 0', async () => {
    const res = await app.request('/', {}, createTestEnv())
    const html = await res.text()
    expect(html).toContain('fetchIdentityEvent')
    expect(html).toContain('fetchProfileLegacy')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run src/kind-migration.test.ts`
Expected: FAIL — HTML still contains `kind: 0`

- [ ] **Step 3: Implement the migration in `src/index.ts`**

**3a. Replace `fetchProfile` function (~line 2001) with three functions:**

```javascript
function fetchIdentityEvent(relayUrl, pubkey) {
  return fetchEventByKind(relayUrl, pubkey, 10011);
}

function fetchProfileLegacy(relayUrl, pubkey) {
  return fetchEventByKind(relayUrl, pubkey, 0);
}

function fetchEventByKind(relayUrl, pubkey, kind) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 8000);
    let ws;
    try {
      ws = new WebSocket(relayUrl);
    } catch { reject(new Error('ws failed')); return; }
    const subId = 'lookup_' + Math.random().toString(36).slice(2, 8);
    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, { kinds: [kind], authors: [pubkey], limit: 1 }]));
    };
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId) {
          clearTimeout(timeout);
          ws.send(JSON.stringify(['CLOSE', subId]));
          ws.close();
          resolve(data[2]);
        } else if (data[0] === 'EOSE' && data[1] === subId) {
          clearTimeout(timeout);
          ws.close();
          resolve(null);
        }
      } catch {}
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error('ws error')); };
  });
}
```

**3b. Update `publishIdentityTagToNostr` (~line 1747):**

- `fetchProfile(relay, signerPubkey)` → `fetchIdentityEvent(relay, signerPubkey)`
- Add fallback: if `fetchIdentityEvent` returns null, try `fetchProfileLegacy` and extract only `i` tags
- `const content = profile && typeof profile.content === 'string' ? profile.content : '{}';` → `const content = '';`
- `kind: 0` → `kind: 10011`
- Status text: "Loading current kind 0 profile..." → "Loading identity event..."
- Status text: "Publishing kind 0 event to relays..." → "Publishing identity event to relays..."

**3c. Update `doLookup` (~line 1875):**

Replace profile fetch block (~lines 1911-1924):

```javascript
let identityEvent = null;
let legacyProfile = null;

for (const relay of relays) {
  try {
    if (!identityEvent) identityEvent = await fetchIdentityEvent(relay, pubkey);
    if (!legacyProfile) legacyProfile = await fetchProfileLegacy(relay, pubkey);
    if (identityEvent) break;
  } catch {}
}

const source = identityEvent || legacyProfile;
if (!source) {
  showStatus('Could not find identity claims on relays.', 'error');
  return;
}
```

Then update subsequent code to use `source` instead of `profile`.

**3d. Update all remaining `fetchProfile(` calls** to use the appropriate new function.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run src/kind-migration.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Run full test suite**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
cd ~/code/divine-identify-verification-service
git add src/index.ts src/kind-migration.test.ts
git commit -m "feat: migrate identity events from kind 0 to kind 10011 (NIP-39)

- fetchProfile split into fetchIdentityEvent (kind 10011) + fetchProfileLegacy (kind 0)
- Publish now emits kind 10011 with empty content
- Lookup reads kind 10011 first, falls back to kind 0 for pre-migration profiles"
```

- [ ] **Step 7: Push**

```bash
cd ~/code/divine-identify-verification-service && git push
```

---

## Chunk 2: Frontend Manage/Remove UI

### Task 4: Manage linked verifications UI

**Files:**
- Modify: `src/index.ts` (add manage section HTML + JS)
- Modify: `src/kind-migration.test.ts` (add manage UI tests)

- [ ] **Step 1: Write a test for the manage section**

Add to `src/kind-migration.test.ts`:

```typescript
describe('manage linked verifications UI', () => {
  it('serves a manage section with load and remove controls', async () => {
    const res = await app.request('/', {}, createTestEnv())
    const html = await res.text()
    expect(html).toContain('Manage verified links')
    expect(html).toContain('loadLinkedVerifications')
    expect(html).toContain('removeLinkedVerification')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run src/kind-migration.test.ts`
Expected: FAIL — manage section not in HTML

- [ ] **Step 3: Implement the manage section**

Add HTML card in `src/index.ts` after the existing "Verify Here" section. Include:
- "Manage verified links" heading
- Container `<div id="manage-links-container">` for the list
- "Load my links" button calling `loadLinkedVerifications()`
- Status area `<div id="manage-status"></div>`

Add JS functions in the inline script:

- `loadLinkedVerifications()` — gets active pubkey, dual-reads kind 10011 then kind 0, extracts `i` tags, calls `renderLinkedVerifications()`
- `renderLinkedVerifications(iTags, container)` — builds a table with Platform, Identity, Proof (truncated), and Remove button per row. All user-supplied values passed through `escapeHtml()`. Remove button calls `confirmRemoveVerification(platform, identity)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run src/kind-migration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd ~/code/divine-identify-verification-service
git add src/index.ts src/kind-migration.test.ts
git commit -m "feat: add manage linked verifications UI section"
```

---

### Task 5: Remove verification flow with confirmation

**Files:**
- Modify: `src/index.ts` (add confirmation dialog + remove logic + buildNip98Event helper)
- Modify: `src/kind-migration.test.ts` (add remove flow tests)

- [ ] **Step 1: Write tests for remove flow**

Add to `src/kind-migration.test.ts`:

```typescript
describe('remove verification flow', () => {
  it('includes confirmation dialog markup', async () => {
    const res = await app.request('/', {}, createTestEnv())
    const html = await res.text()
    expect(html).toContain('Remove this verification?')
    expect(html).toContain('confirmRemoveVerification')
  })

  it('calls revoke endpoint for OAuth platforms', async () => {
    const res = await app.request('/', {}, createTestEnv())
    const html = await res.text()
    expect(html).toContain('/auth/oauth/revoke')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run src/kind-migration.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement remove flow**

Add to inline JS in `src/index.ts`:

- `OAUTH_PLATFORMS` set: `['twitter', 'bluesky', 'youtube', 'tiktok']`
- `confirmRemoveVerification(platform, identity)` — shows confirmation dialog with claim text
- `cancelRemove()` — hides dialog
- `executeRemoveVerification()` — validates signer, dual-reads current event, filters out target `i` tag, publishes kind 10011, then calls `/auth/oauth/revoke` for OAuth platforms. Shows partial-success warning if revoke fails but publish succeeded. Refreshes manage list.
- `buildNip98Event(url, method)` — creates and signs a kind 27235 event with `u` and `method` tags

Add confirmation dialog HTML:
- Title: "Remove this verification?"
- Body with claim display
- Note about relay propagation
- Cancel and Remove buttons

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run src/kind-migration.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Manual verification with `wrangler dev`**

Run: `cd ~/code/divine-identify-verification-service && npx wrangler dev`

1. Open in browser, connect signer
2. Click "Load my links" — should show existing links (from kind 10011 or kind 0)
3. Click "Remove" on one — should show confirmation dialog
4. Confirm — should publish updated event and refresh list
5. Link should be gone from list

- [ ] **Step 7: Commit**

```bash
cd ~/code/divine-identify-verification-service
git add src/index.ts src/kind-migration.test.ts
git commit -m "feat: add verification removal with confirmation and OAuth cache revoke"
```

- [ ] **Step 8: Push**

```bash
cd ~/code/divine-identify-verification-service && git push
```

---

## Chunk 3: Hardening

### Task 6: Clean up UI copy and verify

- [ ] **Step 1: Run full test suite**

Run: `cd ~/code/divine-identify-verification-service && npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Verify no kind 0 references remain in publish/event construction**

Run: `grep -n 'kind: 0' src/index.ts`
Expected: Only appears in `fetchProfileLegacy` context (the backwards-compat read path), never in event construction.

- [ ] **Step 3: Update remaining UI copy**

Search `src/index.ts` for user-facing "kind 0" strings and update:
- "Loading current kind 0 profile..." → "Loading identity event..."
- "Publishing kind 0 event to relays..." → "Publishing identity event to relays..."
- "This writes/updates your identity tag in your signed Nostr kind 0 profile event." → "This writes/updates your identity tag in your signed Nostr identity event (NIP-39)."

- [ ] **Step 4: Commit**

```bash
cd ~/code/divine-identify-verification-service
git add src/index.ts
git commit -m "chore: update UI copy for kind 10011 migration"
```

- [ ] **Step 5: Final push**

```bash
cd ~/code/divine-identify-verification-service && git push
```

Mark PR as ready for review when all chunks are complete and manually tested.
