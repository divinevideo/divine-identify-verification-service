import { FIXED_SIGNIN_LIFETIME_DAYS } from './oauth/signin-lifetime'
import { listInProse, oauthPlatformsFor, type PlatformFlags } from './page-platforms'
import { PAGE_STYLES } from './page-styles'

// Everything the API reference reads from the request or the environment. The
// /docs route computes it the way the landing route does (platformFlags), so
// the table and the sign-in copy name the same platforms the landing page's
// picker offers. The page has no script, so it needs no nonce.
export interface DocsPageOptions extends PlatformFlags {
  origin: string
  // True only while CONFIRMATION_GATE is on. Off and shadow render the page
  // exactly as it was before the gate existed.
  confirmationGateOn?: boolean
}

export function renderDocsPage(opts: DocsPageOptions): string {
  const { origin, hasYouTube, hasTikTok, twitterOAuthEnabled, blueskyLinksOff, youtubeOAuthEnabled, tiktokOAuthEnabled, tiktokLinksOff, confirmationGateOn = false } = opts
  const oauthPlatforms = oauthPlatformsFor(opts)
  const oauthPlatformNames = oauthPlatforms.map(platform => platform.name)
  // The start example stays on Bluesky while it is offered, otherwise it shows
  // the first platform a client can actually sign in with. The request shape is
  // the same for every platform except Bluesky's handle, which no other platform
  // takes. With none offered it keeps the Bluesky example: the API shape does
  // not change.
  const exampleValue = oauthPlatforms.some(p => p.value === 'bluesky') ? 'bluesky' : oauthPlatforms[0]?.value ?? 'bluesky'
  const exampleBody = exampleValue === 'bluesky'
    ? `{"pubkey":"&lt;64 hex&gt;","return_url":"${origin}/?signin=&lt;id&gt;","handle":"example.bsky.social","start_check":"&lt;base64url(sha256('divine-signin-start:' + secret))&gt;"}`
    : `{"pubkey":"&lt;64 hex&gt;","return_url":"${origin}/?signin=&lt;id&gt;","start_check":"&lt;base64url(sha256('divine-signin-start:' + secret))&gt;"}`
  const oauthIntro = oauthPlatforms.length
    ? 'Users can verify by logging in instead of posting a proof.'
    : 'No platform offers sign-in right now, so new links need a proof post.'
  const oauthCheckedFor = oauthPlatforms.length
    ? listInProse(oauthPlatformNames)
    : "every sign-in platform whose links aren't switched off"
  // Names read "none right now" when the operator has withdrawn every sign-in.
  const oauthNamesText = oauthPlatformNames.length ? oauthPlatformNames.join(', ') : 'none right now'
  // Pre-build conditional HTML to avoid TS2590 (template literal union too complex)
  const ytTableRow = hasYouTube ? `<tr><td><code>youtube</code></td><td>Channel ID (<code>UC</code> followed by 22 characters) or handle (<code>@user</code>, or without the <code>@</code>, which is added). <code>c/</code> and <code>user/</code> links aren't accepted.</td><td>Video ID (11 chars)</td><td>${youtubeOAuthEnabled ? 'Yes' : 'No'}</td></tr>` : ''
  const ttTableRow = hasTikTok ? `<tr><td><code>tiktok</code></td><td>Username (without @)</td><td>Video or photo link, share link, or post number</td><td>${tiktokOAuthEnabled ? 'Yes' : 'No'}</td></tr>` : ''
  // The check runs only with the YouTube API key, which is also what lists YouTube.
  const youtubeAccountCheckNote = hasYouTube
    ? " A YouTube sign-in claimed by handle also stops counting once the handle belongs to another channel or YouTube finds no channel with it. The claim must spell the handle as the sign-in saved it, apart from the letter case of A to Z. YouTube's answer is reused for up to a day, and while YouTube can't answer, the link keeps counting. A sign-in saved under its channel ID (a channel without a handle) is compared with it exactly, without asking YouTube."
    : ''
  // Added only while the gate is on, so the page is unchanged otherwise.
  const confirmationPlatformsNote = confirmationGateOn
    ? ' Each entry where <code>oauth</code> is <code>true</code> also has <code>signin_requires: "confirmation"</code>: linking by signing in needs Divine Confirmation. Proof posts stay free.'
    : ''
  const confirmationCodeNote = confirmationGateOn
    ? ' <code>signin_needs_confirmation</code> means an account linked by signing in, while the Confirmation requirement was on, does not count because its owner does not have Divine Confirmation right now. Links saved earlier are unaffected. Renewing restores it without signing in again. Proof posts and Bluesky identity-link records still verify.'
    : ''
  const confirmationRefusals = confirmationGateOn
    ? `
        <li><code>confirmation_required</code> (403: linking by sign-in needs Divine Confirmation; the code stays usable for its 10 minutes);</li>
        <li><code>confirmation_unavailable</code> (503: Confirmation could not be checked; try again);</li>`
    : ''
  const confirmationHealthNote = confirmationGateOn
    ? ', and <code>confirmation_gate</code>: the Confirmation gate mode in effect'
    : ''
  const tiktokOAuthHistoryNote = hasTikTok && !tiktokOAuthEnabled && !tiktokLinksOff
    ? ' Existing TikTok OAuth verifications remain recognized.'
    : ''
  const extraPlatformCodes = (hasYouTube ? ', <code>youtube</code>' : '') + (hasTikTok ? ', <code>tiktok</code>' : '')
  const otherOAuthStartExamples = [
    twitterOAuthEnabled && exampleValue !== 'twitter' ? `POST ${origin}/auth/twitter/start  {"pubkey":"hex64","start_check":"…"}` : '',
    youtubeOAuthEnabled && exampleValue !== 'youtube' ? `POST ${origin}/auth/youtube/start  {"pubkey":"hex64","start_check":"…"}` : '',
    hasTikTok && tiktokOAuthEnabled && exampleValue !== 'tiktok' ? `POST ${origin}/auth/tiktok/start  {"pubkey":"hex64","start_check":"…"}` : '',
  ].filter(Boolean).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Divine Identity Verification API</title>
  <meta name="description" content="The API reference for the Divine identity verification service: verify claims, read who is verified, and sign in to link accounts.">
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
      <h1>API reference<span class="punct">.</span></h1>
      <p class="subtitle">Check who is verified, verify a claim, or let people sign in to link an account. The page for people is at <a href="/">/</a>.</p>
    </div>

    <!-- API DOCS (for developers) -->
    <section id="api-about">
      <h2>About the API</h2>
      <p>This service verifies that a Nostr pubkey is linked to accounts on supported platforms. It fetches proof posts server-side, bypassing CORS restrictions that prevent browser-based verification.</p>
      <p>Two verification methods are supported:</p>
      <ul>
        <li><strong>Proof posts</strong> &mdash; User publishes a post containing their <code>npub</code> on the external platform. The service fetches the post and checks that the npub is present and the author matches.</li>
        <li><strong>OAuth login</strong> (${oauthNamesText}) &mdash; User authenticates directly. No proof post needed.</li>
      </ul>
    </section>

    <section id="platforms-api">
      <h2>Supported Platforms</h2>
      <table>
        <tr><th>Platform</th><th>Identity Format</th><th>Proof Format</th><th>OAuth</th></tr>
        <tr>
          <td><code>github</code></td>
          <td>Username (e.g., <code>octocat</code>)</td>
          <td>Gist ID</td>
          <td>No</td>
        </tr>
        <tr>
          <td><code>twitter</code></td>
          <td>Username (e.g., <code>example</code>)</td>
          <td>Tweet ID</td>
          <td>${twitterOAuthEnabled ? 'Yes' : 'No'}</td>
        </tr>
        <tr>
          <td><code>bluesky</code></td>
          <td>Handle (e.g., <code>example.bsky.social</code>)</td>
          <td>Post rkey</td>
          <td>${blueskyLinksOff ? 'No' : 'Yes'}</td>
        </tr>
        <tr>
          <td><code>mastodon</code></td>
          <td><code>instance/@user</code></td>
          <td>Status ID</td>
          <td>No</td>
        </tr>
        <tr>
          <td><code>telegram</code></td>
          <td>Username</td>
          <td><code>channel/messageId</code></td>
          <td>No</td>
        </tr>
        <tr>
          <td><code>discord</code></td>
          <td>Username</td>
          <td>Message link (needs <code>DISCORD_BOT_TOKEN</code>)</td>
          <td>No</td>
        </tr>
        ${ytTableRow}
        ${ttTableRow}
      </table>
    </section>

    <section id="single-verify">
      <h2>POST /api/verify &mdash; Single Claim Verification</h2>
      <p>Verify a single identity claim.</p>

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
        <tr><td><code>platform</code></td><td>string</td><td>One of: <code>github</code>, <code>twitter</code>, <code>bluesky</code>, <code>mastodon</code>, <code>telegram</code>, <code>discord</code>${extraPlatformCodes}</td></tr>
        <tr><td><code>identity</code></td><td>string</td><td>Username or handle on the platform</td></tr>
        <tr><td><code>proof</code></td><td>string</td><td>ID of the proof post</td></tr>
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

      <table>
        <tr><th>Field</th><th>Type</th><th>Description</th></tr>
        <tr><td><code>verified</code></td><td>boolean</td><td><code>true</code> if proof post contains the npub and the author matches</td></tr>
        <tr><td><code>error</code></td><td>string?</td><td>Error message (only when <code>verified</code> is <code>false</code>)</td></tr>
        <tr><td><code>code</code></td><td>string?</td><td>Stable machine-readable reason the claim isn't verified. <code>temporarily_unavailable</code> means the claim couldn't be checked right now (the platform didn't answer, or the per-person or per-platform check limit was hit), not that it was rejected: try again in a few minutes. <code>signin_expired</code> means no sign-in currently counts for an account linked by signing in (proof <code>oauth</code>): it lapsed, was unlinked, was never confirmed, never happened, or sign-in links for that platform are switched off. On Bluesky it also means no identity-link record was found on the account. <code>signin_account_changed</code> means the handle no longer points to the account that signed in (it was deleted, or now points to another account), or that account is no longer active. On Bluesky, when the handle points to another account, a proof post or identity-link record on that account is checked before this answer, and verifies the claim as usual. <code>signin_account_changed</code> also means, for a YouTube sign-in claimed by handle, that the claim spells the handle differently from the sign-in, beyond the letter case of A to Z. Apps can offer sign-in for either, where <code>GET /platforms</code> reports <code>oauth: true</code> for that platform. Discord values: <code>discord_invalid_proof_format</code>, <code>discord_dm_link</code>, <code>discord_channel_link</code>, <code>discord_invite_refused</code>, <code>discord_not_configured</code>, <code>discord_bot_no_access</code>, <code>discord_message_not_found</code>, <code>discord_api_error</code>, <code>discord_author_mismatch</code>, <code>discord_message_content_unavailable</code>, <code>discord_npub_not_in_message</code>.${confirmationCodeNote}</td></tr>
        <tr><td><code>canonical_proof</code></td><td>string?</td><td>Only when <code>verified</code> is <code>true</code> and the proof was resolved to a simpler stable form: a pasted post link was reduced to the part the check uses, or a TikTok link or share link to its post number. Publish this instead of the proof you sent.</td></tr>
        <tr><td><code>canonical_identity</code></td><td>string?</td><td>Only when <code>verified</code> is <code>true</code> and the account as sent was tidied (for example a leading @ removed, a YouTube handle sent without its @ returned with it, or a Mastodon handle sent as <code>@user@server</code> returned as <code>server/@user</code>), or confirmed on a different host from the one in the claim (Mastodon: a server whose handles use another domain from its website). Publish this instead of the account you sent; links to the post use it.</td></tr>
        <tr><td><code>checked_at</code></td><td>number</td><td>Unix timestamp (seconds)</td></tr>
        <tr><td><code>cached</code></td><td>boolean</td><td><code>true</code> if served from cache</td></tr>
      </table>
    </section>

    <section id="batch-verify">
      <h2>POST /verify &mdash; Batch Verification</h2>
      <p>Verify up to 10 claims in a single request. Results come back in the same order as the claims. A malformed claim, or one for an unsupported platform, comes back in its place as <code>"verified": false</code> with an <code>error</code>; it does not affect the other claims. The whole request is rejected with 400 only when the body itself is malformed, the claims list is empty, or it has more than 10 claims.</p>

      <h4>Request</h4>
      <pre>POST ${origin}/verify
Content-Type: application/json

{
  "claims": [
    { "platform": "github", "identity": "octocat", "proof": "aa5a315d61ae9438b18d", "pubkey": "7e7e..." },
    { "platform": "twitter", "identity": "example", "proof": "1234567890", "pubkey": "7e7e..." }
  ]
}</pre>

      <h4>Response (200 OK)</h4>
      <pre>{
  "results": [
    { "platform": "github", "identity": "octocat", "verified": true, "checked_at": 1709571048, "cached": false },
    { "platform": "twitter", "identity": "example", "verified": false, "error": "Tweet not found", "checked_at": 1709571048, "cached": false }
  ]
}</pre>
    </section>

    <section id="get-verify">
      <h2>GET /verify/:platform/:identity/:proof &mdash; URL-Based Verification</h2>
      <p>Verify via URL. Returns HTML for browsers, JSON for API clients. Add <code>?format=json</code> to force JSON.</p>

      <h4>Examples</h4>
      <pre>GET ${origin}/verify/github/octocat/aa5a315d61ae9438b18d?pubkey=7e7e9c42...4e
GET ${origin}/verify/mastodon/mastodon.social/@example/109876543210?pubkey=7e7e...4e</pre>
    </section>

    <section id="verified-api">
      <h2>GET /verified: What Is Verified Now</h2>
      <p>Two read-only endpoints answer who is verified, without a proof or a claim to send. They give the answers verify.divine.video gave, so callers that followed its redirect keep working. Both read a person's list of linked accounts from Nostr relays and check each link as it stands now, so an answer can take several seconds.</p>
      <p>Only links that verify now are listed: a sign-in confirmed within its ${FIXED_SIGNIN_LIFETIME_DAYS}-day lifetime, a live proof post, or Bluesky's identity-link record. A link that no longer verifies is left out.</p>

      <h3>GET /verified/:pubkey: One Person's Verified Accounts</h3>
      <h4>Request</h4>
      <pre>GET ${origin}/verified/7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e</pre>

      <h4>Response (200 OK)</h4>
      <pre>{
  "pubkey": "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e",
  "verifications": [
    {
      "platform": "github",
      "identity": "octocat",
      "method": "proof-post",
      "verified_at": 1709571048,
      "proof_url": "https://gist.github.com/octocat/aa5a315d61ae9438b18d"
    },
    {
      "platform": "x",
      "identity": "example",
      "method": "oauth",
      "verified_at": 1709571048,
      "proof_url": null
    }
  ],
  "unchecked": [
    { "platform": "mastodon", "identity": "mastodon.social/@example" }
  ]
}</pre>

      <table>
        <tr><th>Field</th><th>Type</th><th>Description</th></tr>
        <tr><td><code>platform</code></td><td>string</td><td>The platform, by the old names: <code>x</code> means Twitter. Every other platform keeps its name from the table above.</td></tr>
        <tr><td><code>identity</code></td><td>string</td><td>The account on that platform</td></tr>
        <tr><td><code>method</code></td><td>string</td><td><code>proof-post</code> (a post that carries the npub), <code>oauth</code> (a confirmed sign-in), or <code>identity_link</code> (Bluesky's identity-link record, which the old host had no name for)</td></tr>
        <tr><td><code>verified_at</code></td><td>number</td><td>Unix timestamp in seconds</td></tr>
        <tr><td><code>proof_url</code></td><td>string or null</td><td>A full link to the proof post. <code>null</code> when there is no post to link to, as for sign-ins and identity-link records, or when a verified proof does not contain enough information to build a post URL. verify.divine.video returned the raw proof value here, so callers that built their own link from it should use this link as is.</td></tr>
        <tr><td><code>unchecked</code></td><td>array</td><td><code>{ "platform", "identity" }</code> for links that could not be checked right now: a platform outage or time limit, the per-person or per-platform check limit, or the limit of 20 links checked per list. Treat these as unknown, not as removed.</td></tr>
      </table>

      <h3>GET /verified?platform=&amp;identity=: Who Owns an Account</h3>
      <p>Finds the person whose list links the account and whose link verifies now. It answers one owner, the most recently verified, chosen from at most 10 candidates. <code>platform</code> accepts <code>x</code> or <code>twitter</code> (any letter case) for Twitter; the answer names it <code>x</code>.</p>
      <p>This is a bounded, best-effort search, not a complete account index. Search and check limits can leave an owner unchecked; the result is then unknown. When no checked owner verifies and something was left unchecked, the lookup answers <code>503 temporarily_unavailable</code>, and repeating the same request need not resolve it. Clients should use bounded retries, keep the result unknown, and not treat it as removal of an existing badge.</p>
      <p>Relays match tags exactly, so for an owner who linked with a proof post, send the account the way their list spells it:<code>?identity=Alice</code> finds a list tagged <code>Alice</code> or <code>alice</code>, but <code>?identity=alice</code> does not find <code>Alice</code>. verify.divine.video ignored letter case here. Owners who linked by signing in are found in any letter case. YouTube channel IDs (<code>UC…</code>) are case-sensitive either way. A YouTube handle is found with or without its @.</p>
      <h4>Request</h4>
      <pre>GET ${origin}/verified?platform=x&amp;identity=example</pre>

      <h4>Response (200 OK)</h4>
      <pre>{
  "platform": "x",
  "identity": "example",
  "pubkey": "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e",
  "method": "oauth",
  "verified_at": 1709571048
}</pre>

      <h3>Errors</h3>
      <p>Every error has the same body, and the status says which kind:</p>
      <pre>{ "error": { "code": "not_found", "message": "no live verification for this platform identity" } }</pre>
      <table>
        <tr><th>Code</th><th>Status</th><th>Meaning</th></tr>
        <tr><td><code>invalid_pubkey</code></td><td>400</td><td>The pubkey is not 64 hex characters</td></tr>
        <tr><td><code>invalid_request</code></td><td>400</td><td><code>platform</code> or <code>identity</code> is missing, or <code>platform</code> is not a platform name either host knows</td></tr>
        <tr><td><code>not_found</code></td><td>404</td><td>No one verifies this account right now, the identity can't be checked, or the platform is one verify.divine.video listed that this verifier doesn't check (<code>instagram</code>, <code>snapchat</code>)</td></tr>
        <tr><td><code>rate_limited</code></td><td>429</td><td>The per-IP limit is spent; see Rate Limits below</td></tr>
        <tr><td><code>temporarily_unavailable</code></td><td>503</td><td>For <code>/verified/:pubkey</code>, Divine's relay or verifier storage could not be read; try again shortly. For the lookup, verifier storage failed while counting the request or reading records, or no owner checked out and something could not be checked, including candidates or tags left out by search and check limits; repeating the request may not change the answer.</td></tr>
      </table>
    </section>

    <section id="nip05">
      <h2>GET /nip05/verify &mdash; NIP-05 Verification</h2>
      <p>Check that a NIP-05 identifier resolves to a given pubkey.</p>

      <pre>GET ${origin}/nip05/verify?name=_@divine.video&amp;pubkey=7e7e9c42...4e</pre>

      <h4>Response</h4>
      <pre>{ "name": "_", "domain": "divine.video", "pubkey": "7e7e...", "verified": true, "checked_at": 1709571048, "cached": false }</pre>
    </section>

    <section id="oauth">
      <h2>OAuth Verification (${oauthNamesText})</h2>
      <p>${oauthIntro}</p>
      <p>The verifier page only reports sign-ins it started itself. A client starting its own sign-in keeps a random start secret (32 random bytes written as 43 base64url characters), sends its hash as <code>start_check</code>, and gets back the provider page to open. The sign-in returns to <code>return_url</code> (the verifier page, or the Divine app's return address) with a one-time code after the <code>#</code>. The link counts once the account owner sends that code, the start secret and their signed linked-accounts list to <code>/auth/confirm</code>.</p>
      <p>The new claim's tag carries a fourth value, <code>base64url(sha256('divine-signin-confirm:' + code + ':' + start_check))</code>. Both hashes in this flow (the start check and the binding) are SHA-256 over the UTF-8 text shown, meaning the 43-character strings and not the raw bytes, written as base64url without padding.</p>

      <h3>Start OAuth</h3>
      <pre>POST ${origin}/auth/${exampleValue}/start
Content-Type: application/json

${exampleBody}${otherOAuthStartExamples ? `\n\n${otherOAuthStartExamples}` : ''}</pre>
      <p>The answer is <code>{"url":"https://…"}</code>, the provider page to open.</p>
      <h3>Back from the sign-in</h3>
      <p>The sign-in returns to <code>return_url</code> with these added (any of them already there are replaced):</p>
      <ul>
        <li><code>platform</code> and <code>identity</code>: the account that signed in;</li>
        <li><code>oauth_confirm</code>: the one-time code, after the <code>#</code>, valid for 10 minutes;</li>
        <li><code>oauth_verified</code> (<code>true</code>): sent only while confirmation is optional, for app versions that can't confirm. Don't rely on it.</li>
      </ul>
      <p>A sign-in that didn't finish returns with <code>oauth_error</code>, a readable reason kept for older app versions (don't parse it), and <code>oauth_error_code</code>, a fixed value to branch on:</p>
      <ul>
        <li><code>cancelled</code>: the person cancelled or declined at the platform;</li>
        <li><code>provider_error</code>: the platform reported another error;</li>
        <li><code>failed</code>: the verifier couldn't check the account with the platform;</li>
        <li><code>update_required</code>: the sign-in was started with <code>GET /auth/:platform/start</code>, as older app versions do, which is no longer accepted;</li>
        <li><code>signin_unavailable</code>: sign-in links for this platform are switched off, so nothing was linked.</li>
      </ul>
      <p>Treat a code you don't know as <code>failed</code>. When the verifier can't tell where a sign-in started, or the sign-in fails unexpectedly, it returns to this page instead.</p>
      <h3>Confirm the sign-in</h3>
      <pre>POST ${origin}/auth/confirm
Content-Type: application/json

{"code":"&lt;code&gt;","start_secret":"&lt;secret&gt;","event":{…signed kind 10011…}}</pre>
      <p>The answer is <code style="overflow-wrap:anywhere;">{"linked":true,"platform":"bluesky","identity":"example.bsky.social"}</code>. The client then publishes the same event to relays. Errors carry a <code>code</code>:</p>
      <ul>
        <li><code>invalid_request</code> (400: a malformed <code>code</code> or <code>start_secret</code>);</li>
        <li><code>signin_not_found</code> (expired or not visible yet; retry briefly);</li>
        <li><code>signin_used</code>;</li>
        <li><code>signin_wrong_account</code>;</li>
        <li><code>signin_not_yours</code>;</li>
        <li><code>signin_claim_mismatch</code>;</li>
        <li><code>signin_unavailable</code> (403: sign-in links for this platform are switched off);</li>${confirmationRefusals}
        <li><code>invalid_event</code>.</li>
      </ul>

      <h3>Check OAuth Status</h3>
      <pre>GET ${origin}/auth/bluesky/status?pubkey=hex64&amp;identity=example.bsky.social</pre>

      <div class="note">A sign-in (OAuth) record is checked first, before cached results and proof posts, for ${oauthCheckedFor}. A sign-in counts only after you confirm it by publishing, and for ${FIXED_SIGNIN_LIFETIME_DAYS} days from when you confirmed it; after that, sign in again. A Bluesky sign-in claimed by handle also stops counting once the handle points to another account or no longer resolves. Bluesky's answer is reused for up to an hour, and while Bluesky can't answer, the link keeps counting. A claim of the account's DID must match the DID saved at sign-in. For a claim by handle or by DID, the account's host is also asked whether the account is still active, and a deleted, deactivated, suspended or taken-down account stops counting. That answer is reused for up to an hour (five minutes for an inactive account), and while the host can't answer, the link keeps counting.${youtubeAccountCheckNote}${tiktokOAuthHistoryNote}</div>
    </section>

    <section id="other">
      <h2>Other Endpoints</h2>
      <div class="endpoint">
        <h3><span class="method get">GET</span> <code>/platforms</code></h3>
        <p>List platforms currently available to clients. Twitter/X, Bluesky, YouTube (when listed), and TikTok each include an <code>oauth</code> field: <code>true</code> when sign-in is set up and switched on for that platform, <code>false</code> when only a proof post works. Each entry's <code>supported</code> is <code>false</code> when this deployment can't check that platform's proof posts, such as Discord without its bot token. Where sign-in is set up (<code>oauth</code> is <code>true</code>), the entry also includes <code>signin_expires_after_days</code>: how many days a confirmed sign-in link lasts.${confirmationPlatformsNote}</p>
      </div>
      <div class="endpoint">
        <h3><span class="method get">GET</span> <code>/health</code></h3>
        <p>Health check. Returns <code>{"status":"ok", ...}</code>, including <code>signin_confirmation</code>: <code>"optional"</code> or <code>"required"</code>, the sign-in confirmation mode in effect, and <code>signin_links_off</code>: the sign-in platforms whose links are switched off${confirmationHealthNote}.</p>
      </div>
    </section>

    <section id="rate-limits">
      <h2>Rate Limits &amp; Caching</h2>
      <table>
        <tr><th>Scope</th><th>Limit</th><th>Window</th></tr>
        <tr><td>Per IP</td><td>60 requests</td><td>1 minute</td></tr>
        <tr><td>Per IP</td><td>20 platform checks</td><td>1 minute</td></tr>
        <tr><td><code>/verified</code></td><td>Per IP, shared with the other endpoints</td><td>1 minute</td></tr>
        <tr><td>Per pubkey</td><td>20 verifications</td><td>1 minute</td></tr>
        <tr><td>Per platform</td><td>30 platform checks</td><td>1 minute</td></tr>
        <tr><td>Batch max</td><td>10 claims</td><td>per request</td></tr>
      </table>
      <p style="margin-top:0.75rem;">Verified claims are cached for 24 hours, failures for 15 minutes, and platform outages (<code>temporarily_unavailable</code>) for 5 minutes. Answers to the verifier's own rate limits aren't cached.</p>
    </section>

    <footer>
      <p>Part of <a href="https://divine.video">divine.video</a>. Open source. Own what you make.</p>
      <p><a href="https://divine.video/privacy">Privacy Policy</a> &middot; <a href="https://divine.video/terms">Terms of Service</a></p>
    </footer>
  </div>
</body>
</html>`
}
