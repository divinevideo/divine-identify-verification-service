import { MAX_BATCH_SIZE } from './routes/verify'
import { PAGE_STYLES } from './page-styles'
import { SHARED_PAGE_SCRIPT } from './page-script-shared'

// "Look up someone" has its own page because it needs no signer: anyone can
// check a profile, so none of the main page's sign-in code (the embed bridge,
// Divine login, nostr-tools) ships with it, and its script is only the lookup.
export interface LookupPageOptions {
  origin: string
  nonce: string
  hasYouTube: boolean
  hasTikTok: boolean
}

export function renderLookupPage(opts: LookupPageOptions): string {
  const { origin, nonce, hasYouTube, hasTikTok } = opts
  const extraLookupPlatforms = (hasYouTube ? ",'youtube'" : '') + (hasTikTok ? ",'tiktok'" : '')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Look up someone: Divine Identity Verification</title>
  <meta name="description" content="Enter a Divine address or public key to see which accounts that profile has verified.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Inter:wght@400;500;600;700&display=swap">
  <style>
${PAGE_STYLES}
  </style>
</head>
<body>
  <div class="container">

    <nav class="topbar">
      <a class="brand" href="/"><span class="logomark" aria-hidden="true"></span><span>Divine Identity</span></a>
      <div class="nav-actions">
        <a class="nav-link" href="/">Verify an account</a>
        <a class="nav-link" href="https://divine.video">divine.video</a>
      </div>
    </nav>

    <div class="hero">
      <h1>Look up someone<span class="punct">.</span></h1>
      <p class="subtitle">Want to know if a profile is real? Enter their Divine address (like <code>example@divine.video</code>) or their public key to see which accounts they've verified.</p>
    </div>

    <section id="check" style="box-shadow: 6px 6px 0 var(--pink);">
      <div style="display:flex;gap:10px;margin-bottom:1rem;flex-wrap:wrap;">
        <input id="lookup-input" type="text" class="lookup-input" placeholder="example@divine.video or npub1...">
        <button id="lookup-btn" class="lookup-btn" type="button">Check</button>
      </div>
      <div id="lookup-status" class="lookup-status"></div>
      <div id="lookup-results"></div>
    </section>

    <!-- API REFERENCE LINK -->
    <section id="api-link">
      <p>Building on this service? The API reference is at <a href="/docs">/docs</a>.</p>
    </section>

    <footer>
      <p>Part of <a href="https://divine.video">divine.video</a>. Open source. Own what you make.</p>
      <p><a href="https://divine.video/privacy">Privacy Policy</a> &middot; <a href="https://divine.video/terms">Terms of Service</a></p>
    </footer>
  </div>

  <script nonce="${nonce}">
    const API = '${origin}';
${SHARED_PAGE_SCRIPT}
    const VERIFY_BATCH_SIZE = ${MAX_BATCH_SIZE};

    function showStatus(msg, type) {
      const el = document.getElementById('lookup-status');
      el.style.display = 'block';
      el.textContent = msg;
      // brand-aligned status palette
      el.style.background = type === 'error' ? 'rgba(255,127,175,0.18)' : type === 'loading' ? 'rgba(208,251,203,0.5)' : 'rgba(39,197,139,0.18)';
      el.style.color = type === 'error' ? '#7a1133' : type === 'loading' ? '#07241B' : '#0a4f37';
      el.style.borderColor = type === 'error' ? 'rgba(255,127,175,0.55)' : type === 'loading' ? 'rgba(7,36,27,0.18)' : 'rgba(39,197,139,0.45)';
    }

    function hideStatus() { clearStatus('lookup-status'); }

    function renderResults(results, pubkey) {
      const el = document.getElementById('lookup-results');
      if (!results || results.length === 0) {
        el.innerHTML = '<p style="color:rgba(7,36,27,0.65);font-size:0.92rem;">No identity claims found on this profile.</p>';
        return;
      }
      let html = '<table><tr><th>Platform</th><th>Identity</th><th>Status</th><th>Details</th></tr>';
      for (const r of results) {
        const icon = r.verified ? '&#9989;' : '&#10060;';
        const status = r.verified ? '<span style="color:#0a4f37;font-weight:700;">Verified</span>' : '<span style="color:#7a1133;font-weight:700;">Not verified</span>';
        const detail = r.error || (r.cached ? 'cached' : 'fresh check');
        html += '<tr><td><code>' + esc(r.platform) + '</code></td><td>' + esc(r.identity) + '</td><td>' + icon + ' ' + status + '</td><td style="font-size:0.82rem;color:rgba(7,36,27,0.6);">' + esc(detail) + '</td></tr>';
      }
      html += '</table>';
      el.innerHTML = html;
    }

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s || '';
      return d.innerHTML;
    }

    async function doLookup() {
      const input = document.getElementById('lookup-input').value.trim();
      if (!input) return;

      const resultsEl = document.getElementById('lookup-results');
      resultsEl.innerHTML = '';
      showStatus('Looking up...', 'loading');

      try {
        // Determine if npub or NIP-05
        let pubkey, nip05Name;
        if (input.startsWith('npub1')) {
          pubkey = npubToHex(input);
        } else if (input.includes('@')) {
          nip05Name = input;
          // First resolve NIP-05 to get the pubkey
          const parts = input.split('@');
          const domain = parts[1];
          const local = parts[0] || '_';
          const nip05Resp = await fetch('https://' + domain + '/.well-known/nostr.json?name=' + encodeURIComponent(local));
          if (!nip05Resp.ok) throw new Error('Could not fetch NIP-05 from ' + domain);
          const nip05Data = await nip05Resp.json();
          pubkey = nip05Data.names && nip05Data.names[local];
          if (!pubkey) throw new Error('NIP-05 name "' + local + '" not found at ' + domain);
        } else {
          // Try as raw hex pubkey
          if (/^[0-9a-f]{64}$/i.test(input)) {
            pubkey = input.toLowerCase();
          } else {
            throw new Error('Enter an npub, NIP-05 (user@domain), or 64-char hex pubkey');
          }
        }

        showStatus('Found pubkey: ' + pubkey.slice(0, 8) + '...' + pubkey.slice(-8) + '. Fetching identity claims from relays...', 'loading');

        // Fetch identity event (kind 10011) from Nostr relays, fall back to kind 0
        const relays = PROFILE_RELAYS;
        let identityEvent = null;
        let legacyProfile = null;

        for (const relay of relays) {
          try {
            if (!identityEvent) identityEvent = await fetchIdentityEvent(relay, pubkey);
            if (!legacyProfile) legacyProfile = await fetchProfileLegacy(relay, pubkey);
            // Keep going until both are found: the claims live in the identity
            // event, but the NIP-05 lives in the kind 0 profile.
            if (identityEvent && legacyProfile) break;
          } catch { /* try next relay */ }
        }

        const source = identityEvent || legacyProfile;
        if (!source) {
          showStatus('Could not find identity claims on relays.', 'error');
          return;
        }

        // Extract i-tags (NIP-39 identity claims). Events come from relays, so
        // skip anything that isn't a well-formed ['i', 'platform:identity', proof] tag.
        const iTags = (Array.isArray(source.tags) ? source.tags : []).filter(t =>
          Array.isArray(t) && t[0] === 'i' && typeof t[1] === 'string' && typeof t[2] === 'string' && t[1] && t[2]);
        if (iTags.length === 0) {
          showStatus('No linked identity claims (NIP-39 i-tags) found.', 'error');
          // Check NIP-05 if present in kind 0 profile
          const profileContent = legacyProfile ? tryParseJSON(legacyProfile.content) : null;
          if (profileContent && typeof profileContent.nip05 === 'string' && profileContent.nip05) {
            const nip05Resp = await fetch(API + '/nip05/verify?name=' + encodeURIComponent(profileContent.nip05) + '&pubkey=' + pubkey);
            const nip05Result = await nip05Resp.json();
            showStatus('No NIP-39 claims, but found NIP-05:', 'loading');
            renderResults([{
              platform: 'nip05',
              identity: profileContent.nip05,
              verified: nip05Result.verified,
              error: nip05Result.error,
              cached: nip05Result.cached
            }], pubkey);
          }
          return;
        }

        // Parse i-tags into claims
        const claims = iTags.map(tag => {
          const [platform, ...rest] = tag[1].split(':');
          const identity = rest.join(':');
          return { platform, identity, proof: tag[2], pubkey };
        }).filter(c => ['github','twitter','mastodon','telegram','bluesky','discord'${extraLookupPlatforms}].includes(c.platform));

        if (claims.length === 0) {
          showStatus('Profile has identity tags but none for supported platforms.', 'error');
          return;
        }

        showStatus('Verifying ' + claims.length + ' identity claim(s)...', 'loading');

        // Batch verify, at most VERIFY_BATCH_SIZE claims per request (the server's limit).
        let allResults = [];
        for (let i = 0; i < claims.length; i += VERIFY_BATCH_SIZE) {
          const verifyResp = await fetch(API + '/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ claims: claims.slice(i, i + VERIFY_BATCH_SIZE) }),
          });
          const verifyData = await verifyResp.json();

          if (verifyData.error) {
            showStatus('Verification error: ' + verifyData.error, 'error');
            return;
          }
          allResults = allResults.concat(verifyData.results || []);
        }

        // Also check NIP-05, which lives in the kind 0 profile.
        const content = legacyProfile ? tryParseJSON(legacyProfile.content) : null;
        if (content && typeof content.nip05 === 'string' && content.nip05) {
          // The NIP-05 row is extra: if its check fails, show that row as not
          // verified rather than hiding the accounts that did verify.
          let nip05Row;
          try {
            const nip05Resp = await fetch(API + '/nip05/verify?name=' + encodeURIComponent(content.nip05) + '&pubkey=' + pubkey);
            const nip05Result = await nip05Resp.json();
            nip05Row = { platform: 'nip05', identity: content.nip05, verified: nip05Result.verified, error: nip05Result.error, cached: nip05Result.cached };
          } catch {
            nip05Row = { platform: 'nip05', identity: content.nip05, verified: false, error: 'NIP-05 check failed', cached: false };
          }
          allResults = [nip05Row, ...allResults];
        }

        hideStatus();
        renderResults(allResults, pubkey);

      } catch (e) {
        showStatus(e.message || 'Unknown error', 'error');
      }
    }

    function tryParseJSON(s) {
      try { return JSON.parse(s); } catch { return null; }
    }

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

    // Wired here, not with inline onclick attributes, which the page's script-nonce policy would block.
    document.getElementById('lookup-btn').addEventListener('click', doLookup);
    document.getElementById('lookup-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLookup();
    });
  </script>
</body>
</html>`
}
