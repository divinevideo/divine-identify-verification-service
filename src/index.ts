import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie } from 'hono/cookie'
import type { Bindings } from './types'
import health from './routes/health'
import platforms from './routes/platforms'
import { verified } from './routes/verified'
import verify from './routes/verify'
import nip05 from './routes/nip05'
import auth from './routes/auth'
import { EMBED_BRIDGE_SCRIPT } from './embed-bridge'
import { setPagePolicy } from './content-security-policy'
import { NOSTR_TOOLS_MODULE_PATH } from './generated/vendor'
import { FIXED_SIGNIN_LIFETIME_DAYS } from './oauth/signin-lifetime'
import { listInProse, oauthPlatformsFor, platformFlags } from './page-platforms'
import { PAGE_STYLES } from './page-styles'
import { SHARED_PAGE_SCRIPT } from './page-script-shared'
import { renderDocsPage } from './docs-page'
import { renderLookupPage } from './lookup-page'

const app = new Hono<{ Bindings: Bindings }>()

// Global error handler — prevent internal details from leaking
app.onError((err, c) => {
  console.error('Unhandled error:', err.message)
  return c.json({ error: 'Internal server error' }, 500)
})

// CORS middleware — restrict to known frontends
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}))

// Routes
app.route('/health', health)
app.route('/platforms', platforms)
app.route('/verify', verify)
app.route('/verified', verified)
app.route('/nip05', nip05)
app.route('/auth', auth)

// Alias: POST /api/verify → single claim verification (divine-web compatibility)
app.post('/api/verify', async (c) => {
  // Rewrite as a subrequest to /verify/single
  const url = new URL(c.req.url)
  url.pathname = '/verify/single'
  const newReq = new Request(url.toString(), c.req.raw)
  return app.fetch(newReq, c.env)
})
// HEAD /api/health — divine-web health check
app.get('/api/health', (c) => {
  if (c.req.method === 'HEAD') {
    return c.body(null, 200)
  }
  return c.json({ status: 'ok' })
})

// The Divine mark, the same favicon divine-web serves. App directories derive an
// entry's icon from `${origin}/favicon.ico`, so a 404 there reached clients as a
// failed image load. A transparent pixel would stop the 404 but render the tile
// blank, so this serves the real icon, which also fixes it in browser tabs.
const FAVICON_PNG = Uint8Array.from(
  atob(
    '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',
  ),
  (character) => character.charCodeAt(0),
)

app.get('/favicon.ico', (c) =>
  c.body(FAVICON_PNG, 200, {
    'content-type': 'image/png',
    'cache-control': 'public, max-age=86400',
  }),
)

// Root — landing page
app.get('/', (c) => {
  const accept = c.req.header('accept') || ''
  if (accept.includes('application/json') && !accept.includes('text/html')) {
    return c.json({ service: 'divine-identity-verification-service', version: '1.0.0' })
  }

  const requestUrl = new URL(c.req.url)
  const origin = requestUrl.origin
  // TODO(#39): Enable the production UI after TikTok OAuth is approved.
  // The review cookie survives OAuth redirects without changing their exact
  // registered redirect URI, while ordinary users stay off the sandbox flow.
  const tiktokOAuthReviewRequested = requestUrl.searchParams.get('tiktok_oauth_review') === '1'
  if (tiktokOAuthReviewRequested) {
    setCookie(c, 'tiktok_oauth_review', '1', {
      httpOnly: true,
      maxAge: 3600,
      path: '/',
      sameSite: 'Lax',
      secure: requestUrl.protocol === 'https:',
    })
  }
  const tiktokOAuthReviewEnabled = tiktokOAuthReviewRequested
    || getCookie(c, 'tiktok_oauth_review') === '1'
  const flags = platformFlags(c.env, tiktokOAuthReviewEnabled)
  const { hasYouTube, hasTikTok, twitterOAuthEnabled, youtubeOAuthEnabled, tiktokOAuthEnabled } = flags

  // Sign-in platforms, in picker order (see oauthPlatformsFor).
  const oauthPlatforms = oauthPlatformsFor(flags)
  const quickConnectPlatformList = listInProse(oauthPlatforms.map(platform => platform.shortLabel))
  // Platforms verified only by pasting a post link: the always post-only ones,
  // plus Twitter, YouTube and TikTok while their sign-in is unavailable.
  const proofPostOnlyPlatformList = listInProse([
    ...(twitterOAuthEnabled ? [] : ['Twitter']),
    'GitHub', 'Mastodon', 'Telegram', 'Discord',
    ...(hasYouTube && !youtubeOAuthEnabled ? ['YouTube'] : []),
    ...(hasTikTok && !tiktokOAuthEnabled ? ['TikTok'] : []),
  ])
  // The platform list near the top of the page. Each pill links to the card
  // where that platform can be linked: Quick Connect when its sign-in is set
  // up, the post form otherwise. The page script also picks the platform in
  // that card's picker (pickPlatformFromPill).
  const quickConnectValues = new Set(oauthPlatforms.map(platform => platform.value))
  const platformPills = [
    { value: 'twitter', label: 'Twitter / X', icon: '<svg viewBox="0 0 24 24" fill="#333"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>' },
    { value: 'github', label: 'GitHub', icon: '<svg viewBox="0 0 24 24" fill="#333"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>' },
    { value: 'bluesky', label: 'Bluesky', icon: '<svg viewBox="0 0 24 24" fill="#333"><path d="M12 2C7.8 5.4 5 9 5 11.5c0 2.5 1.2 3.6 2.5 3.8-1 .3-3.5 1-2.5 3.2.7 1.5 3.5 1.5 5 .5 1-.7 1.7-1.7 2-2.7.3 1 1 2 2 2.7 1.5 1 4.3 1 5-.5 1-2.2-1.5-2.9-2.5-3.2 1.3-.2 2.5-1.3 2.5-3.8 0-2.5-2.8-6.1-7-9.5z"/></svg>' },
    { value: 'mastodon', label: 'Mastodon', icon: '<svg viewBox="0 0 24 24" fill="#333"><path d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 00.023-.043v-1.809a.052.052 0 00-.02-.041.053.053 0 00-.046-.01 20.282 20.282 0 01-4.709.547c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 01-.319-1.433.053.053 0 01.066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.668 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z"/></svg>' },
    { value: 'telegram', label: 'Telegram', icon: '<svg viewBox="0 0 24 24" fill="#333"><path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>' },
    { value: 'discord', label: 'Discord', icon: '<svg viewBox="0 0 24 24" fill="#333"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1569 2.4189z"/></svg>' },
    ...(hasYouTube ? [{ value: 'youtube', label: 'YouTube', icon: '<svg viewBox="0 0 24 24" fill="#333"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>' }] : []),
    ...(hasTikTok ? [{ value: 'tiktok', label: 'TikTok', icon: '<svg viewBox="0 0 24 24" fill="#333"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>' }] : []),
  ].map(platform => quickConnectValues.has(platform.value)
    ? `<a class="platform-pill" href="#quick-connect" data-platform="${platform.value}" aria-label="Link ${platform.label} by signing in">${platform.icon} ${platform.label}</a>`
    : `<a class="platform-pill" href="#link-with-post" data-platform="${platform.value}" aria-label="Link ${platform.label} with a post">${platform.icon} ${platform.label}</a>`,
  ).join('\n      ')
  // Every confirmed sign-in link lasts the same time, so the sign-in card says
  // it once, before the person starts.
  const signInLifetimeCardNote = `<p class="field-help">Links made by signing in last ${FIXED_SIGNIN_LIFETIME_DAYS} days. After that, sign in again to keep them verified.</p>`
  const oauthPlatformOptions = oauthPlatforms.map(platform => `<option value="${platform.value}">${platform.optionLabel}</option>`).join('')
  const proofPlatformOptions = `<option value="github">GitHub</option><option value="twitter">Twitter / X</option><option value="bluesky">Bluesky</option><option value="mastodon">Mastodon</option><option value="telegram">Telegram</option><option value="discord">Discord</option>${hasYouTube ? '<option value="youtube">YouTube</option>' : ''}${hasTikTok ? '<option value="tiktok">TikTok</option>' : ''}`

  const cspNonce = setPagePolicy(c)
  // The page holds a sign-in's one-time code in its address for a moment;
  // never send its address to other sites.
  c.header('Referrer-Policy', 'no-referrer')
  // TODO(#39): Remove cookie variance when the OAuth reviewer override is retired.
  c.header('Vary', 'Cookie')
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Divine Identity Verification — Prove You Are Who You Say You Are</title>
  <meta name="description" content="Verify your identity across platforms. Link your Twitter, GitHub, Bluesky, Mastodon, and more to your Nostr profile to prevent impersonation and build trust.">
  <meta property="og:title" content="Divine Identity Verification">
  <meta property="og:description" content="Prove you are who you say you are. Link your social accounts to your Nostr identity to prevent impersonation.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${origin}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Inter:wght@400;500;600;700&display=swap">
  <style>
${PAGE_STYLES}
  </style>
</head>
<body>
  <div class="container">

    <!-- TOP BAR -->
    <nav class="topbar">
      <a class="brand" href="/"><span class="logomark" aria-hidden="true"></span><span>Divine Identity</span></a>
      <div class="nav-actions">
        <a class="nav-link" href="/lookup">Look up</a>
        <a class="nav-link" href="#how-to-verify">Get verified</a>
        <a class="nav-link" href="https://divine.video">divine.video</a>
      </div>
    </nav>

    <!-- HERO -->
    <div class="hero">
      <h1>Prove it's really you<span class="punct">.</span></h1>
      <p class="subtitle">Link your social accounts to your <a href="https://divine.video">Divine</a> profile so people know it's actually you. Like a verified badge &mdash; but one you own, and anyone can check.</p>
      <div class="cta-row">
        <a href="#how-to-verify" class="btn btn-primary">Get verified</a>
        <a href="#manage" class="btn btn-outline">Manage my links</a>
      </div>
    </div>

    <!-- WHY VERIFY -->
    <div class="value-grid">
      <div class="value-card">
        <div class="icon">&#128274;</div>
        <h3>Stop Impersonation</h3>
        <p>Anyone can copy your name and photo on a new platform. When you verify, you create a link between your accounts that nobody else can fake &mdash; because only you can post from your real accounts.</p>
      </div>
      <div class="value-card">
        <div class="icon">&#9989;</div>
        <h3>Build Trust</h3>
        <p>When someone finds your Divine profile, they can see that your Twitter, GitHub, Bluesky, and other accounts are all confirmed to be you. No guessing, no doubt.</p>
      </div>
      <div class="value-card">
        <div class="icon">&#127760;</div>
        <h3>You're in Control</h3>
        <p>Unlike platform-specific blue checkmarks, these verifications don't depend on any company. They're open, transparent, and portable &mdash; they go wherever you go.</p>
      </div>
    </div>

    <!-- SUPPORTED PLATFORMS -->
    <div style="text-align:center;margin:2.25rem 0 1rem;">
      <h3 style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--mint);">Pick the account you want to link</h3>
    </div>
    <div class="platform-grid">
      ${platformPills}
    </div>

    <!-- HOW IT WORKS -->
    <section id="how-it-works">
      <h2>How Does It Work?</h2>
      <p>Think of it like a handshake between two accounts:</p>
      <ul>
        <li><strong>Your Divine profile says</strong> "I'm @example on Twitter"</li>
        <li><strong>Your Twitter account confirms</strong> "Yes, that Divine profile is mine"</li>
      </ul>
      <p>We check both sides automatically. If they match, you're verified. The beauty of this system is that <strong>nobody can fake it</strong> &mdash; an impersonator might copy your name and photo, but they can't post from your real Twitter account.</p>
      <p>This is the same approach used by <a href="https://keybase.io">Keybase</a> &mdash; a proven method for cross-platform identity verification, now available for Divine and the broader Nostr ecosystem.</p>
    </section>

    <!-- HOW TO VERIFY -->
    <section id="how-to-verify">
      <h2>How to Get Verified</h2>
      <p>It takes a minute or two. You're showing that your Divine account and your other account belong to the same person.</p>

      <div class="steps">
        <div class="step">
          <div class="step-number">1</div>
          <h4>Sign in</h4>
          <p>Use your Divine login, or connect your Nostr signer, in <a href="#verify-here">Verify Here</a>. You need it to add the link to your profile.</p>
        </div>
        <div class="step">
          <div class="step-number">2</div>
          <h4>Link your account</h4>
          <p>For ${quickConnectPlatformList}, sign in to it from this page. For ${proofPostOnlyPlatformList}, post your npub there, then paste the link to that post.</p>
        </div>
        <div class="step">
          <div class="step-number">3</div>
          <h4>Publish</h4>
          <p>Press Publish to add the link to your profile. Nothing shows on your profile until you do.</p>
        </div>
        <div class="step">
          <div class="step-number">4</div>
          <h4>Done</h4>
          <p>A checkmark shows up next to the account on your Divine profile. Anyone can click it to check the link is real.</p>
        </div>
      </div>
    </section>

    <section id="verify-here" class="verify-here">
      <h2>Verify Here</h2>
      <p class="verify-lead">Sign in, link your account one of two ways, then publish.</p>

      <div class="verify-card">
        <span class="step-pill">Step 1</span>
        <h3 style="margin-top:0;">Sign in with your Divine login</h3>
        <div id="step1-signin-options">
          <p>Use the login you use for Divine. Already use a Nostr signer? Connect it instead.</p>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.6rem;">
            <button id="connect-keycast-btn" class="verify-btn verify-btn-primary" type="button">Sign in with Divine login</button>
            <button id="connect-nostr-btn" class="verify-btn" type="button">Use a Nostr extension</button>
          </div>
          <label for="verify-pubkey-input" class="field-label">Your Divine account (filled in when you sign in)</label>
          <input id="verify-pubkey-input" class="field-input" type="text" readonly placeholder="Filled in when you sign in">
        </div>
        <p id="signer-session-summary" class="field-help" style="display:none;"></p>
        <div id="step1-remote-signer-options">
          <details class="advanced-proof" id="remote-signer-details" style="margin-top:0.75rem;">
            <summary>Remote signer options: bunker and Nostr Connect</summary>
            <div class="advanced-proof-inner">
              <p style="margin-bottom:0.75rem;">Paste a bunker URL or bunker NIP-05, or generate a Nostr Connect URI for your signer app.</p>
              <label for="bunker-input" class="field-label">Bunker URL or bunker NIP-05</label>
              <input id="bunker-input" class="field-input" type="text" placeholder="bunker://... or signer@example.com">
              <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.75rem;">
                <button id="connect-bunker-btn" class="verify-btn" type="button">Connect bunker</button>
                <button id="start-nostr-connect-btn" class="verify-btn" type="button">Start Nostr Connect</button>
              </div>
              <div id="nostr-connect-wrap" style="display:none;margin-top:0.85rem;">
                <label for="nostr-connect-uri-input" class="field-label">Nostr Connect URI</label>
                <textarea id="nostr-connect-uri-input" class="field-input" rows="3" readonly style="min-height:6.5rem;resize:vertical;"></textarea>
                <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.75rem;">
                  <button id="copy-nostr-connect-btn" class="verify-btn" type="button">Copy URI</button>
                  <a id="open-nostr-connect-link" class="verify-btn" href="#" rel="noopener noreferrer">Open signer app</a>
                  <button id="cancel-nostr-connect-btn" class="verify-btn" type="button">Cancel</button>
                </div>
                <p class="field-help" style="margin-top:0.5rem;">Open this URI in your signer app, or copy it into a bunker / Nostr Connect client.</p>
              </div>
            </div>
          </details>
        </div>
        <div id="verify-login-status" class="status-row"></div>
        <div id="verify-global-status" class="status-row"></div>
      </div>

      <span class="step-pill verify-step-gap">Step 2</span>
      <h3 style="margin-top:0;">Link your account. Pick one.</h3>
      <!-- Post first while Quick Connect covers only Bluesky: a post works for
           every platform. Revisit the order as other sign-ins turn on. -->
      <div class="verify-step-grid">
        <div class="verify-card" id="link-with-post">
          <span class="step-pill">Link with a post</span>
          <h4>Link with a post</h4>
          <p style="margin-bottom:0.75rem;">Works for every platform. Post your npub publicly on the account you want to link, then paste the link to that post here.</p>
          <label for="proof-platform-select" class="field-label">Platform</label>
          <select id="proof-platform-select" class="field-select">
            ${proofPlatformOptions}
          </select>
          <label for="proof-identity-input" class="field-label">Your account name on that platform</label>
          <input id="proof-identity-input" class="field-input" type="text" placeholder="e.g. octocat or example.bsky.social">
          <label id="proof-label" for="proof-proof-input" class="field-label">Post link or proof ID</label>
          <input id="proof-proof-input" class="field-input" type="text" placeholder="Paste full post URL or just the ID">
          <p id="proof-helper" class="field-help">Tip: for Twitter and Bluesky, paste the full post URL.</p>
          <button id="proof-verify-btn" class="verify-btn verify-btn-success" type="button">Verify this link</button>
          <div id="proof-status" class="status-row"></div>
          <pre id="proof-result" style="display:none;margin-top:0.75rem;"></pre>
        </div>

        <div class="verify-card" id="quick-connect">
          <span class="step-pill">Quick Connect</span>
          <h4>Sign in, no posting</h4>
          <p>Works for ${quickConnectPlatformList}. Sign in to the account you want to link.</p>
          ${signInLifetimeCardNote}
          <p id="oauth-platform-help" class="field-help">For ${proofPostOnlyPlatformList}, <a href="#link-with-post">link with a post instead</a>.</p>
          <label for="oauth-platform-select" class="field-label">Platform</label>
          <select id="oauth-platform-select" class="field-select" aria-describedby="oauth-platform-help">
            ${oauthPlatformOptions}
          </select>
          <div id="oauth-bluesky-handle-wrap" style="display:none;">
            <label for="oauth-bluesky-handle-input" class="field-label">Bluesky handle</label>
            <input id="oauth-bluesky-handle-input" class="field-input" type="text" placeholder="example.bsky.social">
          </div>
          <button id="oauth-start-btn" class="verify-btn verify-btn-primary" type="button">Continue to secure sign-in</button>
          <div id="oauth-status" class="status-row"></div>
        </div>
      </div>

      <div class="verify-card verify-step-gap" id="publish-step">
        <span class="step-pill">Step 3</span>
        <h3 style="margin-top:0;">Publish to your profile</h3>
        <p>Nothing shows on your profile until you publish. Needs you to be signed in (Step 1).</p>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.75rem;">
          <button id="publish-kind0-btn" class="verify-btn verify-btn-primary" type="button">Publish to my profile</button>
        </div>
        <p class="field-help" style="margin-top:0.5rem;">This updates the linked accounts on your Nostr profile (NIP-39).</p>
        <div id="publish-status" class="status-row"></div>
      </div>
    </section>

    <!-- MANAGE LINKED VERIFICATIONS -->
    <section id="manage" style="box-shadow: 6px 6px 0 var(--violet);">
      <h2>Manage verified links</h2>
      <p>View and remove your linked identity verifications. You need to be signed in (Verify Here, Step 1).</p>
      <button id="load-links-btn" class="verify-btn verify-btn-primary" type="button">Load my links</button>
      <div id="manage-links-container" style="margin-top:1rem;"></div>
      <div id="manage-status" class="status-row"></div>
      <button id="retry-revoke-btn" class="verify-btn" type="button" hidden>Retry sign-in record removal</button>
      <div id="remove-confirm-dialog" style="display:none;margin-top:1rem;padding:16px;background:rgba(255,127,175,0.18);border:2px solid var(--dark);border-radius:16px;">
        <h4 style="margin-bottom:0.5rem;color:var(--dark);">Remove this verification?</h4>
        <p>This unlinks <strong id="remove-confirm-claim"></strong> from your Nostr profile.</p>
        <p class="field-help">Relay updates may take a short moment.</p>
        <div style="display:flex;gap:10px;margin-top:0.75rem;flex-wrap:wrap;">
          <button id="remove-cancel-btn" class="verify-btn" type="button">Cancel</button>
          <button id="remove-confirm-btn" class="verify-btn" type="button" style="background:var(--pink);color:var(--dark);">Remove verification</button>
        </div>
      </div>
    </section>

    <!-- API REFERENCE LINK -->
    <section id="api-link">
      <p>Checking whether a profile is real? <a href="/lookup">Look up someone</a>.</p>
      <p>Building on this service? The API reference is at <a href="/docs">/docs</a>.</p>
    </section>

    <script nonce="${cspNonce}">
    // Old links still point at sections that moved: #check to /lookup, and the
    // API reference anchors to /docs (the anchor is kept so /docs scrolls to
    // it). A link with a query is a sign-in coming back and must finish here,
    // so it is never forwarded. Kept so saved links keep working.
    (function forwardMovedSectionLinks() {
      if (window.location.search) return;
      var hash = window.location.hash;
      // Bare ids, not '#id' strings: the page-script guard in docs-page.test.ts
      // treats a '#id' literal as a live reference to an element that moved.
      var movedToDocs = ['api-about', 'platforms-api', 'single-verify', 'batch-verify', 'get-verify', 'nip05', 'oauth', 'other', 'rate-limits'];
      if (hash === '#check') {
        window.location.replace('/lookup');
      } else if (movedToDocs.indexOf(hash.slice(1)) !== -1) {
        window.location.replace('/docs' + hash);
      }
    })();

    // Install a postMessage-based window.nostr (NIP-07) shim when this page
    // is loaded inside an iframe of a trusted Divine origin. The host
    // (divine.video) honors signEvent / getPublicKey / getRelays requests
    // using whichever signer the user has attached to their Divine session,
    // so the embedded verifyer flow does not require its own login.
    ${EMBED_BRIDGE_SCRIPT}

    const API = '${origin}';
    const KEYCAST_BASE = 'https://login.divine.video';
    const KEYCAST_CLIENT_ID = 'Divine Identity Verification';
    const KEYCAST_SCOPE = 'policy:social';
    const KEYCAST_SESSION_KEY = 'verifyer_keycast_session_v1';
    const KEYCAST_PKCE_KEY = 'verifyer_keycast_pkce_v1';
    const KEYCAST_STATE_KEY = 'verifyer_keycast_state_v1';
    const KEYCAST_HASH_KEY = 'verifyer_keycast_hash_v1';
    // The verifier serves this itself (public/vendor), built from the pinned nostr-tools.
    const NOSTR_TOOLS_URL = '${NOSTR_TOOLS_MODULE_PATH}';
    // NIP-46 traffic needs relays that accept kind 24133 events.
    const REMOTE_SIGNER_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social', 'wss://relay.primal.net'];
    let signerPubkeyHex = null;
    let activeSigner = null;
    let activeSignerSource = null;
    let nostrToolsPromise = null;
    let nostrToolsFailures = 0;
    // The Nostr Connect request waiting for the signer's approval, if any.
    let nostrConnectAttempt = null;

${SHARED_PAGE_SCRIPT}

    function signerSourceLabel(source) {
      if (source === 'browser') return 'your Nostr extension';
      if (source === 'embedded') return 'your Divine account';
      if (source === 'keycast') return 'your Divine login';
      if (source === 'bunker') return 'bunker';
      if (source === 'nostrconnect') return 'Nostr Connect';
      return '';
    }

    function updateSignerSummary() {
      // Inside the Divine app you're signed in through the app, so Step 1 shows
      // just that, without the other ways to sign in.
      const signedInThroughApp = !!(window.__divineEmbedded && activeSigner && activeSignerSource === 'embedded');
      for (const id of ['step1-signin-options', 'step1-remote-signer-options']) {
        const options = document.getElementById(id);
        if (options) options.hidden = signedInThroughApp;
      }
      const el = document.getElementById('signer-session-summary');
      if (!el) return;
      const parts = [];
      if (activeSignerSource) {
        parts.push('Connected via ' + signerSourceLabel(activeSignerSource) + '.');
      }
      if (signerPubkeyHex) {
        parts.push('Active key: ' + signerPubkeyHex.slice(0, 12) + '...' + signerPubkeyHex.slice(-8));
      }
      if (parts.length === 0) {
        el.style.display = 'none';
        el.textContent = '';
        return;
      }
      el.style.display = 'block';
      el.textContent = parts.join(' ');
    }

    function isBrowserSignerAvailable() {
      return !!window.nostr &&
        typeof window.nostr.getPublicKey === 'function' &&
        typeof window.nostr.signEvent === 'function';
    }

    function createBrowserSigner() {
      return {
        async getPublicKey() {
          return (await window.nostr.getPublicKey()).toLowerCase();
        },
        async signEvent(event) {
          return await window.nostr.signEvent(event);
        },
      };
    }

    async function maybeCloseSigner(signer) {
      if (!signer) return;
      if (typeof signer.close === 'function') {
        try {
          await signer.close();
        } catch {}
      }
    }

    async function activateSigner(signer, source, successMessage) {
      const pubkey = String(await signer.getPublicKey()).toLowerCase();
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
        throw new Error('Signer returned an invalid pubkey.');
      }
      const previousSigner = activeSigner;
      activeSigner = signer;
      activeSignerSource = source;
      signerPubkeyHex = pubkey;
      setAccountInputValue(pubkey);
      updateSignerSummary();
      if (previousSigner && previousSigner !== signer) {
        await maybeCloseSigner(previousSigner);
      }
      if (successMessage) {
        setStatus('verify-login-status', successMessage, 'ok');
      }
      return pubkey;
    }

    function bytesToBase64Url(bytes) {
      let binary = '';
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
    }

    function randomBase64Url(size) {
      const bytes = new Uint8Array(size);
      crypto.getRandomValues(bytes);
      return bytesToBase64Url(bytes);
    }

    async function sha256Base64Url(text) {
      const data = new TextEncoder().encode(text);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
      return bytesToBase64Url(digest);
    }

    async function createKeycastPkce() {
      const verifier = randomBase64Url(32);
      const challenge = await sha256Base64Url(verifier);
      return { verifier: verifier, challenge: challenge };
    }

    function getKeycastRedirectUrl() {
      return window.location.origin + window.location.pathname;
    }

    function normalizeStoredKeycastSession(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const accessToken = raw.accessToken || raw.access_token || '';
      if (!accessToken) return null;
      const expiresAt = raw.expiresAt || (raw.expires_in ? Date.now() + Number(raw.expires_in) * 1000 : null);
      return {
        accessToken: accessToken,
        refreshToken: raw.refreshToken || raw.refresh_token || '',
        bunkerUrl: raw.bunkerUrl || raw.bunker_url || '',
        authorizationHandle: raw.authorizationHandle || raw.authorization_handle || '',
        expiresAt: expiresAt || null,
      };
    }

    function loadKeycastSession() {
      try {
        return normalizeStoredKeycastSession(JSON.parse(localStorage.getItem(KEYCAST_SESSION_KEY) || 'null'));
      } catch {
        return null;
      }
    }

    function saveKeycastSession(session) {
      localStorage.setItem(KEYCAST_SESSION_KEY, JSON.stringify(session));
    }

    function clearKeycastSession() {
      localStorage.removeItem(KEYCAST_SESSION_KEY);
    }

    function clearKeycastFlowState() {
      sessionStorage.removeItem(KEYCAST_PKCE_KEY);
      sessionStorage.removeItem(KEYCAST_STATE_KEY);
      sessionStorage.removeItem(KEYCAST_HASH_KEY);
    }

    function shouldRefreshKeycastSession(session) {
      return !!session &&
        !!session.refreshToken &&
        !!session.expiresAt &&
        Date.now() >= Number(session.expiresAt) - 5 * 60 * 1000;
    }

    function hasExpiredKeycastSession(session) {
      return !!session && !!session.expiresAt && Date.now() >= Number(session.expiresAt);
    }

    async function postKeycastTokenRequest(body) {
      const resp = await fetch(KEYCAST_BASE + '/api/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = {};
      try {
        data = await resp.json();
      } catch {}
      if (!resp.ok) {
        throw new Error(data.error_description || data.error || 'login.divine.video token exchange failed.');
      }
      return data;
    }

    async function getValidKeycastSession(session) {
      let nextSession = session || loadKeycastSession();
      if (!nextSession) return null;
      if (shouldRefreshKeycastSession(nextSession)) {
        let refreshed;
        try {
          refreshed = await postKeycastTokenRequest({
            grant_type: 'refresh_token',
            refresh_token: nextSession.refreshToken,
            client_id: KEYCAST_CLIENT_ID,
          });
        } catch (err) {
          clearKeycastSession();
          throw err;
        }
        nextSession = normalizeStoredKeycastSession(refreshed);
        if (!nextSession) throw new Error('login.divine.video returned an unusable session.');
        saveKeycastSession(nextSession);
        return nextSession;
      }
      if (hasExpiredKeycastSession(nextSession)) {
        clearKeycastSession();
        return null;
      }
      return nextSession;
    }

    async function callKeycastRpc(sessionRef, method, params) {
      sessionRef.session = await getValidKeycastSession(sessionRef.session);
      if (!sessionRef.session || !sessionRef.session.accessToken) {
        throw new Error('Your Divine login has expired. Sign in again.');
      }
      const resp = await fetch(KEYCAST_BASE + '/api/nostr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + sessionRef.session.accessToken,
        },
        body: JSON.stringify({ method: method, params: params }),
      });
      let data = {};
      try {
        data = await resp.json();
      } catch {}
      if (!resp.ok) {
        throw new Error(data.error || data.message || 'login.divine.video signer request failed.');
      }
      if (!data || data.result === undefined) {
        throw new Error('login.divine.video signer returned no result.');
      }
      return data.result;
    }

    function createKeycastSigner(session) {
      const sessionRef = { session: session };
      return {
        async getPublicKey() {
          return await callKeycastRpc(sessionRef, 'get_public_key', []);
        },
        async signEvent(event) {
          return await callKeycastRpc(sessionRef, 'sign_event', [event]);
        },
      };
    }

    function showNostrConnectUi(uri) {
      const wrap = document.getElementById('nostr-connect-wrap');
      const input = document.getElementById('nostr-connect-uri-input');
      const link = document.getElementById('open-nostr-connect-link');
      if (!wrap || !input || !link) return;
      wrap.style.display = 'block';
      input.value = uri;
      link.href = uri;
      document.getElementById('remote-signer-details').open = true;
    }

    function hideNostrConnectUi() {
      const wrap = document.getElementById('nostr-connect-wrap');
      const input = document.getElementById('nostr-connect-uri-input');
      const link = document.getElementById('open-nostr-connect-link');
      if (wrap) wrap.style.display = 'none';
      if (input) input.value = '';
      if (link) link.href = '#';
    }

    async function loadNostrTools() {
      if (!nostrToolsPromise) {
        // A browser can keep a failed module load and return it again for the
        // same address, so each try after a failure asks for a new one.
        nostrToolsPromise = import(nostrToolsFailures ? NOSTR_TOOLS_URL + '&retry=' + nostrToolsFailures : NOSTR_TOOLS_URL);
        // Forget a failed import so the next call imports again.
        nostrToolsPromise.catch(function() { nostrToolsPromise = null; nostrToolsFailures++; });
      }
      return await nostrToolsPromise;
    }

    function extractHexFromText(text) {
      const match = (text || '').match(/([0-9a-fA-F]{64})/);
      return match ? match[1].toLowerCase() : null;
    }

    function extractNpubFromText(text) {
      const match = (text || '').toLowerCase().match(/(npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)/);
      return match ? match[1] : null;
    }

    function setAccountInputValue(value) {
      const inputEl = document.getElementById('verify-pubkey-input');
      if (!inputEl) return;
      inputEl.value = value;
    }

    function inferLoginQueryPubkey(params) {
      const keys = ['npub', 'pubkey', 'nostr_pubkey', 'key'];
      for (const key of keys) {
        const value = params.get(key);
        if (!value) continue;
        const hex = extractHexFromText(value);
        if (hex) return hex;
        const npub = extractNpubFromText(value);
        if (npub) return npubToHex(npub);
      }
      return null;
    }

    function applyLoginQueryHint() {
      const params = new URLSearchParams(window.location.search);
      const hintPubkey = inferLoginQueryPubkey(params);
      if (!hintPubkey) return;
      signerPubkeyHex = hintPubkey;
      activeSignerSource = null;
      setAccountInputValue(hintPubkey);
      updateSignerSummary();
      setStatus('verify-login-status', 'Logged in. Nostr key detected from return URL.', 'ok');
      params.delete('npub');
      params.delete('pubkey');
      params.delete('nostr_pubkey');
      params.delete('key');
      const cleanUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    }

    async function connectBrowserSigner() {
      const browserSigner = createBrowserSigner();
      // Inside the Divine app's frame, window.nostr is the app signing for the
      // person's Divine account, not an extension they installed.
      const embedded = !!window.__divineEmbedded;
      const signerName = embedded ? 'your Divine account' : 'your Nostr extension';
      // NIP-98: sign for the exact URL the event is sent to.
      const loginUrl = API + '/auth/nostr/login';
      const unsignedEvent = {
        kind: 27235,
        content: '',
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['u', loginUrl],
          ['method', 'POST'],
        ],
      };

      setStatus('verify-login-status', 'Requesting a signature from ' + signerName + '...', 'loading');
      const signedEvent = await browserSigner.signEvent(unsignedEvent);
      if (!signedEvent || typeof signedEvent !== 'object') {
        throw new Error('Signer did not return a valid login event.');
      }

      setStatus('verify-login-status', 'Checking your signature...', 'loading');
      const resp = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: signedEvent }),
      });
      const data = await resp.json();
      if (!resp.ok || !data || !data.pubkey) {
        throw new Error((data && data.error) || 'Nostr login failed.');
      }

      const loginPubkey = String(data.pubkey).toLowerCase();
      const signerPubkey = await browserSigner.getPublicKey();
      if (loginPubkey !== signerPubkey) {
        throw new Error(embedded
          ? "The sign-in didn't match your Divine account. Try again."
          : "The sign-in didn't match the account in your Nostr extension. Try again.");
      }

      await activateSigner(browserSigner, embedded ? 'embedded' : 'browser', 'Signed in with ' + signerName + '.');
    }

    async function startKeycastLogin() {
      const pkce = await createKeycastPkce();
      const state = randomBase64Url(24);
      sessionStorage.setItem(KEYCAST_PKCE_KEY, JSON.stringify(pkce));
      sessionStorage.setItem(KEYCAST_STATE_KEY, state);
      sessionStorage.setItem(KEYCAST_HASH_KEY, window.location.hash || '#verify-here');

      const session = loadKeycastSession();
      const url = new URL(KEYCAST_BASE + '/api/oauth/authorize');
      url.searchParams.set('client_id', KEYCAST_CLIENT_ID);
      url.searchParams.set('redirect_uri', getKeycastRedirectUrl());
      url.searchParams.set('scope', KEYCAST_SCOPE);
      url.searchParams.set('code_challenge', pkce.challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', state);
      url.searchParams.set('default_register', 'true');
      if (session && session.authorizationHandle) {
        url.searchParams.set('authorization_handle', session.authorizationHandle);
      }
      window.location.href = url.toString();
    }

    function cleanKeycastCallbackParams() {
      const params = new URLSearchParams(window.location.search);
      params.delete('code');
      params.delete('state');
      params.delete('error');
      params.delete('error_description');
      const nextHash = sessionStorage.getItem(KEYCAST_HASH_KEY) || window.location.hash;
      const cleanUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + (nextHash || '');
      window.history.replaceState({}, '', cleanUrl);
      clearKeycastFlowState();
    }

    async function maybeHandleKeycastCallback() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const error = params.get('error');
      if (!code && !error) return false;

      clearStatus('verify-global-status');
      setStatus('verify-login-status', 'Finishing your Divine login...', 'loading');
      try {
        if (error) {
          throw new Error(params.get('error_description') || error);
        }

        const expectedState = sessionStorage.getItem(KEYCAST_STATE_KEY);
        const receivedState = params.get('state');
        if (!expectedState || !receivedState || expectedState !== receivedState) {
          throw new Error('login.divine.video returned an invalid state token.');
        }

        let pkce;
        try {
          pkce = JSON.parse(sessionStorage.getItem(KEYCAST_PKCE_KEY) || 'null');
        } catch {
          pkce = null;
        }
        if (!pkce || !pkce.verifier) {
          throw new Error('Missing PKCE verifier. Start login again.');
        }

        const tokenData = await postKeycastTokenRequest({
          grant_type: 'authorization_code',
          code: code,
          client_id: KEYCAST_CLIENT_ID,
          redirect_uri: getKeycastRedirectUrl(),
          code_verifier: pkce.verifier,
        });
        const session = normalizeStoredKeycastSession(tokenData);
        if (!session) {
          throw new Error('login.divine.video did not return a usable signer session.');
        }
        saveKeycastSession(session);
        await activateSigner(createKeycastSigner(session), 'keycast', 'Signed in with your Divine login.');
      } catch (e) {
        clearKeycastSession();
        setStatus('verify-login-status', e.message || 'Could not sign in with your Divine login.', 'error');
      } finally {
        cleanKeycastCallbackParams();
      }
      return true;
    }

    async function restoreKeycastSession() {
      const session = await getValidKeycastSession();
      if (!session) return false;
      try {
        await activateSigner(createKeycastSigner(session), 'keycast', 'Signed in again with your Divine login.');
        return true;
      } catch {
        clearKeycastSession();
        return false;
      }
    }

    async function connectKeycastSigner() {
      clearStatus('verify-login-status');
      setStatus('verify-login-status', 'Opening your Divine login...', 'loading');
      await startKeycastLogin();
    }

    async function connectBunkerSigner() {
      clearStatus('verify-login-status');
      const input = document.getElementById('bunker-input').value.trim();
      if (!input) {
        setStatus('verify-login-status', 'Paste a bunker URL or bunker NIP-05 first.', 'error');
        return;
      }
      try {
        setButtonLoading('connect-bunker-btn', true, 'Connecting...');
        setStatus('verify-login-status', 'Connecting to bunker signer...', 'loading');
        const tools = await loadNostrTools();
        const parsed = await tools.nip46.parseBunkerInput(input);
        if (!parsed) {
          throw new Error('Could not read that bunker URL or bunker NIP-05.');
        }
        const signer = tools.nip46.BunkerSigner.fromBunker(tools.pure.generateSecretKey(), parsed);
        await signer.connect();
        endNostrConnect();
        await activateSigner(signer, 'bunker', 'Connected with bunker signer.');
      } catch (e) {
        setStatus('verify-login-status', e.message || 'Could not connect bunker signer.', 'error');
      } finally {
        setButtonLoading('connect-bunker-btn', false, '');
      }
    }

    async function startNostrConnect() {
      endNostrConnect();
      clearStatus('verify-login-status');
      const attempt = { ended: false, sockets: [] };
      nostrConnectAttempt = attempt;
      try {
        setButtonLoading('start-nostr-connect-btn', true, 'Waiting...');
        setStatus('verify-login-status', 'Preparing Nostr Connect session...', 'loading');
        const tools = await loadNostrTools();
        if (attempt.ended) return;
        const clientSecretKey = tools.pure.generateSecretKey();
        const secret = randomBase64Url(18);
        const uri = tools.nip46.createNostrConnectURI({
          clientPubkey: tools.pure.getPublicKey(clientSecretKey),
          relays: REMOTE_SIGNER_RELAYS,
          secret: secret,
          perms: ['get_public_key', 'sign_event'],
          name: 'Divine Verification',
          url: window.location.origin,
        });
        showNostrConnectUi(uri);
        setStatus('verify-login-status', 'Waiting for your signer to approve the Nostr Connect request...', 'loading');
        // The request gets its own relay connections, so ending it can close
        // all of them. nostr-tools' abort signal can't end it: it stops only
        // one relay's subscription.
        const pool = new tools.pool.SimplePool({
          websocketImplementation: class extends WebSocket {
            constructor(url) {
              super(url);
              attempt.sockets.push(this);
            }
          },
        });
        const signer = await tools.nip46.BunkerSigner.fromURI(
          clientSecretKey,
          uri,
          { pool: pool },
          // A signal that is never aborted, instead of a time limit: with
          // one, the request waits for approval without a deadline and each
          // relay gets the usual few seconds to connect.
          new AbortController().signal
        );
        if (attempt.ended) return;
        nostrConnectAttempt = null;
        hideNostrConnectUi();
        await activateSigner(signer, 'nostrconnect', 'Connected with Nostr Connect.');
      } catch (e) {
        // An ended request reports nothing.
        if (attempt.ended) return;
        closeNostrConnectAttempt(attempt);
        setStatus('verify-login-status', e.message || 'Could not connect with Nostr Connect.', 'error');
      } finally {
        if (!attempt.ended) setButtonLoading('start-nostr-connect-btn', false, '');
      }
    }

    // Closes every relay connection a Nostr Connect request opened.
    function closeNostrConnectAttempt(attempt) {
      attempt.sockets.forEach(function(socket) { socket.close(); });
      if (nostrConnectAttempt === attempt) nostrConnectAttempt = null;
    }

    // Ends the waiting Nostr Connect request, if any, and resets its controls.
    // Nothing from an ended request reaches the page afterwards.
    function endNostrConnect() {
      if (nostrConnectAttempt) {
        nostrConnectAttempt.ended = true;
        closeNostrConnectAttempt(nostrConnectAttempt);
      }
      hideNostrConnectUi();
      setButtonLoading('start-nostr-connect-btn', false, '');
    }

    function cancelNostrConnect() {
      endNostrConnect();
      clearStatus('verify-login-status');
    }

    async function copyNostrConnectUri() {
      const input = document.getElementById('nostr-connect-uri-input');
      if (!input || !input.value) return;
      try {
        await navigator.clipboard.writeText(input.value);
        setStatus('verify-login-status', 'Nostr Connect URI copied.', 'ok');
      } catch {
        setStatus('verify-login-status', 'Could not copy the Nostr Connect URI.', 'error');
      }
    }

    async function connectNostrSigner() {
      clearStatus('verify-login-status');
      try {
        setButtonLoading('connect-nostr-btn', true, 'Signing in...');
        // Without an extension, say so rather than open the Divine login:
        // that has its own button. Inside the Divine app's frame the app
        // provides window.nostr; if it were ever missing there, open the
        // Divine login as before rather than ask for an extension.
        if (!isBrowserSignerAvailable()) {
          if (window.__divineEmbedded) {
            await connectKeycastSigner();
            return;
          }
          setStatus('verify-login-status', 'No Nostr extension found. Sign in with your Divine login instead, or install one.', 'error');
          return;
        }
        await connectBrowserSigner();
      } catch (e) {
        setStatus('verify-login-status', e.message || 'Could not sign in with Nostr.', 'error');
      } finally {
        setButtonLoading('connect-nostr-btn', false, '');
      }
    }

    async function getActivePubkey() {
      // Only signing in or the app's ?pubkey= address fills the box. Anything
      // in it other than a 64-character lowercase hex key is not used.
      const accountInput = document.getElementById('verify-pubkey-input').value;
      if (/^[0-9a-f]{64}$/.test(accountInput)) {
        if (signerPubkeyHex && signerPubkeyHex !== accountInput) {
          throw new Error('The account in Step 1 does not match the account you signed in with.');
        }
        return accountInput;
      }
      if (signerPubkeyHex) return signerPubkeyHex;
      throw new Error('Sign in first (Verify Here, Step 1).');
    }

    function setButtonLoading(buttonId, isLoading, loadingText) {
      const button = document.getElementById(buttonId);
      if (!button) return;
      if (!button.dataset.defaultText) {
        button.dataset.defaultText = button.textContent || '';
      }
      button.disabled = isLoading;
      button.textContent = isLoading ? loadingText : button.dataset.defaultText;
    }

    function updateOAuthInputs() {
      const platform = document.getElementById('oauth-platform-select').value;
      const wrap = document.getElementById('oauth-bluesky-handle-wrap');
      wrap.style.display = platform === 'bluesky' ? 'block' : 'none';
    }

    function updateProofInputs() {
      const platform = document.getElementById('proof-platform-select').value;
      const identityInput = document.getElementById('proof-identity-input');
      const proofLabel = document.getElementById('proof-label');
      const proofInput = document.getElementById('proof-proof-input');
      const helper = document.getElementById('proof-helper');

      if (platform === 'bluesky') {
        identityInput.placeholder = 'example.bsky.social';
        proofLabel.textContent = 'Post link or proof ID (optional)';
        proofInput.placeholder = 'Paste full Bluesky post URL or leave blank for identity-link check';
        helper.textContent = 'Bluesky can verify by login or identity-link record, even without a post ID.';
      } else if (platform === 'github') {
        identityInput.placeholder = 'octocat';
        proofLabel.textContent = 'Gist link or Gist ID';
        proofInput.placeholder = 'https://gist.github.com/octocat/abc123... or abc123...';
        helper.textContent = 'Paste a gist URL and we will extract the ID for you.';
      } else if (platform === 'twitter') {
        identityInput.placeholder = 'example';
        proofLabel.textContent = 'Post link or Tweet ID';
        proofInput.placeholder = 'https://x.com/example/status/123... or 123...';
        helper.textContent = 'Paste an X/Twitter post URL for easiest setup.';
      } else if (platform === 'mastodon') {
        identityInput.placeholder = 'mastodon.social/@example';
        proofLabel.textContent = 'Status link or Status ID';
        proofInput.placeholder = 'https://mastodon.social/@example/123... or 123...';
        helper.textContent = 'Identity format is instance/@user. A full status URL also works.';
      } else if (platform === 'telegram') {
        identityInput.placeholder = 'mychannel';
        proofLabel.textContent = 'Message link or channel/message ID';
        proofInput.placeholder = 'https://t.me/mychannel/123 or mychannel/123';
        helper.textContent = 'Telegram proof should point to a public message that contains your npub.';
      } else if (platform === 'discord') {
        identityInput.placeholder = 'your Discord username';
        proofLabel.textContent = 'Message link';
        proofInput.placeholder = 'https://discord.com/channels/.../.../...';
        helper.textContent = 'Post a message containing your npub, then right-click it and Copy Message Link. A server invite cannot prove who owns an account.';
      } else if (platform === 'youtube') {
        identityInput.placeholder = 'UC... or @channelhandle';
        proofLabel.textContent = 'Video link or video ID';
        proofInput.placeholder = 'https://www.youtube.com/watch?v=... or 11-char ID';
        helper.textContent = 'We verify your npub inside the video description.';
      } else if (platform === 'tiktok') {
        identityInput.placeholder = 'username';
        proofLabel.textContent = 'Post link or post number';
        proofInput.placeholder = 'Post link, share link, or post number';
        helper.textContent = 'Paste a TikTok video or photo link, a share link, or the post number.';
      } else {
        identityInput.placeholder = 'Account identity';
        proofLabel.textContent = 'Post link or proof ID';
        proofInput.placeholder = 'Paste full URL or proof ID';
        helper.textContent = 'Paste a full link if available.';
      }
    }

    function tryMakeUrl(input) {
      const raw = (input || '').trim();
      if (!raw) return null;
      try {
        return new URL(raw);
      } catch {}
      if (/^[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}\\/.+/.test(raw)) {
        try {
          return new URL('https://' + raw);
        } catch {}
      }
      return null;
    }

    function parseProofUrl(platform, parsedUrl) {
      const host = parsedUrl.hostname.toLowerCase();
      const path = parsedUrl.pathname.split('/').filter(Boolean);

      if (platform === 'github' && host.includes('gist.github.com')) {
        if (path.length >= 2) {
          return { identity: path[0], proof: path[1] };
        }
      }

      if (platform === 'twitter' && (host === 'x.com' || host === 'www.x.com' || host === 'twitter.com' || host === 'www.twitter.com')) {
        const statusIdx = path.indexOf('status');
        if (statusIdx > 0 && path[statusIdx + 1]) {
          return { identity: path[statusIdx - 1].replace(/^@/, ''), proof: path[statusIdx + 1] };
        }
      }

      if (platform === 'bluesky' && host === 'bsky.app') {
        if (path[0] === 'profile' && path[1] && path[2] === 'post' && path[3]) {
          return { identity: path[1], proof: path[3] };
        }
      }

      if (platform === 'mastodon') {
        if (path.length >= 2 && path[0].startsWith('@')) {
          return { identity: host + '/' + path[0], proof: path[1] };
        }
        if (path[0] === 'users' && path[1] && path[2] === 'statuses' && path[3]) {
          return { identity: host + '/@' + path[1], proof: path[3] };
        }
      }

      if (platform === 'telegram' && (host === 't.me' || host === 'www.t.me')) {
        // t.me/s/<channel>/<post> is the same post on Telegram's public preview page.
        const post = path[0] === 's' ? path.slice(1) : path;
        if (post[0] && post[1]) {
          const channel = post[0].replace(/^@/, '');
          return { identity: channel, proof: channel + '/' + post[1] };
        }
      }

      if (platform === 'youtube') {
        if ((host === 'youtube.com' || host === 'www.youtube.com') && parsedUrl.searchParams.get('v')) {
          return { proof: parsedUrl.searchParams.get('v') };
        }
        if ((host === 'youtube.com' || host === 'www.youtube.com') && path[0] === 'shorts' && path[1]) {
          return { proof: path[1] };
        }
        if ((host === 'youtu.be' || host === 'www.youtu.be') && path[0]) {
          return { proof: path[0] };
        }
      }

      if (platform === 'tiktok' && host.endsWith('tiktok.com')) {
        const userPart = path.find(part => part.startsWith('@'));
        // Photo posts are checked by their number the same way as videos.
        const postIdx = path.findIndex(part => part === 'video' || part === 'photo');
        if (postIdx !== -1 && path[postIdx + 1]) {
          return {
            identity: userPart ? userPart.slice(1) : undefined,
            proof: path[postIdx + 1],
          };
        }
      }

      return {};
    }

    function normalizeProofInputs(platform, rawIdentity, rawProof) {
      let identity = (rawIdentity || '').trim();
      let proof = (rawProof || '').trim();

      const proofUrl = tryMakeUrl(proof);
      if (proofUrl) {
        const parsed = parseProofUrl(platform, proofUrl);
        if (parsed.identity && !identity) identity = parsed.identity;
        if (parsed.proof) proof = parsed.proof;
      } else if (!proof) {
        const identityUrl = tryMakeUrl(identity);
        if (identityUrl) {
          const parsed = parseProofUrl(platform, identityUrl);
          if (parsed.identity) identity = parsed.identity;
          if (parsed.proof) proof = parsed.proof;
        }
      }

      if (platform === 'twitter' || platform === 'telegram' || platform === 'tiktok') {
        identity = identity.replace(/^@/, '');
      }
      if (platform === 'bluesky') {
        identity = identity.replace(/^@/, '').toLowerCase();
      }

      proof = proof.replace(/^\\/+/, '').replace(/\\/+$/, '');
      return { identity, proof };
    }

    async function startOAuthVerification() {
      let nonce = '';
      try {
        clearStatus('verify-global-status');
        clearStatus('oauth-status');
        setButtonLoading('oauth-start-btn', true, 'Opening sign-in...');
        // A link counts once you confirm it with your signer, so a sign-in
        // starts only with one connected that can sign (#113).
        if (!activeSigner || typeof activeSigner.signEvent !== 'function' || typeof activeSigner.getPublicKey !== 'function') {
          throw new Error('Sign in first (Verify Here, Step 1). You confirm the link with your Divine login or Nostr signer when you come back.');
        }
        const pubkey = String(await activeSigner.getPublicKey()).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(pubkey)) {
          throw new Error('Signer returned an invalid pubkey.');
        }
        const platform = document.getElementById('oauth-platform-select').value;
        setAccountInputValue(pubkey);

        // The nonce ties the return to this page; the secret, which never
        // leaves this browser except to confirm, ties it to this sign-in.
        nonce = newSignInNonce();
        const startSecret = newStartSecret();
        const startCheck = await startCheckFor(startSecret);
        // Back to this same page and host, where this sign-in is remembered.
        const body = { pubkey, return_url: window.location.origin + '/?signin=' + nonce + '#verify-here', start_check: startCheck };
        let handle = '';
        if (platform === 'bluesky') {
          handle = document.getElementById('oauth-bluesky-handle-input').value.trim().replace(/^@/, '').toLowerCase();
          if (!handle) throw new Error('Enter your Bluesky handle (example: example.bsky.social).');
          body.handle = handle;
        }
        setStatus('oauth-status', 'Opening secure ' + platform + ' sign-in...', 'loading');
        if (!rememberPendingSignIn(platform, pubkey, nonce, { startSecret, startCheck, signer: activeSignerSource, handle })) {
          throw new Error('This browser blocked the page from saving your sign-in, so it can\\'t be confirmed. Allow this site to store data and try again.');
        }
        // A network failure shows the plain message below, not the browser's own text.
        let resp = null;
        try {
          resp = await fetch(API + '/auth/' + platform + '/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        } catch {}
        let data = null;
        if (resp) {
          try { data = await resp.json(); } catch {}
        }
        if (!resp || !resp.ok || !data || typeof data.url !== 'string') {
          throw new Error((data && data.error) || 'Could not start sign-in.');
        }
        let target = null;
        try { target = new URL(data.url); } catch {}
        if (!target || target.protocol !== 'https:') throw new Error('Could not start sign-in.');
        window.location.href = target.toString();
      } catch (e) {
        // A sign-in that never left can't come back, so drop it and its secret.
        if (nonce) forgetPendingSignIn(nonce);
        setStatus('oauth-status', e.message || 'Could not start sign-in.', 'error');
        setButtonLoading('oauth-start-btn', false, '');
      }
    }

    async function verifySingleHere() {
      const resultEl = document.getElementById('proof-result');
      resultEl.style.display = 'none';
      try {
        clearStatus('verify-global-status');
        clearStatus('publish-status');
        clearStatus('proof-status');
        setButtonLoading('proof-verify-btn', true, 'Checking...');
        setStatus('proof-status', 'Checking your account...', 'loading');

        const pubkey = await getActivePubkey();
        setAccountInputValue(pubkey);

        const platform = document.getElementById('proof-platform-select').value;
        const rawIdentity = document.getElementById('proof-identity-input').value;
        const rawProof = document.getElementById('proof-proof-input').value;
        const normalized = normalizeProofInputs(platform, rawIdentity, rawProof);

        document.getElementById('proof-identity-input').value = normalized.identity;
        document.getElementById('proof-proof-input').value = normalized.proof;

        if (!normalized.identity) throw new Error('Enter your account name for this platform.');
        if (platform !== 'bluesky' && !normalized.proof) throw new Error('Paste the post link or proof ID for this platform.');

        setStatus('proof-status', 'Verifying link now...', 'loading');
        const resp = await fetch(API + '/verify/single', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform,
            identity: normalized.identity,
            proof: normalized.proof,
            pubkey,
          }),
        });

        const data = await resp.json();
        if (!resp.ok || data.error) {
          setStatus('proof-status', data.error || 'Not verified yet.', 'error');
        } else if (data.verified) {
          // Publish the stable form the verifier resolved (for example a
          // TikTok share link becomes its post number), not the pasted link,
          // unless the person changed the proof while the check ran.
          const proofInput = document.getElementById('proof-proof-input');
          const useCleanProof = typeof data.canonical_proof === 'string' && data.canonical_proof
            && proofInput.value === normalized.proof;
          if (useCleanProof) proofInput.value = data.canonical_proof;
          // The same for the account (for example a handle pasted with its @).
          const identityInput = document.getElementById('proof-identity-input');
          const useCleanIdentity = typeof data.canonical_identity === 'string' && data.canonical_identity
            && identityInput.value === normalized.identity;
          if (useCleanIdentity) identityInput.value = data.canonical_identity;
          const method = data.method ? ' via ' + data.method.replace('_', ' ') : '';
          setStatus('proof-status', 'Success. This account is verified' + method + '.' + (useCleanProof || useCleanIdentity ? ' Publishing will use the clean form.' : ''), 'ok');
        } else {
          setStatus('proof-status', data.error || 'Not verified yet.', 'error');
        }
        resultEl.textContent = JSON.stringify(data, null, 2);
        resultEl.style.display = 'block';
      } catch (e) {
        setStatus('proof-status', e.message || 'Verification failed.', 'error');
      } finally {
        setButtonLoading('proof-verify-btn', false, '');
      }
    }

    function currentProofContext() {
      const platform = document.getElementById('proof-platform-select').value;
      const normalized = normalizeProofInputs(
        platform,
        document.getElementById('proof-identity-input').value,
        document.getElementById('proof-proof-input').value
      );
      document.getElementById('proof-identity-input').value = normalized.identity;
      document.getElementById('proof-proof-input').value = normalized.proof;
      return { platform, identity: normalized.identity, proof: normalized.proof || 'oauth' };
    }

    function publishEventToRelay(relayUrl, event) {
      return new Promise((resolve) => {
        let settled = false;
        let ws = null;
        const done = (ok, message) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (ws) {
            try { ws.close(); } catch {}
          }
          resolve({ relay: relayUrl, ok, message });
        };

        const timer = setTimeout(() => done(false, 'timeout'), 7000);
        try {
          ws = new WebSocket(relayUrl);
        } catch {
          done(false, 'connect failed');
          return;
        }

        ws.onopen = () => {
          try {
            ws.send(JSON.stringify(['EVENT', event]));
          } catch {
            done(false, 'send failed');
          }
        };
        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);
            if (data[0] === 'OK' && data[1] === event.id) {
              done(Boolean(data[2]), data[3] || (data[2] ? 'accepted' : 'rejected'));
            } else if (data[0] === 'NOTICE') {
              done(false, data[1] || 'notice');
            }
          } catch {}
        };
        ws.onerror = () => done(false, 'relay error');
        ws.onclose = () => done(false, 'closed');
      });
    }

    async function publishIdentityTagToNostr() {
      clearStatus('verify-global-status');
      clearStatus('publish-status');
      try {
        setButtonLoading('publish-kind0-btn', true, 'Publishing...');
        setStatus('publish-status', 'Checking signer and profile...', 'loading');

        if (!activeSigner || typeof activeSigner.signEvent !== 'function' || typeof activeSigner.getPublicKey !== 'function') {
          throw new Error('You need to be signed in to publish. Sign in with your Divine login, or connect your Nostr signer, in Step 1.');
        }

        const activePubkey = await getActivePubkey();
        const signerPubkey = String(await activeSigner.getPublicKey()).toLowerCase();
        if (activePubkey !== signerPubkey) {
          throw new Error('Signed-in key and selected account do not match.');
        }
        signerPubkeyHex = signerPubkey;
        setAccountInputValue(signerPubkey);
        updateSignerSummary();

        const link = currentProofContext();
        if (!link.identity) {
          throw new Error('Enter the platform account name first.');
        }

        setStatus('publish-status', 'Loading identity event...', 'loading');
        const current = await readLinkedAccounts(signerPubkey);
        if (!current.read) throw new Error(LINKED_ACCOUNTS_UNREAD);
        const identityEvent = current.event;

        const tags = Array.isArray(identityEvent?.tags) ? identityEvent.tags.filter(Array.isArray) : [];
        // Only carry forward i-tags (kind 10011 has no content or other tag types)
        const iTags = tags.filter(tag => tag[0] === 'i');
        const claimKey = link.platform + ':' + link.identity;
        const nextTags = iTags.filter(tag => !(typeof tag[1] === 'string' && tag[1].toLowerCase() === claimKey.toLowerCase()));
        // A link from a sign-in counts once confirmed: its claim carries a
        // value tied to this sign-in, and the verifier checks it first (#113).
        // A post proof publishes as before, whatever sign-in is waiting.
        const waiting = link.proof === 'oauth' ? findWaitingSignIn(link.platform, link.identity, signerPubkey) : null;
        // A sign-in link that matches none of this platform's waiting sign-ins
        // (another Divine account, or another platform account) is neither
        // confirmed nor published.
        if (!waiting && link.proof === 'oauth' && waitingSignIns().some(pending => pending.platform === link.platform)) {
          throw new Error('The account in Step 1 does not match the account you signed in with.');
        }
        nextTags.push(waiting
          ? ['i', claimKey, link.proof, await confirmBindingFor(waiting.code, waiting.startCheck)]
          : ['i', claimKey, link.proof]);

        // Dated one second past the list it replaces when that list is ahead of
        // the clock, so relays keep this one over it.
        const unsignedEvent = {
          kind: 10011,
          created_at: Math.max(Math.floor(Date.now() / 1000), identityEvent && identityEvent.kind === 10011 ? identityEvent.created_at + 1 : 0),
          tags: nextTags,
          content: '',
          pubkey: signerPubkey,
        };

        // A retry sends the event already signed for this sign-in, unchanged.
        const kept = waiting && signedConfirmations[waiting.nonce];
        if (!kept) setStatus('publish-status', 'Requesting signature from your signer...', 'loading');
        const signedEvent = kept || await activeSigner.signEvent(unsignedEvent);
        if (!signedEvent || !signedEvent.id || !signedEvent.sig) {
          throw new Error('Signer did not return a valid signed event.');
        }
        if (String(signedEvent.pubkey || '').toLowerCase() !== signerPubkey) {
          throw new Error('Signer returned an event for a different pubkey.');
        }

        if (waiting) {
          signedConfirmations[waiting.nonce] = signedEvent;
          setStatus('publish-status', 'Confirming the link...', 'loading');
          await confirmSignInCode(waiting, signedEvent);
        }

        setStatus('publish-status', 'Publishing identity event to relays...', 'loading');
        const relayResults = await Promise.all(PROFILE_RELAYS.map(relay => publishEventToRelay(relay, signedEvent)));
        const successCount = relayResults.filter(r => r.ok).length;
        if (successCount === 0) {
          const firstError = relayResults[0] && relayResults[0].message ? relayResults[0].message : 'no relay accepted the event';
          throw new Error('Publish failed: ' + firstError);
        }
        // Counted and on the relays: this sign-in, and any older one for the
        // same account, is done. Until then a retry resends the kept event.
        if (waiting) forgetWaitingSignIns(waiting);

        setStatus('publish-status', 'Published to ' + successCount + '/' + PROFILE_RELAYS.length + ' relays. Your Nostr profile link is now updated.', 'ok');
      } catch (e) {
        setStatus('publish-status', e.message || 'Could not publish to Nostr profile.', 'error');
      } finally {
        setButtonLoading('publish-kind0-btn', false, '');
      }
    }

    // A sign-in this page started, remembered across the trip to the provider so
    // the page only reports results for sign-ins it actually began. Kept in
    // localStorage under the sign-in's id (the signin nonce), so a return that
    // opens in another tab of the same browser still finds it.
    const PENDING_SIGN_IN_KEY = 'verifier_pending_sign_in:';
    // The verifier keeps a sign-in open for 10 minutes and enforces that itself.
    // Its clock starts a little after this page's (at the click), so allow one
    // more minute here rather than turn away a sign-in the verifier recorded.
    const PENDING_SIGN_IN_MAX_AGE_MS = 11 * 60 * 1000;
    const SIGN_IN_PLATFORMS = ['twitter', 'bluesky', 'youtube', 'tiktok'];
    const SIGN_IN_LABELS = { twitter: 'Twitter', bluesky: 'Bluesky', youtube: 'YouTube', tiktok: 'TikTok' };
    const UNCONFIRMED_SIGN_IN = 'This page could not confirm a sign-in. Start the sign-in again from this page.';

    function newSignInNonce() {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }

    // Drops pending sign-ins that are too old to come back or to be confirmed.
    function forgetExpiredSignIns() {
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.indexOf(PENDING_SIGN_IN_KEY) === 0) keys.push(key);
        }
        for (const key of keys) {
          let entry = null;
          try { entry = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
          if (!entry || typeof entry.startedAt !== 'number' || signInHasExpired(entry)) localStorage.removeItem(key);
        }
      } catch {}
    }

    function newStartSecret() {
      return randomBase64Url(32);
    }

    // Same hashing as the verifier and the Divine app: SHA-256 over the text,
    // base64url without padding.
    async function startCheckFor(startSecret) {
      return sha256Base64Url('divine-signin-start:' + startSecret);
    }

    async function confirmBindingFor(code, startCheck) {
      return sha256Base64Url('divine-signin-confirm:' + code + ':' + startCheck);
    }

    // Returns false when the browser won't store it, so the page can say so
    // instead of sending the person off on a sign-in it could never confirm.
    function rememberPendingSignIn(platform, pubkey, nonce, extra) {
      try {
        forgetExpiredSignIns();
        localStorage.setItem(PENDING_SIGN_IN_KEY + nonce, JSON.stringify(Object.assign({ platform, pubkey, nonce, startedAt: Date.now() }, extra || {})));
        return true;
      } catch {
        return false;
      }
    }

    function readPendingSignIn(nonce) {
      // newSignInNonce always makes 32 lowercase hex characters.
      if (!/^[0-9a-f]{32}$/.test(nonce)) return null;
      try {
        const pending = JSON.parse(localStorage.getItem(PENDING_SIGN_IN_KEY + nonce) || 'null');
        if (!pending || SIGN_IN_PLATFORMS.indexOf(pending.platform) === -1) return null;
        if (typeof pending.pubkey !== 'string' || typeof pending.startedAt !== 'number') return null;
        if (signInHasExpired(pending)) return null;
        return pending;
      } catch {
        return null;
      }
    }

    function savePendingSignIn(pending) {
      try { localStorage.setItem(PENDING_SIGN_IN_KEY + pending.nonce, JSON.stringify(pending)); } catch {}
    }

    function forgetPendingSignIn(nonce) {
      try { localStorage.removeItem(PENDING_SIGN_IN_KEY + nonce); } catch {}
    }

    // A sign-in that came back waits for its code to be confirmed: ten minutes
    // from its return on the verifier, a minute more here.
    function signInHasExpired(pending) {
      const since = typeof pending.finishedAt === 'number' ? pending.finishedAt : pending.startedAt;
      return Date.now() - since > PENDING_SIGN_IN_MAX_AGE_MS;
    }

    // Every sign-in in this browser that came back and is waiting to be confirmed.
    function waitingSignIns() {
      const found = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key || key.indexOf(PENDING_SIGN_IN_KEY) !== 0) continue;
          const pending = readPendingSignIn(key.slice(PENDING_SIGN_IN_KEY.length));
          if (pending && pending.code) found.push(pending);
        }
      } catch {}
      return found;
    }

    // The sign-ins waiting to be confirmed for this platform and account,
    // newest first.
    function waitingSignInsFor(platform, identity, pubkey) {
      return waitingSignIns().filter(pending => pending.platform === platform && pending.pubkey === pubkey
        && String(pending.identity || '').toLowerCase() === String(identity || '').toLowerCase())
        .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    }

    // The newest sign-in waiting to be confirmed for this platform and account, if any.
    function findWaitingSignIn(platform, identity, pubkey) {
      return waitingSignInsFor(platform, identity, pubkey)[0] || null;
    }

    // Forgets every waiting sign-in for the account a link was published for,
    // with any event kept for it.
    function forgetWaitingSignIns(waiting) {
      for (const pending of waitingSignInsFor(waiting.platform, waiting.identity, waiting.pubkey)) {
        forgetPendingSignIn(pending.nonce);
        delete signedConfirmations[pending.nonce];
      }
    }

    // The most recent sign-in still waiting, to pick up again after a reload.
    function newestWaitingSignIn() {
      return waitingSignIns().sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0] || null;
    }

    const CONFIRM_REFUSALS = {
      signin_not_found: 'This sign-in couldn\\'t be confirmed. Sign in again.',
      signin_used: 'This sign-in was already used. Sign in again.',
      signin_wrong_account: 'Sign in with the Divine account that started this sign-in.',
      signin_not_yours: 'This sign-in was started somewhere else.',
      signin_claim_mismatch: 'This confirmation doesn\\'t match the sign-in. Sign in again.',
      signin_unavailable: 'Sign-in links for this platform are switched off right now.',
    };
    // The sign-in and its signed event are kept, so pressing Publish again
    // resends the same event.
    const CONFIRM_TRY_AGAIN = 'Couldn\\'t reach the verifier. Press Publish to try again.';
    // A confirmation already signed, kept so a retry sends the very same event.
    const signedConfirmations = {};

    // Asks the verifier to count the link. A sign-in it hasn't seen yet (or a
    // failed request) is tried again for about ten seconds. A refusal is final.
    async function confirmSignInCode(waiting, signedEvent) {
      const deadline = Date.now() + 10000;
      for (;;) {
        let resp = null;
        let data = null;
        try {
          resp = await fetch(API + '/auth/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: waiting.code, start_secret: waiting.startSecret, event: signedEvent }),
          });
          try { data = await resp.json(); } catch {}
        } catch {}
        // Counted only when the verifier names the link this sign-in is for.
        if (resp && resp.status === 200 && data && data.linked === true && data.platform === waiting.platform
          && typeof data.identity === 'string' && data.identity.toLowerCase() === String(waiting.identity).toLowerCase()) return;
        // Any other success isn't counted, and isn't asked again on its own.
        if (resp && resp.ok) throw new Error(CONFIRM_TRY_AGAIN);
        const code = data && data.code;
        const again = !resp || resp.status >= 500 || code === 'signin_not_found';
        if (again && Date.now() + 1000 <= deadline) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        if (again || resp.status === 429) throw new Error(CONFIRM_TRY_AGAIN);
        // Any other answer is a refusal (a 4xx, with or without a code), and
        // resending the same event would be refused again. It ends this
        // sign-in: forget it, so the next Publish of this account is an
        // ordinary one instead of the same refusal.
        forgetPendingSignIn(waiting.nonce);
        delete signedConfirmations[waiting.nonce];
        throw new Error(CONFIRM_REFUSALS[code] || CONFIRM_REFUSALS.signin_not_found);
      }
    }

    // Brings an element into view. While the page is still loading, the
    // browser's own jump to the address's #section would override the scroll,
    // so wait for it.
    function bringIntoViewOnceLoaded(el) {
      if (!el || !el.scrollIntoView) return;
      const bringIntoView = () => el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (document.readyState === 'complete') bringIntoView();
      else window.addEventListener('load', () => setTimeout(bringIntoView, 0), { once: true });
    }

    // Shows a sign-in message and brings it into view, since a return can land
    // anywhere on the page.
    function showSignInStatus(msg, type) {
      setStatus('verify-global-status', msg, type);
      bringIntoViewOnceLoaded(document.getElementById('verify-global-status'));
    }

    // Read from the verifier's reason code (#104), not its wording, and named
    // only with the platform of a sign-in this page started.
    function signInErrorMessage(reasonCode, pending) {
      const label = pending ? SIGN_IN_LABELS[pending.platform] : '';
      if (reasonCode === 'cancelled') return 'Sign-in was not completed: ' + (label ? 'cancelled or declined at ' + label : 'it was cancelled or declined.');
      if (reasonCode === 'provider_error') return 'Sign-in was not completed: ' + (label ? 'could not be completed at ' + label : 'it could not be completed.');
      if (reasonCode === 'failed') return 'Sign-in was not completed: the account could not be verified.';
      return 'Sign-in was not completed.';
    }

    // The verifier's one-time code: 32 random bytes, base64url without padding.
    const SIGN_IN_CODE_FORMAT = /^[A-Za-z0-9_-]{43}$/;
    const NOT_STARTED_HERE = 'This sign-in wasn\\'t started on this page. If someone sent you a sign-in link, don\\'t continue.';
    // Set when this page load carried a sign-in return, so start-up doesn't
    // also pick up a waiting sign-in from before.
    let signInReturnHandled = false;

    // The verifier puts the one-time code after the # (or, if set to, in the
    // query). The query is read first: the verifier always replaces that name
    // in the query it returns to.
    function signInCodeFromAddress() {
      const fromQuery = new URLSearchParams(window.location.search).get('oauth_confirm');
      if (fromQuery) return fromQuery;
      return new URLSearchParams(window.location.hash.replace(/^#/, '')).get('oauth_confirm') || '';
    }

    // An extension (or the Divine app's frame) used to start is connected again
    // with its public key only; the confirmation it signs proves the key.
    async function reattachSigner(source) {
      if (activeSigner) return;
      if ((source === 'browser' || source === 'embedded') && isBrowserSignerAvailable()) {
        try { await activateSigner(createBrowserSigner(), source, ''); } catch {}
      }
    }

    // Fills in the post form, which Publish reads, so Publish confirms this
    // sign-in, and says which account signed in.
    function showWaitingSignIn(pending) {
      const proofPlatformEl = document.getElementById('proof-platform-select');
      const proofIdentityEl = document.getElementById('proof-identity-input');
      const proofProofEl = document.getElementById('proof-proof-input');
      if (proofPlatformEl && proofIdentityEl) {
        proofPlatformEl.value = pending.platform;
        // Setting the value does not fire 'change', so update the labels here.
        updateProofInputs();
        proofIdentityEl.value = pending.identity;
        if (proofProofEl) proofProofEl.value = 'oauth';
        clearSignInFillOnPlatformChange(proofPlatformEl, proofIdentityEl, proofProofEl, pending.platform, pending.identity);
      }
      const label = SIGN_IN_LABELS[pending.platform] || pending.platform;
      const signedIn = 'Signed in to ' + label + ' as ' + pending.identity + '. Publish to link it to your Divine account.';
      setStatus('verify-global-status', signedIn, 'ok');
      // Publish is the next step, and on a phone it is too far below the
      // message for both to fit on screen. So put the same note beside Publish
      // and land there.
      setStatus('publish-status', signedIn, 'ok');
      watchPublishNote(signedIn, [proofPlatformEl, proofIdentityEl, proofProofEl]);
      bringIntoViewOnceLoaded(document.getElementById('publish-kind0-btn'));
    }

    async function handleOAuthCallbackMessage() {
      const params = new URLSearchParams(window.location.search);
      const code = signInCodeFromAddress();
      const verified = params.get('oauth_verified') === 'true';
      const reasonCode = params.get('oauth_error_code');
      const unfinished = !!(params.get('oauth_error') || reasonCode);
      if (!code && !verified && !unfinished) return;
      signInReturnHandled = true;

      const platform = params.get('platform') || '';
      const identity = params.get('identity') || '';
      const nonce = params.get('signin') || '';
      ['signin', 'oauth_verified', 'platform', 'identity', 'oauth_error', 'oauth_error_code', 'oauth_confirm'].forEach(name => params.delete(name));
      // The code leaves the address before anything else can read it, and
      // before this function first waits on anything.
      // A return with a code, wherever it was, goes back to the section anchor.
      const hash = code ? '#verify-here' : window.location.hash;
      window.history.replaceState({}, '', window.location.pathname + (params.toString() ? '?' + params.toString() : '') + hash);

      const pending = readPendingSignIn(nonce);
      if (unfinished) {
        if (pending) forgetPendingSignIn(nonce);
        showSignInStatus(signInErrorMessage(reasonCode, pending), 'error');
        return;
      }
      const handleMatches = !pending || pending.platform !== 'bluesky' || !pending.handle
        || identity.toLowerCase() === pending.handle;
      // A sign-in comes back once. The same return again (a reload before the
      // address was cleaned) is that sign-in; any other return for a sign-in
      // that already came back is refused, and the sign-in dropped.
      const cameBack = !!pending && !!pending.code;
      const sameReturn = cameBack && pending.code === code && pending.identity === identity;
      if (!SIGN_IN_CODE_FORMAT.test(code) || !pending || pending.nonce !== nonce || pending.platform !== platform || !identity || !handleMatches
        || (cameBack && !sameReturn)) {
        if (pending) forgetPendingSignIn(nonce);
        showSignInStatus(code ? NOT_STARTED_HERE : UNCONFIRMED_SIGN_IN, 'error');
        return;
      }

      if (!sameReturn) {
        pending.code = code;
        pending.identity = identity;
        pending.finishedAt = Date.now();
        savePendingSignIn(pending);
      }
      // Shown before reconnecting the signer, which may wait on a prompt.
      showWaitingSignIn(pending);
      await reattachSigner(pending.signer);
    }

    // After a reload (a login.divine.video round trip, or the person coming
    // back to the tab), picks up the newest sign-in still waiting to be
    // confirmed, unless the post form already holds something else.
    async function resumeWaitingSignIn() {
      if (signInReturnHandled) return;
      const pending = newestWaitingSignIn();
      if (!pending) return;
      const proofIdentityEl = document.getElementById('proof-identity-input');
      if (proofIdentityEl && proofIdentityEl.value && proofIdentityEl.value !== pending.identity) return;
      showWaitingSignIn(pending);
      await reattachSigner(pending.signer);
    }

    // The note beside Publish says what Publish will do, so it goes as soon as
    // that stops being true: the form no longer matches what was filled in, or
    // Publish is clicked. A newer message in the same spot is left alone.
    function watchPublishNote(note, formEls) {
      const els = formEls.filter(Boolean);
      const filledIn = JSON.stringify(els.map(el => el.value));
      const publishBtn = document.getElementById('publish-kind0-btn');
      const forget = () => {
        const statusEl = document.getElementById('publish-status');
        if (statusEl && statusEl.textContent === note) clearStatus('publish-status');
        els.forEach(el => { el.removeEventListener('input', onEdit); el.removeEventListener('change', onEdit); });
        if (publishBtn) publishBtn.removeEventListener('click', forget);
      };
      const onEdit = () => { if (JSON.stringify(els.map(el => el.value)) !== filledIn) forget(); };
      els.forEach(el => { el.addEventListener('input', onEdit); el.addEventListener('change', onEdit); });
      if (publishBtn) publishBtn.addEventListener('click', forget);
    }

    // The account and "oauth" a sign-in fills in belong to the signed-in
    // platform. Once another platform is picked (by hand or from the platform
    // list), clear whichever of them the person hasn't changed. Anything the
    // person typed stays.
    function clearSignInFillOnPlatformChange(platformEl, identityEl, proofEl, platform, identity) {
      const onChange = () => {
        if (platformEl.value === platform) return;
        if (identityEl.value === identity) identityEl.value = '';
        if (proofEl && proofEl.value === 'oauth') proofEl.value = '';
        platformEl.removeEventListener('change', onChange);
      };
      platformEl.addEventListener('change', onChange);
    }

    // Shown instead of publishing when the current list couldn't be read, since
    // publishing then would drop the accounts already linked.
    const LINKED_ACCOUNTS_UNREAD = "Couldn't load your current linked accounts, so nothing was published. Please try again in a moment.";
    const LINKED_ACCOUNTS_LIST_UNREAD = "Couldn't load your linked accounts right now. Please try again in a moment.";

    // Asks one relay, in one request, for the person's identity event (kind
    // 10011) and profile (kind 0). Resolves with the events it sent once it says
    // it has sent them all; rejects if it can't be reached, refuses, hangs up or
    // takes longer than 8 seconds.
    function fetchLinkedAccountEvents(relayUrl, pubkey) {
      return new Promise((resolve, reject) => {
        let ws;
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 8000);
        try {
          ws = new WebSocket(relayUrl);
        } catch { clearTimeout(timeout); reject(new Error('ws failed')); return; }
        const subId = 'links_' + Math.random().toString(36).slice(2, 8);
        const events = [];
        ws.onopen = () => {
          ws.send(JSON.stringify(['REQ', subId,
            { kinds: [10011], authors: [pubkey], limit: 1 },
            { kinds: [0], authors: [pubkey], limit: 1 }]));
        };
        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);
            if (data[0] === 'EVENT' && data[1] === subId) {
              events.push(data[2]);
            } else if (data[0] === 'EOSE' && data[1] === subId) {
              clearTimeout(timeout);
              ws.send(JSON.stringify(['CLOSE', subId]));
              ws.close();
              resolve(events);
            } else if (data[0] === 'CLOSED' && data[1] === subId) {
              clearTimeout(timeout);
              ws.close();
              reject(new Error('refused'));
            }
          } catch {}
        };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('ws error')); };
        ws.onclose = () => { clearTimeout(timeout); reject(new Error('ws closed')); };
      });
    }

    // NIP-01: of two copies of a replaceable event, the later created_at wins,
    // and on a tie the lowest id.
    function newerEvent(a, b) {
      if (!a) return b;
      return b.created_at > a.created_at || (b.created_at === a.created_at && b.id < a.id) ? b : a;
    }

    // Relays can each hold a different copy, so ask them all at once and keep the
    // newest identity event, or for profiles from before it, the newest kind 0
    // profile. Each event is checked before it is used. read is true only when
    // Divine's relay answered and everything it sent passed the checks; the other
    // relays can supply a newer copy but can't stand in for it.
    async function readLinkedAccounts(pubkey) {
      const answers = await Promise.all(PROFILE_RELAYS.map(relay => fetchLinkedAccountEvents(relay, pubkey).catch(() => null)));
      let verifyEvent = null;
      if (answers.some(answer => answer && answer.length > 0)) {
        try {
          verifyEvent = (await loadNostrTools()).pure.verifyEvent;
        } catch {
          return { read: false, event: null };
        }
      }
      let read = false;
      let identityEvent = null;
      let profile = null;
      for (let i = 0; i < answers.length; i++) {
        const answer = answers[i];
        if (!answer) continue;
        const usable = answer.filter(e => e && e.pubkey === pubkey && (e.kind === 10011 || e.kind === 0) && verifyEvent(e));
        if (PROFILE_RELAYS[i] === DIVINE_RELAY) read = usable.length === answer.length;
        for (const e of usable) {
          if (e.kind === 10011) identityEvent = newerEvent(identityEvent, e);
          else profile = newerEvent(profile, e);
        }
      }
      return { read, event: identityEvent || profile };
    }

    // --- Manage / Remove linked verifications ---
    const OAUTH_PLATFORMS_SET = new Set(['twitter', 'bluesky', 'youtube', 'tiktok']);

    async function loadLinkedVerifications() {
      const container = document.getElementById('manage-links-container');
      container.textContent = 'Loading...';
      clearStatus('manage-status');

      try {
        const pubkey = await getActivePubkey();
        if (!pubkey) {
          container.textContent = 'Sign in first (Verify Here, Step 1) to see your linked accounts.';
          return;
        }

        const { read, event } = await readLinkedAccounts(pubkey);
        if (!read) {
          container.textContent = '';
          setStatus('manage-status', LINKED_ACCOUNTS_LIST_UNREAD, 'error');
          return;
        }

        const iTags = event ? (event.tags || []).filter(t => t[0] === 'i' && t[1]) : [];
        if (iTags.length === 0) {
          container.textContent = 'No linked verifications found.';
          return;
        }

        renderLinkedVerifications(iTags, container);
      } catch (e) {
        setStatus('manage-status', e.message || 'Failed to load linked verifications.', 'error');
      }
    }

    // Renders manage table using DOM methods for safety. All user data goes through
    // textContent (platform, identity, proof come from the user's own signed Nostr events).
    function renderLinkedVerifications(iTags, container) {
      container.textContent = '';
      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.9rem;';

      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      headerRow.style.cssText = 'border-bottom:2px solid rgba(7,36,27,0.2);text-align:left;';
      ['Platform', 'Identity', 'Proof', ''].forEach(text => {
        const th = document.createElement('th');
        th.style.padding = '0.5rem';
        th.textContent = text;
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const tag of iTags) {
        const claim = tag[1];
        const proof = tag[2] || '';
        const sep = claim.indexOf(':');
        const platform = sep > 0 ? claim.slice(0, sep) : claim;
        const identity = sep > 0 ? claim.slice(sep + 1) : '';

        const row = document.createElement('tr');
        row.style.cssText = 'border-bottom:1px solid rgba(7,36,27,0.12);';

        const tdPlatform = document.createElement('td');
        tdPlatform.style.padding = '0.5rem';
        tdPlatform.textContent = platform;
        row.appendChild(tdPlatform);

        const tdIdentity = document.createElement('td');
        tdIdentity.style.padding = '0.5rem';
        tdIdentity.textContent = identity;
        row.appendChild(tdIdentity);

        const tdProof = document.createElement('td');
        tdProof.style.padding = '0.5rem';
        tdProof.textContent = proof.length > 20 ? proof.slice(0, 20) + '...' : proof;
        row.appendChild(tdProof);

        const tdAction = document.createElement('td');
        tdAction.style.padding = '0.5rem';
        const removeBtn = document.createElement('button');
        removeBtn.className = 'verify-btn';
        removeBtn.style.cssText = 'background:#e53e3e;color:white;padding:0.3rem 0.75rem;font-size:0.85rem;';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => confirmRemoveVerification(platform, identity));
        tdAction.appendChild(removeBtn);
        row.appendChild(tdAction);

        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      container.appendChild(table);
    }

    function confirmRemoveVerification(platform, identity) {
      const dialog = document.getElementById('remove-confirm-dialog');
      document.getElementById('remove-confirm-claim').textContent = platform + ':' + identity;
      dialog.dataset.platform = platform;
      dialog.dataset.identity = identity;
      dialog.style.display = 'block';
    }

    function cancelRemove() {
      document.getElementById('remove-confirm-dialog').style.display = 'none';
    }

    const pendingRemovalRetries = new Map();

    // Keyed by the account rather than how the tag spells it (X as twitter,
    // any case), so removing it in another form clears its pending retry.
    function removalRetryKey(pubkey, platform, identity) {
      const p = String(platform).trim().toLowerCase();
      return JSON.stringify([pubkey, p === 'x' ? 'twitter' : p, String(identity).trim().toLowerCase()]);
    }

    function updateRemovalRetryButton() {
      const button = document.getElementById('retry-revoke-btn');
      button.hidden = pendingRemovalRetries.size === 0;
      button.textContent = 'Retry sign-in record removal (' + pendingRemovalRetries.size + ' pending)';
    }

    async function retryRemoveVerification() {
      const next = pendingRemovalRetries.entries().next();
      if (next.done) return;
      const [key, retry] = next.value;
      await executeRemoveVerification(retry);
      // A failed attempt goes to the back so it cannot block other removals.
      if (pendingRemovalRetries.get(key) === retry) {
        pendingRemovalRetries.delete(key);
        pendingRemovalRetries.set(key, retry);
      }
    }

    async function executeRemoveVerification(retry = null) {
      const dialog = document.getElementById('remove-confirm-dialog');
      const platform = retry ? retry.platform : dialog.dataset.platform;
      const identity = retry ? retry.identity : dialog.dataset.identity;
      const normalizedPlatform = platform.trim().toLowerCase();
      const oauthPlatform = normalizedPlatform === 'x' ? 'twitter' : normalizedPlatform;
      dialog.style.display = 'none';
      const retryButton = document.getElementById('retry-revoke-btn');
      retryButton.disabled = true;

      setStatus('manage-status', 'Removing verification...', 'loading');

      try {
        if (!activeSigner) {
          throw new Error('Sign in first (Verify Here, Step 1).');
        }

        const pubkey = await getActivePubkey();
        const signerPubkey = String(await activeSigner.getPublicKey()).toLowerCase();
        if (pubkey !== signerPubkey) {
          throw new Error('Signed-in key and selected account do not match.');
        }
        if (retry && retry.pubkey !== signerPubkey) {
          throw new Error('Sign in with the original account to retry this removal.');
        }

        // Fetch current identity event (kind 10011, fall back to kind 0)
        const current = await readLinkedAccounts(signerPubkey);
        if (!current.read) throw new Error(LINKED_ACCOUNTS_UNREAD);
        const event = current.event;

        const tags = event ? (event.tags || []).filter(Array.isArray) : [];
        const iTags = tags.filter(tag => tag[0] === 'i');
        const claimKey = (platform + ':' + identity).toLowerCase();
        const retryKey = removalRetryKey(signerPubkey, platform, identity);
        if (retry && event && event.kind === 10011 &&
            newerEvent(retry.removalEvent, event) === event &&
            iTags.some(tag => typeof tag[1] === 'string' && tag[1].toLowerCase() === claimKey)) {
          pendingRemovalRetries.delete(retryKey);
          // Show the list that holds it again first (loading clears the status).
          await loadLinkedVerifications();
          setStatus('manage-status', 'This account was linked again; remove it from the list if you still want to unlink.', 'error');
          return;
        }
        const nextTags = iTags.filter(tag => !(typeof tag[1] === 'string' && tag[1].toLowerCase() === claimKey));

        // Dated one second past the list it replaces (as mobile does), so the
        // verifier can tell this list is newer even if the clocks disagree. A
        // retry also dates past its own first removal, which a relay that
        // missed it may not return.
        const unsignedEvent = {
          kind: 10011,
          created_at: Math.max(
            Math.floor(Date.now() / 1000),
            event && event.kind === 10011 ? event.created_at + 1 : 0,
            retry && retry.removalEvent ? retry.removalEvent.created_at + 1 : 0,
          ),
          tags: nextTags,
          content: '',
          pubkey: signerPubkey,
        };

        const signedEvent = await activeSigner.signEvent(unsignedEvent);
        if (!signedEvent || !signedEvent.id || !signedEvent.sig) {
          throw new Error('Signer did not return a valid signed event.');
        }
        if (String(signedEvent.pubkey || '').toLowerCase() !== signerPubkey) {
          throw new Error('Signer returned an event for a different pubkey.');
        }

        const relayResults = await Promise.all(PROFILE_RELAYS.map(relay => publishEventToRelay(relay, signedEvent)));
        const successCount = relayResults.filter(r => r.ok).length;
        if (successCount === 0) {
          throw new Error('No relay accepted the updated event.');
        }

        // Attempt OAuth cache revoke for OAuth platforms
        let revokeWarning = '';
        if (OAUTH_PLATFORMS_SET.has(oauthPlatform)) {
          try {
            const revokeResp = await fetch(API + '/auth/oauth/revoke', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ platform: oauthPlatform, identity: identity, pubkey: signerPubkey, list: signedEvent }),
            });
            if (!revokeResp.ok) {
              const refusal = await revokeResp.json().catch(() => null);
              revokeWarning = refusal && typeof refusal.error === 'string' && refusal.error.trim() ? refusal.error : 'OAuth cache revoke did not complete.';
            }
          } catch {
            revokeWarning = 'OAuth cache revoke did not complete.';
          }
        }

        // Refresh first: loading the list clears its status, but must not erase
        // the refusal or the retry when the removed claim is no longer a row.
        await loadLinkedVerifications();
        if (revokeWarning) {
          pendingRemovalRetries.set(retryKey, retry || {
            platform, identity, pubkey: signerPubkey,
            removalEvent: { id: signedEvent.id, created_at: signedEvent.created_at },
          });
          setStatus('manage-status', 'Removed from profile, but sign-in record removal failed: ' + revokeWarning, 'error');
        } else {
          pendingRemovalRetries.delete(retryKey);
          setStatus('manage-status', 'Verification removed from your Nostr profile.', 'ok');
        }
      } catch (e) {
        setStatus('manage-status', e.message || 'Could not remove verification.', 'error');
      } finally {
        updateRemovalRetryButton();
        retryButton.disabled = false;
      }
    }

    // A platform pill links to the card where that platform can be linked.
    // Also pick the platform there, so the form is ready when the person lands
    // on it. Setting a picker's value fires nothing, so send 'change' as a
    // person's pick would: that refreshes the form's labels, and clears the
    // note beside Publish once it no longer matches the form. The browser's
    // jump to the card comes after this handler and takes focus away, so focus
    // the first field once it has happened, without scrolling: the jump has
    // already placed the card.
    function pickPlatformFromPill(pill) {
      const platform = pill.dataset.platform;
      const toQuickConnect = pill.getAttribute('href') === '#quick-connect';
      const picker = document.getElementById(toQuickConnect ? 'oauth-platform-select' : 'proof-platform-select');
      picker.value = platform;
      picker.dispatchEvent(new Event('change'));
      const next = !toQuickConnect ? 'proof-identity-input'
        : platform === 'bluesky' ? 'oauth-bluesky-handle-input' : 'oauth-start-btn';
      setTimeout(() => document.getElementById(next).focus({ preventScroll: true }), 0);
    }
    document.querySelectorAll('.platform-pill').forEach(pill => {
      pill.addEventListener('click', () => pickPlatformFromPill(pill));
    });

    // Verify Here wiring
    document.getElementById('connect-nostr-btn').addEventListener('click', connectNostrSigner);
    document.getElementById('connect-keycast-btn').addEventListener('click', async () => {
      clearStatus('verify-login-status');
      try {
        setButtonLoading('connect-keycast-btn', true, 'Opening...');
        await connectKeycastSigner();
      } catch (e) {
        setStatus('verify-login-status', e.message || 'Could not open your Divine login.', 'error');
      } finally {
        setButtonLoading('connect-keycast-btn', false, '');
      }
    });
    document.getElementById('connect-bunker-btn').addEventListener('click', connectBunkerSigner);
    document.getElementById('start-nostr-connect-btn').addEventListener('click', startNostrConnect);
    document.getElementById('copy-nostr-connect-btn').addEventListener('click', copyNostrConnectUri);
    document.getElementById('cancel-nostr-connect-btn').addEventListener('click', cancelNostrConnect);
    document.getElementById('oauth-platform-select').addEventListener('change', updateOAuthInputs);
    document.getElementById('proof-platform-select').addEventListener('change', updateProofInputs);
    document.getElementById('oauth-start-btn').addEventListener('click', startOAuthVerification);
    document.getElementById('proof-verify-btn').addEventListener('click', verifySingleHere);
    document.getElementById('publish-kind0-btn').addEventListener('click', publishIdentityTagToNostr);
    document.getElementById('proof-identity-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifySingleHere();
    });
    document.getElementById('proof-proof-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifySingleHere();
    });
    document.getElementById('bunker-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') connectBunkerSigner();
    });

    // Buttons wired here rather than with inline onclick attributes, which a
    // script-nonce Content-Security-Policy would block. They come before the
    // start-up code below so an error there cannot leave them dead.
    document.getElementById('load-links-btn').addEventListener('click', loadLinkedVerifications);
    document.getElementById('remove-cancel-btn').addEventListener('click', cancelRemove);
    document.getElementById('remove-confirm-btn').addEventListener('click', () => executeRemoveVerification());
    document.getElementById('retry-revoke-btn').addEventListener('click', retryRemoveVerification);

    // Start-up: a returning sign-in is handled first, before any signer is
    // restored, so its one-time code leaves the address straight away.
    updateOAuthInputs();
    updateProofInputs();
    handleOAuthCallbackMessage();
    resumeWaitingSignIn();
    // Sign-ins that failed to start or were abandoned never come back to be
    // used up, so drop the expired ones here too.
    forgetExpiredSignIns();
    updateSignerSummary();
    (async () => {
      const handledKeycast = await maybeHandleKeycastCallback();
      if (!handledKeycast) {
        applyLoginQueryHint();
        await restoreKeycastSession();
      }
      updateSignerSummary();
    })();

    // Going Back from the provider, or from a start the verifier turned away,
    // can restore this page from the back/forward cache exactly as it was
    // left: the sign-in button disabled and reading "Opening sign-in...".
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      setButtonLoading('oauth-start-btn', false, '');
      clearStatus('oauth-status');
    });

    // When loaded inside a Divine-hosted iframe, the postMessage shim above
    // installs window.nostr unconditionally, so trigger the standard signer
    // connect flow without waiting for a button click.
    if (window.__divineEmbedded) {
      (async () => {
        try {
          await connectNostrSigner();
        } catch (e) {
          // Fall through silently — the user can still click the connect
          // button if the auto-connect fails for any reason.
        }
      })();
    }
    </script>

    <footer>
      <p>Part of <a href="https://divine.video">divine.video</a>. Open source. Own what you make.</p>
      <p><a href="https://divine.video/privacy">Privacy Policy</a> &middot; <a href="https://divine.video/terms">Terms of Service</a></p>
    </footer>
  </div>
</body>
</html>`)
})

// The API reference. It reads the same platform setup as the landing page, so
// its table and sign-in copy match what the picker there offers.
app.get('/docs', (c) => {
  const requestUrl = new URL(c.req.url)
  // The TikTok review cookie is set by the landing page; /docs only reads it.
  // TODO(#39): Remove cookie variance when the OAuth reviewer override is retired.
  const tiktokOAuthReviewEnabled = getCookie(c, 'tiktok_oauth_review') === '1'
  setPagePolicy(c)
  c.header('Vary', 'Cookie')
  return c.html(renderDocsPage({
    origin: requestUrl.origin,
    ...platformFlags(c.env, tiktokOAuthReviewEnabled),
  }))
})

// "Look up someone": check which accounts a profile has verified, with no signer.
app.get('/lookup', (c) => {
  const nonce = setPagePolicy(c)
  // The lookup fetches a NIP-05 from whatever domain the address names; send
  // that site no Referer, as the main page did when the lookup lived there.
  c.header('Referrer-Policy', 'no-referrer')
  // The lookup checks claims for every platform the verifier supports, whoever
  // is asking; only sign-in depends on the TikTok review cookie. So the cookie
  // is never read here, and the page does not vary by it.
  const { hasYouTube, hasTikTok } = platformFlags(c.env, false)
  return c.html(renderLookupPage({
    origin: new URL(c.req.url).origin,
    nonce,
    hasYouTube,
    hasTikTok,
  }))
})

export default { fetch: app.fetch }
