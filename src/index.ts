import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Bindings } from './types'
import health from './routes/health'
import platforms from './routes/platforms'
import verify from './routes/verify'
import nip05 from './routes/nip05'
import auth from './routes/auth'

const app = new Hono<{ Bindings: Bindings }>()

// Global error handler — prevent internal details from leaking
app.onError((err, c) => {
  console.error('Unhandled error:', err.message)
  return c.json({ error: 'Internal server error' }, 500)
})

// CORS middleware — restrict to known frontends
app.use('*', cors({
  origin: [
    'https://divine.video',
    'https://www.divine.video',
    'http://localhost:5173',
    'http://localhost:3000',
  ],
}))

// Routes
app.route('/health', health)
app.route('/platforms', platforms)
app.route('/verify', verify)
app.route('/nip05', nip05)
app.route('/auth', auth)

// Alias: POST /api/verify → single claim verification (divine-web compatibility)
app.post('/api/verify', async (c) => {
  const clientIp = c.req.header('cf-connecting-ip') || 'unknown'
  // Rewrite as a subrequest to /verify/single
  const url = new URL(c.req.url)
  url.pathname = '/verify/single'
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return app.fetch(newReq, c.env)
})
// HEAD /api/health — divine-web health check
app.get('/api/health', (c) => {
  if (c.req.method === 'HEAD') {
    return c.body(null, 200)
  }
  return c.json({ status: 'ok' })
})

// Root — landing page
app.get('/', (c) => {
  const accept = c.req.header('accept') || ''
  if (accept.includes('application/json') && !accept.includes('text/html')) {
    return c.json({ service: 'divine-identity-verification-service', version: '1.0.0' })
  }

  const origin = new URL(c.req.url).origin
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Divine Identity Verification Service</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6; color: #333; background: #f8fafc;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem; }
    header { text-align: center; margin-bottom: 2.5rem; padding: 2rem 0; }
    h1 { font-size: 2.2rem; color: #1a202c; margin-bottom: 0.5rem; }
    .tagline { color: #718096; font-size: 1.1rem; margin-top: 0.5rem; }
    .badge {
      display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px;
      font-size: 0.75rem; font-weight: 600; text-transform: uppercase; margin-left: 0.5rem;
    }
    .badge-live { background: #c6f6d5; color: #276749; }
    section {
      background: white; border-radius: 12px; padding: 1.5rem;
      margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    h2 { font-size: 1.3rem; color: #2d3748; margin-bottom: 1rem; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.5rem; }
    h3 { font-size: 1rem; color: #4a5568; margin: 1.25rem 0 0.5rem; }
    h4 { font-size: 0.9rem; color: #718096; margin: 0.75rem 0 0.25rem; }
    code {
      background: #edf2f7; padding: 0.15rem 0.4rem; border-radius: 4px;
      font-size: 0.85rem; font-family: 'SF Mono', Menlo, Consolas, monospace;
    }
    pre {
      background: #2d3748; color: #e2e8f0; padding: 1rem; border-radius: 8px;
      overflow-x: auto; font-size: 0.8rem; margin: 0.5rem 0 0.75rem;
      font-family: 'SF Mono', Menlo, Consolas, monospace; line-height: 1.5;
    }
    pre .comment { color: #a0aec0; }
    .endpoint { margin-bottom: 1.5rem; padding-bottom: 1.5rem; border-bottom: 1px solid #edf2f7; }
    .endpoint:last-child { border-bottom: none; padding-bottom: 0; margin-bottom: 0; }
    .method {
      display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px;
      font-size: 0.75rem; font-weight: 700; margin-right: 0.5rem; color: white;
    }
    .get { background: #48bb78; }
    .post { background: #4299e1; }
    .head { background: #9f7aea; }
    table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; }
    th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #e2e8f0; font-size: 0.85rem; }
    th { color: #718096; font-weight: 600; }
    td code { font-size: 0.8rem; }
    p { margin-bottom: 0.5rem; color: #4a5568; font-size: 0.9rem; }
    ul { margin: 0.25rem 0 0.5rem 1.25rem; color: #4a5568; font-size: 0.9rem; }
    li { margin-bottom: 0.2rem; }
    a { color: #4299e1; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .note { background: #ebf8ff; border-left: 3px solid #4299e1; padding: 0.5rem 0.75rem; border-radius: 0 6px 6px 0; margin: 0.5rem 0; font-size: 0.85rem; }
    footer { text-align: center; padding: 2rem 0; color: #a0aec0; font-size: 0.85rem; }
    nav { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1rem; justify-content: center; }
    nav a {
      background: #edf2f7; padding: 0.3rem 0.75rem; border-radius: 6px;
      font-size: 0.8rem; color: #4a5568;
    }
    nav a:hover { background: #e2e8f0; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Divine Identity Verification <span class="badge badge-live">Live</span></h1>
      <p class="tagline">Server-side verification of <a href="https://github.com/nostr-protocol/nips/blob/master/39.md">NIP-39</a> identity claims and <a href="https://github.com/nostr-protocol/nips/blob/master/05.md">NIP-05</a> identifiers for <a href="https://divine.video">Divine</a></p>
      <nav>
        <a href="#try-it" style="background:#4299e1;color:white;">Try It</a>
        <a href="#about">About</a>
        <a href="#platforms">Platforms</a>
        <a href="#single-verify">Single Verify</a>
        <a href="#batch-verify">Batch Verify</a>
        <a href="#get-verify">GET Verify</a>
        <a href="#nip05">NIP-05</a>
        <a href="#oauth">OAuth</a>
        <a href="#errors">Errors</a>
        <a href="#rate-limits">Rate Limits</a>
        <a href="#caching">Caching</a>
      </nav>
    </header>

    <section id="try-it" style="border:2px solid #4299e1;">
      <h2>Try It</h2>
      <p>Enter an npub, NIP-05 identifier, or hex pubkey to check identity verifications.</p>

      <div style="display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap;">
        <input id="lookup-input" type="text" placeholder="npub1... or user@domain.com or hex pubkey" style="flex:1;min-width:200px;padding:0.6rem 0.75rem;border:2px solid #e2e8f0;border-radius:8px;font-size:0.95rem;font-family:inherit;outline:none;transition:border-color 0.2s;" onfocus="this.style.borderColor='#4299e1'" onblur="this.style.borderColor='#e2e8f0'">
        <button id="lookup-btn" onclick="doLookup()" style="padding:0.6rem 1.5rem;background:#4299e1;color:white;border:none;border-radius:8px;font-size:0.95rem;cursor:pointer;font-weight:600;transition:background 0.2s;" onmouseover="this.style.background='#3182ce'" onmouseout="this.style.background='#4299e1'">Check</button>
      </div>
      <div id="lookup-status" style="display:none;padding:0.5rem 0.75rem;border-radius:6px;margin-bottom:0.75rem;font-size:0.85rem;"></div>
      <div id="lookup-results"></div>
    </section>

    <section id="about">
      <h2>About</h2>
      <p>This service verifies that a Nostr pubkey is linked to accounts on GitHub, Twitter/X, Bluesky, Mastodon, and Telegram. It fetches proof posts server-side, bypassing CORS restrictions that prevent browser-based verification.</p>
      <p>Two verification methods are supported:</p>
      <ul>
        <li><strong>NIP-39 proof posts</strong> &mdash; User publishes a post containing their <code>npub</code> on the external platform. The service fetches the post and checks that the npub is present and the author matches.</li>
        <li><strong>OAuth login</strong> (Twitter, Bluesky) &mdash; User authenticates directly via "Login with Twitter/Bluesky". No proof post needed.</li>
      </ul>
    </section>

    <section id="platforms">
      <h2>Supported Platforms</h2>
      <table>
        <tr><th>Platform ID</th><th>Label</th><th>Identity Format</th><th>Proof Format</th><th>OAuth</th></tr>
        <tr>
          <td><code>github</code></td><td>GitHub</td>
          <td>GitHub username (e.g., <code>octocat</code>)</td>
          <td>Gist ID (e.g., <code>aa5a315d61ae9438b18d</code>)</td>
          <td>No</td>
        </tr>
        <tr>
          <td><code>twitter</code></td><td>Twitter / X</td>
          <td>Twitter username (e.g., <code>jack</code>)</td>
          <td>Tweet ID (e.g., <code>1234567890</code>)</td>
          <td>Yes</td>
        </tr>
        <tr>
          <td><code>bluesky</code></td><td>Bluesky</td>
          <td>Handle (e.g., <code>alice.bsky.social</code>)</td>
          <td>Post rkey (e.g., <code>3k2la7k</code>)</td>
          <td>Yes</td>
        </tr>
        <tr>
          <td><code>mastodon</code></td><td>Mastodon</td>
          <td><code>instance/@user</code> (e.g., <code>mastodon.social/@alice</code>)</td>
          <td>Status ID (e.g., <code>109876543210</code>)</td>
          <td>No</td>
        </tr>
        <tr>
          <td><code>telegram</code></td><td>Telegram</td>
          <td>Username (e.g., <code>alice</code>)</td>
          <td><code>channel/messageId</code> (e.g., <code>mygroup/42</code>)</td>
          <td>No</td>
        </tr>
      </table>
      <div class="note">The proof post must contain the user's <code>npub</code> (bech32-encoded Nostr public key, starting with <code>npub1</code>). The service converts the hex pubkey to npub format before searching.</div>
    </section>

    <section id="single-verify">
      <h2>POST /api/verify &mdash; Single Claim Verification</h2>
      <p>Verify a single NIP-39 identity claim. This is the primary endpoint for divine-web integration.</p>

      <h4>Request</h4>
      <pre>POST ${origin}/api/verify
Content-Type: application/json

{
  "platform": "github",
  "identity": "octocat",
  "proof": "aa5a315d61ae9438b18d",
  "pubkey": "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e"
}</pre>

      <table>
        <tr><th>Field</th><th>Type</th><th>Description</th></tr>
        <tr><td><code>platform</code></td><td>string</td><td>One of: <code>github</code>, <code>twitter</code>, <code>bluesky</code>, <code>mastodon</code>, <code>telegram</code></td></tr>
        <tr><td><code>identity</code></td><td>string</td><td>Username or handle on the platform (see format per platform above)</td></tr>
        <tr><td><code>proof</code></td><td>string</td><td>ID of the proof post (gist ID, tweet ID, etc.)</td></tr>
        <tr><td><code>pubkey</code></td><td>string</td><td>64-character lowercase hex Nostr public key</td></tr>
      </table>

      <h4>Response (200 OK)</h4>
      <pre>{
  "platform": "github",
  "identity": "octocat",
  "verified": true,
  "checked_at": 1709571048,
  "cached": false
}</pre>

      <pre><span class="comment">// When verification fails:</span>
{
  "platform": "github",
  "identity": "octocat",
  "verified": false,
  "error": "npub not found in gist content",
  "checked_at": 1709571048,
  "cached": false
}</pre>

      <table>
        <tr><th>Field</th><th>Type</th><th>Description</th></tr>
        <tr><td><code>platform</code></td><td>string</td><td>Platform that was checked</td></tr>
        <tr><td><code>identity</code></td><td>string</td><td>Identity that was checked</td></tr>
        <tr><td><code>verified</code></td><td>boolean</td><td><code>true</code> if the proof post contains the npub and the author matches</td></tr>
        <tr><td><code>error</code></td><td>string?</td><td>Human-readable error message (only present when <code>verified</code> is <code>false</code>)</td></tr>
        <tr><td><code>checked_at</code></td><td>number</td><td>Unix timestamp (seconds) when the verification was performed</td></tr>
        <tr><td><code>cached</code></td><td>boolean</td><td><code>true</code> if this result was served from cache</td></tr>
      </table>
    </section>

    <section id="batch-verify">
      <h2>POST /verify &mdash; Batch Verification</h2>
      <p>Verify up to 10 NIP-39 identity claims in a single request. All claims are verified concurrently.</p>

      <h4>Request</h4>
      <pre>POST ${origin}/verify
Content-Type: application/json

{
  "claims": [
    {
      "platform": "github",
      "identity": "octocat",
      "proof": "aa5a315d61ae9438b18d",
      "pubkey": "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e"
    },
    {
      "platform": "twitter",
      "identity": "jack",
      "proof": "1234567890",
      "pubkey": "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e"
    }
  ]
}</pre>

      <h4>Response (200 OK)</h4>
      <pre>{
  "results": [
    {
      "platform": "github",
      "identity": "octocat",
      "verified": true,
      "checked_at": 1709571048,
      "cached": false
    },
    {
      "platform": "twitter",
      "identity": "jack",
      "verified": false,
      "error": "Tweet not found or not embeddable",
      "checked_at": 1709571048,
      "cached": false
    }
  ]
}</pre>
      <p>The <code>results</code> array preserves the same order as the input <code>claims</code> array. Each result has the same shape as the single verification response.</p>
    </section>

    <section id="get-verify">
      <h2>GET /verify/:platform/:identity/:proof &mdash; URL-Based Verification</h2>
      <p>Verify a single claim via URL parameters. Useful for simple integrations or testing.</p>

      <h4>Request</h4>
      <pre>GET ${origin}/verify/github/octocat/aa5a315d61ae9438b18d?pubkey=7e7e9c42...4e</pre>

      <p>For Mastodon, the identity contains slashes, so the URL has extra path segments:</p>
      <pre>GET ${origin}/verify/mastodon/mastodon.social/@alice/109876543210?pubkey=7e7e...4e</pre>

      <h4>Response</h4>
      <p>Same shape as the single verification response above.</p>
    </section>

    <section id="nip05">
      <h2>GET /nip05/verify &mdash; NIP-05 Identifier Verification</h2>
      <p>Check that a NIP-05 identifier (<code>user@domain</code>) resolves to the given hex pubkey.</p>

      <h4>Request</h4>
      <pre>GET ${origin}/nip05/verify?name=_@divine.video&amp;pubkey=7e7e9c42...4e</pre>

      <table>
        <tr><th>Query Param</th><th>Description</th></tr>
        <tr><td><code>name</code></td><td>NIP-05 identifier, e.g., <code>alice@example.com</code> or <code>_@divine.video</code></td></tr>
        <tr><td><code>pubkey</code></td><td>64-char hex pubkey to check against</td></tr>
      </table>

      <h4>Response (200 OK)</h4>
      <pre><span class="comment">// Verified:</span>
{
  "name": "_",
  "domain": "divine.video",
  "pubkey": "7e7e9c42...4e",
  "verified": true,
  "checked_at": 1709571048,
  "cached": false
}

<span class="comment">// Not verified:</span>
{
  "name": "_",
  "domain": "divine.video",
  "pubkey": "7e7e9c42...4e",
  "verified": false,
  "error": "Pubkey does not match NIP-05 registration",
  "checked_at": 1709571048,
  "cached": false
}</pre>
      <p>The service fetches <code>https://{domain}/.well-known/nostr.json?name={local}</code> and compares the registered pubkey (per <a href="https://github.com/nostr-protocol/nips/blob/master/05.md">NIP-05 spec</a>). Redirects are not followed.</p>
    </section>

    <section id="oauth">
      <h2>OAuth Verification (Twitter, Bluesky)</h2>
      <p>As an alternative to proof posts, users can verify their identity by logging in with Twitter or Bluesky. This is a browser-based flow.</p>

      <h3>1. Start OAuth Flow</h3>
      <pre>GET ${origin}/auth/twitter/start?pubkey=hex64&amp;return_url=https://divine.video/settings
GET ${origin}/auth/bluesky/start?pubkey=hex64&amp;handle=alice.bsky.social&amp;return_url=https://divine.video/settings</pre>

      <table>
        <tr><th>Param</th><th>Description</th></tr>
        <tr><td><code>pubkey</code></td><td>64-char hex Nostr pubkey to associate with the verified identity</td></tr>
        <tr><td><code>return_url</code></td><td>URL to redirect back to after OAuth completes (must be a trusted origin)</td></tr>
        <tr><td><code>handle</code></td><td>(Bluesky only) User's Bluesky handle for auth server discovery</td></tr>
      </table>

      <p>Redirects the user to the platform's OAuth consent screen. After authorization, the callback stores the verification and redirects to <code>return_url</code> with query params:</p>

      <pre><span class="comment">// Success:</span>
{return_url}?oauth_verified=true&amp;platform=twitter&amp;identity=jack

<span class="comment">// Failure:</span>
{return_url}?oauth_error=Verification+failed</pre>

      <h3>2. Check OAuth Status</h3>
      <pre>GET ${origin}/auth/twitter/status?pubkey=hex64&amp;identity=jack</pre>

      <h4>Response</h4>
      <pre><span class="comment">// Verified via OAuth:</span>
{
  "platform": "twitter",
  "identity": "jack",
  "pubkey": "7e7e9c42...4e",
  "verified": true,
  "method": "oauth",
  "checked_at": 1709571048
}

<span class="comment">// Not verified:</span>
{
  "platform": "twitter",
  "identity": "jack",
  "pubkey": "7e7e9c42...4e",
  "verified": false,
  "method": null
}</pre>

      <div class="note">OAuth verification is also checked as a fallback when using <code>POST /api/verify</code> or <code>POST /verify</code> for twitter and bluesky claims. If the proof post check fails but an OAuth verification exists, it will return <code>verified: true</code>.</div>

      <h3>3. Bluesky Client Metadata</h3>
      <pre>GET ${origin}/auth/bluesky/client-metadata.json</pre>
      <p>AT Protocol OAuth requires the client metadata to be publicly hosted. This endpoint serves the OAuth client registration for Bluesky.</p>
    </section>

    <section id="other">
      <h2>Utility Endpoints</h2>

      <div class="endpoint">
        <h3><span class="method get">GET</span> <code>/platforms</code></h3>
        <p>List all supported platforms and their verification status.</p>
        <pre>GET ${origin}/platforms

<span class="comment">// Response:</span>
{
  "platforms": {
    "github": { "label": "GitHub", "supported": true },
    "twitter": { "label": "Twitter / X", "supported": true },
    "mastodon": { "label": "Mastodon", "supported": true },
    "telegram": { "label": "Telegram", "supported": true },
    "bluesky": { "label": "Bluesky", "supported": true }
  }
}</pre>
      </div>

      <div class="endpoint">
        <h3><span class="method get">GET</span> <code>/health</code></h3>
        <p>Health check. Returns 200 if the service is running.</p>
        <pre>GET ${origin}/health

<span class="comment">// Response:</span>
{
  "status": "ok",
  "service": "divine-identity-verification-service",
  "version": "1.0.0",
  "timestamp": 1709571048
}</pre>
      </div>

      <div class="endpoint">
        <h3><span class="method head">HEAD</span> <code>/api/health</code></h3>
        <p>Lightweight health check (no body). Returns 200 if up.</p>
      </div>
    </section>

    <section id="errors">
      <h2>Error Responses</h2>
      <p>All errors return a JSON object with an <code>error</code> field. Some include additional details.</p>

      <table>
        <tr><th>HTTP Status</th><th>Meaning</th><th>Example <code>error</code> value</th></tr>
        <tr><td><code>400</code></td><td>Bad request / validation failed</td><td><code>"Invalid or missing pubkey (64-char hex)"</code></td></tr>
        <tr><td><code>429</code></td><td>Rate limit exceeded</td><td><code>"Rate limit exceeded"</code></td></tr>
        <tr><td><code>500</code></td><td>Internal server error</td><td><code>"Internal server error"</code></td></tr>
        <tr><td><code>502</code></td><td>Upstream platform error (OAuth)</td><td><code>"Bluesky token exchange failed"</code></td></tr>
        <tr><td><code>503</code></td><td>Service not configured</td><td><code>"Twitter OAuth not configured"</code></td></tr>
      </table>

      <h4>Batch validation error format (400)</h4>
      <pre>{
  "error": "Validation failed",
  "details": [
    { "index": 0, "error": "Invalid pubkey: must be 64-character hex" },
    { "index": 2, "error": "Invalid platform: must be one of github, twitter, mastodon, telegram, bluesky" }
  ]
}</pre>

      <h4>Common verification error strings</h4>
      <table>
        <tr><th>Error</th><th>Meaning</th></tr>
        <tr><td><code>Gist not found</code></td><td>GitHub gist ID doesn't exist or is private</td></tr>
        <tr><td><code>Gist owner does not match claimed identity</code></td><td>Gist belongs to a different GitHub user</td></tr>
        <tr><td><code>npub not found in gist content</code></td><td>Gist exists but doesn't contain the expected npub</td></tr>
        <tr><td><code>Tweet not found or not embeddable</code></td><td>Tweet doesn't exist, is deleted, or is from a private account</td></tr>
        <tr><td><code>Tweet author does not match claimed identity</code></td><td>Tweet belongs to a different Twitter user</td></tr>
        <tr><td><code>Mastodon status not found</code></td><td>Status ID doesn't exist on the specified instance</td></tr>
        <tr><td><code>Status author does not match claimed identity</code></td><td>Mastodon status was posted by someone else</td></tr>
        <tr><td><code>Telegram message not found</code></td><td>Telegram message doesn't exist or channel is private</td></tr>
        <tr><td><code>Message author does not match claimed identity</code></td><td>Telegram message was posted by someone else</td></tr>
        <tr><td><code>Post or thread not found on Bluesky</code></td><td>Bluesky post doesn't exist</td></tr>
        <tr><td><code>Post author does not match claimed identity</code></td><td>Bluesky post was authored by a different handle/DID</td></tr>
        <tr><td><code>Pubkey does not match NIP-05 registration</code></td><td>The domain's nostr.json has a different pubkey for this name</td></tr>
      </table>
    </section>

    <section id="rate-limits">
      <h2>Rate Limits</h2>
      <table>
        <tr><th>Scope</th><th>Limit</th><th>Window</th></tr>
        <tr><td>Per IP address</td><td>60 requests</td><td>1 minute</td></tr>
        <tr><td>Per pubkey</td><td>20 verifications</td><td>1 minute</td></tr>
        <tr><td>Per platform</td><td>30 outbound fetches</td><td>1 minute</td></tr>
        <tr><td>Batch max</td><td>10 claims</td><td>per request</td></tr>
      </table>
      <p>When rate-limited, the API returns <code>429 Too Many Requests</code>. Cached results do not count against rate limits.</p>
    </section>

    <section id="caching">
      <h2>Caching</h2>
      <p>Results are cached in Cloudflare KV to reduce outbound requests and improve response times.</p>
      <table>
        <tr><th>Result Type</th><th>Cache TTL</th></tr>
        <tr><td>Verified claim</td><td>24 hours</td></tr>
        <tr><td>Failed verification</td><td>15 minutes</td></tr>
        <tr><td>Platform error (upstream down)</td><td>5 minutes</td></tr>
        <tr><td>OAuth verification</td><td>24 hours</td></tr>
      </table>
      <p>Cached responses include <code>"cached": true</code> in the response body. The <code>checked_at</code> timestamp reflects when the original verification was performed.</p>
    </section>

    <section id="integration">
      <h2>Integration with divine-web</h2>
      <p>To use this service from a divine-web frontend:</p>

      <h4>1. Set environment variable</h4>
      <pre>VITE_VERIFICATION_SERVICE_URL=${origin}</pre>

      <h4>2. Enable the feature flag</h4>
      <pre>localStorage.setItem('divine_feature_useVerificationService', 'true')</pre>

      <h4>3. Health check (on startup)</h4>
      <pre>const resp = await fetch('${origin}/api/health', { method: 'HEAD' })
const isAvailable = resp.ok  <span class="comment">// true if service is up</span></pre>

      <h4>4. Verify a claim</h4>
      <pre>const resp = await fetch('${origin}/api/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    platform: 'github',       <span class="comment">// from NIP-39 i-tag</span>
    identity: 'octocat',      <span class="comment">// from NIP-39 i-tag</span>
    proof: 'aa5a315d61ae9438', <span class="comment">// from NIP-39 i-tag</span>
    pubkey: '7e7e9c42a91b...', <span class="comment">// event author hex pubkey</span>
  }),
})
const result = await resp.json()
<span class="comment">// result.verified === true | false</span>
<span class="comment">// result.error === 'reason...' (if false)</span></pre>

      <h4>5. Verify NIP-05</h4>
      <pre>const name = '_@divine.video'  <span class="comment">// from user's kind-0 nip05 field</span>
const pubkey = '7e7e9c42...'   <span class="comment">// event author hex pubkey</span>
const resp = await fetch(
  \`${origin}/nip05/verify?name=\${encodeURIComponent(name)}&pubkey=\${pubkey}\`
)
const result = await resp.json()
<span class="comment">// result.verified === true | false</span></pre>
    </section>

    <section id="nostr">
      <h2>NIP-39 Identity Tag Format</h2>
      <p>This service verifies claims that are published as <a href="https://github.com/nostr-protocol/nips/blob/master/39.md">NIP-39</a> <code>i</code> tags on Nostr kind-0 (profile metadata) events:</p>
      <pre><span class="comment">// Nostr kind-0 event tags:</span>
["i", "github:octocat", "aa5a315d61ae9438b18d"]
["i", "twitter:jack", "1234567890"]
["i", "mastodon:mastodon.social/@alice", "109876543210"]
["i", "telegram:alice", "mygroup/42"]
["i", "bluesky:alice.bsky.social", "3k2la7k"]</pre>
      <p>Each tag is <code>["i", "{platform}:{identity}", "{proof}"]</code>. The <code>pubkey</code> is the event author's public key.</p>
    </section>

    <script>
    const API = '${origin}';

    function npubToHex(npub) {
      const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
      const data = npub.slice(5); // strip "npub1"
      const values = [];
      for (const c of data) {
        const v = CHARSET.indexOf(c);
        if (v === -1) throw new Error('Invalid npub character');
        values.push(v);
      }
      // bech32 decode: strip checksum (last 6), convert 5-bit to 8-bit
      const words = values.slice(0, values.length - 6);
      let bits = 0, value = 0;
      const result = [];
      for (const w of words) {
        value = (value << 5) | w;
        bits += 5;
        while (bits >= 8) {
          bits -= 8;
          result.push((value >> bits) & 0xff);
        }
      }
      return result.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function showStatus(msg, type) {
      const el = document.getElementById('lookup-status');
      el.style.display = 'block';
      el.textContent = msg;
      el.style.background = type === 'error' ? '#fed7d7' : type === 'loading' ? '#fefcbf' : '#c6f6d5';
      el.style.color = type === 'error' ? '#c53030' : type === 'loading' ? '#975a16' : '#276749';
    }

    function hideStatus() {
      document.getElementById('lookup-status').style.display = 'none';
    }

    function renderResults(results, pubkey) {
      const el = document.getElementById('lookup-results');
      if (!results || results.length === 0) {
        el.innerHTML = '<p style="color:#718096;font-size:0.9rem;">No identity claims found on this profile.</p>';
        return;
      }
      let html = '<table><tr><th>Platform</th><th>Identity</th><th>Status</th><th>Details</th></tr>';
      for (const r of results) {
        const icon = r.verified ? '&#9989;' : '&#10060;';
        const status = r.verified ? '<span style="color:#276749;font-weight:600;">Verified</span>' : '<span style="color:#c53030;">Not verified</span>';
        const detail = r.error || (r.cached ? 'cached' : 'fresh check');
        html += '<tr><td><code>' + esc(r.platform) + '</code></td><td>' + esc(r.identity) + '</td><td>' + icon + ' ' + status + '</td><td style="font-size:0.8rem;color:#718096;">' + esc(detail) + '</td></tr>';
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

        showStatus('Found pubkey: ' + pubkey.slice(0, 8) + '...' + pubkey.slice(-8) + '. Fetching profile from relays...', 'loading');

        // Fetch profile from Nostr relays to get i-tags
        const relays = ['wss://relay.divine.video', 'wss://relay.damus.io', 'wss://relay.nostr.band'];
        let profile = null;

        for (const relay of relays) {
          try {
            profile = await fetchProfile(relay, pubkey);
            if (profile) break;
          } catch { /* try next relay */ }
        }

        if (!profile) {
          showStatus('Could not find Nostr profile on relays.', 'error');
          return;
        }

        // Extract i-tags (NIP-39 identity claims)
        const iTags = (profile.tags || []).filter(t => t[0] === 'i' && t[1] && t[2]);
        if (iTags.length === 0) {
          showStatus('Profile found but has no linked identity claims (NIP-39 i-tags).', 'error');
          // Check NIP-05 if present
          const content = tryParseJSON(profile.content);
          if (content && content.nip05) {
            const nip05Resp = await fetch(API + '/nip05/verify?name=' + encodeURIComponent(content.nip05) + '&pubkey=' + pubkey);
            const nip05Result = await nip05Resp.json();
            showStatus('No NIP-39 claims, but found NIP-05:', 'loading');
            renderResults([{
              platform: 'nip05',
              identity: content.nip05,
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
        }).filter(c => ['github','twitter','mastodon','telegram','bluesky'].includes(c.platform));

        if (claims.length === 0) {
          showStatus('Profile has identity tags but none for supported platforms.', 'error');
          return;
        }

        showStatus('Verifying ' + claims.length + ' identity claim(s)...', 'loading');

        // Batch verify
        const verifyResp = await fetch(API + '/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claims }),
        });
        const verifyData = await verifyResp.json();

        if (verifyData.error) {
          showStatus('Verification error: ' + verifyData.error, 'error');
          return;
        }

        // Also check NIP-05
        const content = tryParseJSON(profile.content);
        let allResults = verifyData.results || [];
        if (content && content.nip05) {
          const nip05Resp = await fetch(API + '/nip05/verify?name=' + encodeURIComponent(content.nip05) + '&pubkey=' + pubkey);
          const nip05Result = await nip05Resp.json();
          allResults = [{
            platform: 'nip05',
            identity: content.nip05,
            verified: nip05Result.verified,
            error: nip05Result.error,
            cached: nip05Result.cached
          }, ...allResults];
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

    function fetchProfile(relayUrl, pubkey) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 8000);
        let ws;
        try {
          ws = new WebSocket(relayUrl);
        } catch { reject(new Error('ws failed')); return; }
        const subId = 'lookup_' + Math.random().toString(36).slice(2, 8);
        ws.onopen = () => {
          ws.send(JSON.stringify(['REQ', subId, { kinds: [0], authors: [pubkey], limit: 1 }]));
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

    // Handle Enter key
    document.getElementById('lookup-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLookup();
    });
    </script>

    <footer>
      <p>Part of the <a href="https://divine.video">Divine</a> ecosystem &middot; Powered by Cloudflare Workers</p>
    </footer>
  </div>
</body>
</html>`)
})

export default { fetch: app.fetch }
