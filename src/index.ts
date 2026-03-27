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
    'https://verifyer.divine.video',
    'https://verifier.divine.video',
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
  const hasYouTube = !!c.env.YOUTUBE_API_KEY
  const hasTikTok = true // TikTok oEmbed is public, no key needed for proof verification
  const divineLoginUrl = `https://login.divine.video/login?return_url=${encodeURIComponent(`${origin}/#verify-here`)}`

  // Pre-build conditional HTML to avoid TS2590 (template literal union too complex)
  const ytPill = hasYouTube ? '<div class="platform-pill"><svg viewBox="0 0 24 24" fill="#333"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg> YouTube</div>' : ''
  const ttPill = hasTikTok ? '<div class="platform-pill"><svg viewBox="0 0 24 24" fill="#333"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg> TikTok</div>' : ''
  const ytTableRow = hasYouTube ? '<tr><td><code>youtube</code></td><td>Channel ID (<code>UCxxxx</code>) or handle (<code>@user</code>)</td><td>Video ID (11 chars)</td><td>Yes</td></tr>' : ''
  const ttTableRow = hasTikTok ? '<tr><td><code>tiktok</code></td><td>Username (without @)</td><td>Video ID (numeric)</td><td>Yes</td></tr>' : ''
  const extraPlatformNames = (hasYouTube ? ', YouTube' : '') + (hasTikTok ? ', TikTok' : '')
  const extraPlatformCodes = (hasYouTube ? ', <code>youtube</code>' : '') + (hasTikTok ? ', <code>tiktok</code>' : '')
  const ytOAuthInlineExample = hasYouTube ? `\nGET ${origin}/auth/youtube/start?pubkey=hex64&amp;return_url=${origin}/#verify-here` : ''
  const ttOAuthInlineExample = hasTikTok ? `\nGET ${origin}/auth/tiktok/start?pubkey=hex64&amp;return_url=${origin}/#verify-here` : ''
  const extraLookupPlatforms = (hasYouTube ? ",'youtube'" : '') + (hasTikTok ? ",'tiktok'" : '')
  const choosePlatforms = `Choose Twitter, GitHub, Bluesky, Mastodon, Telegram, Discord${extraPlatformNames}.`
  const noPostingPlatforms = `No posting required for Twitter${extraPlatformNames}, and Bluesky.`
  const oauthPlatformOptions = `<option value="twitter">Twitter / X</option><option value="bluesky">Bluesky</option>${hasYouTube ? '<option value="youtube">YouTube</option>' : ''}${hasTikTok ? '<option value="tiktok">TikTok</option>' : ''}`
  const proofPlatformOptions = `<option value="github">GitHub</option><option value="twitter">Twitter / X</option><option value="bluesky">Bluesky</option><option value="mastodon">Mastodon</option><option value="telegram">Telegram</option><option value="discord">Discord</option>${hasYouTube ? '<option value="youtube">YouTube</option>' : ''}${hasTikTok ? '<option value="tiktok">TikTok</option>' : ''}`

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
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6; color: #333; background: #f8fafc;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem; }

    /* Hero */
    .hero { text-align: center; padding: 3rem 1rem 2rem; }
    .hero h1 { font-size: 2.4rem; color: #1a202c; margin-bottom: 0.75rem; font-weight: 800; }
    .hero .subtitle { font-size: 1.2rem; color: #4a5568; max-width: 600px; margin: 0 auto 1.5rem; }
    .hero .cta-row { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; margin-top: 1.5rem; }
    .btn {
      display: inline-block; padding: 0.7rem 1.5rem; border-radius: 10px;
      font-size: 1rem; font-weight: 600; text-decoration: none; cursor: pointer;
      border: none; transition: all 0.2s;
    }
    .btn-primary { background: #4299e1; color: white; }
    .btn-primary:hover { background: #3182ce; text-decoration: none; }
    .btn-outline { background: white; color: #4299e1; border: 2px solid #4299e1; }
    .btn-outline:hover { background: #ebf8ff; text-decoration: none; }

    /* Value props */
    .value-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1.25rem; margin: 2rem 0;
    }
    .value-card {
      background: white; border-radius: 12px; padding: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .value-card .icon { font-size: 2rem; margin-bottom: 0.75rem; }
    .value-card h3 { font-size: 1.1rem; color: #1a202c; margin-bottom: 0.5rem; }
    .value-card p { font-size: 0.9rem; color: #4a5568; margin: 0; }

    /* How it works */
    .steps {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1.5rem; margin: 1.5rem 0;
    }
    .step {
      text-align: center; padding: 1rem;
    }
    .step-number {
      display: inline-flex; align-items: center; justify-content: center;
      width: 40px; height: 40px; border-radius: 50%;
      background: #4299e1; color: white; font-weight: 700; font-size: 1.1rem;
      margin-bottom: 0.75rem;
    }
    .step h4 { color: #1a202c; margin-bottom: 0.25rem; font-size: 1rem; }
    .step p { color: #718096; font-size: 0.85rem; margin: 0; }

    /* Platform pills */
    .platform-grid {
      display: flex; flex-wrap: wrap; gap: 0.75rem; justify-content: center;
      margin: 1.5rem 0;
    }
    .platform-pill {
      display: flex; align-items: center; gap: 0.5rem;
      background: white; border-radius: 10px; padding: 0.6rem 1rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08); font-size: 0.9rem; color: #2d3748;
    }
    .platform-pill svg { width: 20px; height: 20px; flex-shrink: 0; }

    /* Sections */
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

    /* Divider */
    .section-divider {
      text-align: center; padding: 2rem 0 1rem; color: #a0aec0; font-size: 0.85rem;
    }
    .section-divider span {
      background: #f8fafc; padding: 0 1rem; position: relative;
    }
    .section-divider::before {
      content: ''; display: block; height: 1px; background: #e2e8f0;
      position: relative; top: 0.7rem;
    }

    /* Verify flow */
    .verify-here {
      border: 2px solid #2b6cb0;
      background: linear-gradient(180deg, #ffffff 0%, #f7fbff 100%);
    }
    .verify-lead {
      font-size: 1rem;
      color: #2d3748;
      margin-bottom: 1rem;
    }
    .verify-step-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1rem;
    }
    .verify-card {
      background: white;
      border: 1px solid #dbe7f5;
      border-radius: 12px;
      padding: 1rem;
    }
    .step-pill {
      display: inline-block;
      background: #ebf8ff;
      color: #2b6cb0;
      border-radius: 999px;
      padding: 0.25rem 0.65rem;
      font-size: 0.75rem;
      font-weight: 700;
      margin-bottom: 0.6rem;
    }
    .field-label {
      display: block;
      font-size: 0.82rem;
      color: #4a5568;
      margin-bottom: 0.25rem;
      font-weight: 600;
    }
    .field-input,
    .field-select {
      width: 100%;
      padding: 0.62rem 0.72rem;
      border: 2px solid #e2e8f0;
      border-radius: 8px;
      font-size: 0.95rem;
      font-family: inherit;
      margin-bottom: 0.6rem;
      transition: border-color 0.2s;
      outline: none;
      background: #fff;
    }
    .field-input:focus,
    .field-select:focus {
      border-color: #2b6cb0;
    }
    .field-help {
      color: #718096;
      font-size: 0.82rem;
      margin-top: -0.1rem;
      margin-bottom: 0.55rem;
    }
    .status-row {
      display: none;
      padding: 0.52rem 0.75rem;
      border-radius: 8px;
      margin-top: 0.7rem;
      font-size: 0.86rem;
    }
    .verify-btn {
      padding: 0.62rem 1rem;
      border: none;
      border-radius: 8px;
      color: white;
      cursor: pointer;
      font-size: 0.93rem;
      font-weight: 700;
      transition: background 0.2s, opacity 0.2s;
    }
    .verify-btn:disabled {
      cursor: not-allowed;
      opacity: 0.75;
    }
    .verify-btn-primary {
      background: #2b6cb0;
    }
    .verify-btn-primary:hover:not(:disabled) {
      background: #2c5282;
    }
    .verify-btn-success {
      background: #2f855a;
    }
    .verify-btn-success:hover:not(:disabled) {
      background: #276749;
    }
    .advanced-proof {
      margin-top: 1rem;
      border: 1px solid #dbe7f5;
      border-radius: 12px;
      padding: 0.8rem 0.9rem;
      background: #fff;
    }
    .advanced-proof summary {
      cursor: pointer;
      font-weight: 700;
      color: #2d3748;
      outline: none;
    }
    .advanced-proof-inner {
      margin-top: 0.8rem;
    }

    @media (max-width: 640px) {
      .container {
        padding: 1rem;
      }
      .hero {
        padding-top: 2rem;
      }
      .hero h1 {
        font-size: 1.9rem;
      }
      .verify-card {
        padding: 0.85rem;
      }
      .steps {
        gap: 0.75rem;
      }
      .step {
        text-align: left;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
      }
      .step-number {
        margin-bottom: 0.5rem;
      }
    }
  </style>
</head>
<body>
  <div class="container">

    <!-- HERO -->
    <div class="hero">
      <h1>Prove You Are Who You Say You Are</h1>
      <p class="subtitle">Link your social media accounts to your <a href="https://divine.video">Divine</a> profile so people know it's really you. Like a verified badge &mdash; but one that you control, and anyone can check.</p>
      <div class="cta-row">
        <a href="#check" class="btn btn-primary">Look Up Someone</a>
        <a href="#how-to-verify" class="btn btn-outline">Get Verified</a>
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
    <div style="text-align:center;margin:2rem 0 0.75rem;">
      <h2 style="border:none;display:inline-block;padding:0;margin:0;font-size:1.1rem;">Works with the platforms you already use</h2>
    </div>
    <div class="platform-grid">
      <div class="platform-pill">
        <svg viewBox="0 0 24 24" fill="#333"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
        Twitter / X
      </div>
      <div class="platform-pill">
        <svg viewBox="0 0 24 24" fill="#333"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
        GitHub
      </div>
      <div class="platform-pill">
        <svg viewBox="0 0 24 24" fill="#333"><path d="M12 2C7.8 5.4 5 9 5 11.5c0 2.5 1.2 3.6 2.5 3.8-1 .3-3.5 1-2.5 3.2.7 1.5 3.5 1.5 5 .5 1-.7 1.7-1.7 2-2.7.3 1 1 2 2 2.7 1.5 1 4.3 1 5-.5 1-2.2-1.5-2.9-2.5-3.2 1.3-.2 2.5-1.3 2.5-3.8 0-2.5-2.8-6.1-7-9.5z"/></svg>
        Bluesky
      </div>
      <div class="platform-pill">
        <svg viewBox="0 0 24 24" fill="#333"><path d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 00.023-.043v-1.809a.052.052 0 00-.02-.041.053.053 0 00-.046-.01 20.282 20.282 0 01-4.709.547c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 01-.319-1.433.053.053 0 01.066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.668 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z"/></svg>
        Mastodon
      </div>
      <div class="platform-pill">
        <svg viewBox="0 0 24 24" fill="#333"><path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
        Telegram
      </div>
      <div class="platform-pill">
        <svg viewBox="0 0 24 24" fill="#333"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1569 2.4189z"/></svg>
        Discord
      </div>
      ${ytPill}
      ${ttPill}
    </div>

    <!-- HOW TO VERIFY -->
    <section id="how-to-verify">
      <h2>How to Get Verified</h2>
      <p>Most people finish in under a minute. You are just confirming that your Divine account and social account belong to the same person.</p>

      <div class="steps">
        <div class="step">
          <div class="step-number">1</div>
          <h4>Sign in first</h4>
          <p>Scroll to <a href="#verify-here">Verify Here</a> and connect your Nostr signer so this app can publish your verified links.</p>
        </div>
        <div class="step">
          <div class="step-number">2</div>
          <h4>Pick a platform</h4>
          <p>${choosePlatforms}</p>
        </div>
        <div class="step">
          <div class="step-number">3</div>
          <h4>Use Quick Connect</h4>
          <p>For Twitter/X, Bluesky, YouTube, and TikTok, just sign in from this page. No posting required.</p>
        </div>
        <div class="step">
          <div class="step-number">4</div>
          <h4>Done &mdash; you're verified</h4>
          <p>A checkmark shows up on your profile. Anyone can click it to confirm the link is real.</p>
        </div>
      </div>

      <div class="note">
        <strong>${noPostingPlatforms}</strong> For GitHub, Mastodon, Telegram, and Discord, use the advanced section to paste a post/invite link and verify it.
      </div>
    </section>

    <section id="verify-here" class="verify-here">
      <h2>Verify Here</h2>
      <p class="verify-lead">Yes, login is required. Connect your Nostr signer first so verified links can be published to your profile.</p>

      <div class="verify-step-grid">
        <div class="verify-card">
          <span class="step-pill">Step 1</span>
          <h3 style="margin-top:0;">Sign in with your Nostr account</h3>
          <p>Use your browser signer, login.divine.video session, bunker URL, or Nostr Connect. Any of these lets us publish the final verification tag into your Nostr profile (kind 0).</p>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.6rem;">
            <button id="connect-nostr-btn" class="verify-btn verify-btn-primary" type="button">Login with Nostr</button>
            <button id="connect-keycast-btn" class="verify-btn" type="button">Use login.divine.video</button>
            <a href="${divineLoginUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-outline" style="padding:0.52rem 0.85rem;border-radius:8px;font-size:0.9rem;">Open login.divine.video</a>
          </div>
          <label for="verify-pubkey-input" class="field-label">Account (auto-filled after login; manual paste fallback)</label>
          <input id="verify-pubkey-input" class="field-input" type="text" placeholder="alice@divine.video or npub1...">
          <p id="signer-session-summary" class="field-help" style="display:none;"></p>
          <p class="field-help">If a signer session is not available, you can still paste your Divine address, npub, profile URL, or 64-char key.</p>
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
                  <a id="open-nostr-connect-link" class="btn btn-outline" href="#" rel="noopener noreferrer" style="padding:0.52rem 0.85rem;border-radius:8px;font-size:0.9rem;">Open signer app</a>
                  <button id="cancel-nostr-connect-btn" class="verify-btn" type="button">Cancel</button>
                </div>
                <p class="field-help" style="margin-top:0.5rem;">Open this URI in your signer app, or copy it into a bunker / Nostr Connect client.</p>
              </div>
            </div>
          </details>
          <div id="verify-login-status" class="status-row"></div>
          <div id="verify-global-status" class="status-row"></div>
        </div>

        <div class="verify-card">
          <span class="step-pill">Step 2 (Recommended)</span>
          <h3 style="margin-top:0;">Quick Connect (no posting)</h3>
          <p>Sign in with the platform account you want to link.</p>
          <label for="oauth-platform-select" class="field-label">Platform</label>
          <select id="oauth-platform-select" class="field-select">
            ${oauthPlatformOptions}
          </select>
          <div id="oauth-bluesky-handle-wrap" style="display:none;">
            <label for="oauth-bluesky-handle-input" class="field-label">Bluesky handle</label>
            <input id="oauth-bluesky-handle-input" class="field-input" type="text" placeholder="alice.bsky.social">
          </div>
          <button id="oauth-start-btn" class="verify-btn verify-btn-primary" type="button">Continue to secure sign-in</button>
          <div id="oauth-status" class="status-row"></div>
        </div>
      </div>

      <details class="advanced-proof" id="advanced-proof">
        <summary>Step 3 (Advanced): verify by post/link proof instead</summary>
        <div class="advanced-proof-inner">
          <p style="margin-bottom:0.75rem;">Use this only if you do not want Quick Connect. You can paste a full URL and we'll extract IDs where possible.</p>
          <label for="proof-platform-select" class="field-label">Platform</label>
          <select id="proof-platform-select" class="field-select">
            ${proofPlatformOptions}
          </select>
          <label for="proof-identity-input" class="field-label">Your account name on that platform</label>
          <input id="proof-identity-input" class="field-input" type="text" placeholder="e.g. octocat or alice.bsky.social">
          <label id="proof-label" for="proof-proof-input" class="field-label">Post link or proof ID</label>
          <input id="proof-proof-input" class="field-input" type="text" placeholder="Paste full post URL or just the ID">
          <p id="proof-helper" class="field-help">Tip: for Twitter and Bluesky, paste the full post URL.</p>
          <button id="proof-verify-btn" class="verify-btn verify-btn-success" type="button">Verify this link</button>
          <div id="proof-status" class="status-row"></div>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.75rem;">
            <button id="publish-kind0-btn" class="verify-btn verify-btn-primary" type="button">Publish to Nostr profile</button>
          </div>
          <p class="field-help">This writes/updates your identity tag in your signed Nostr kind 0 profile event.</p>
          <div id="publish-status" class="status-row"></div>
          <pre id="proof-result" style="display:none;margin-top:0.75rem;"></pre>
        </div>
      </details>
    </section>

    <!-- HOW IT WORKS -->
    <section id="how-it-works">
      <h2>How Does It Work?</h2>
      <p>Think of it like a handshake between two accounts:</p>
      <ul>
        <li><strong>Your Divine profile says</strong> "I'm @alice on Twitter"</li>
        <li><strong>Your Twitter account confirms</strong> "Yes, that Divine profile is mine"</li>
      </ul>
      <p>We check both sides automatically. If they match, you're verified. The beauty of this system is that <strong>nobody can fake it</strong> &mdash; an impersonator might copy your name and photo, but they can't post from your real Twitter account.</p>
      <p>This is the same approach used by <a href="https://keybase.io">Keybase</a> &mdash; a proven method for cross-platform identity verification, now available for Divine and the broader Nostr ecosystem.</p>
    </section>

    <!-- CHECK TOOL -->
    <section id="check" style="border:2px solid #4299e1;">
      <h2>Look Up Someone</h2>
      <p>Want to know if a profile is real? Enter their address (like alice@divine.video) or their public key to see which accounts they've verified.</p>

      <div style="display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap;">
        <input id="lookup-input" type="text" placeholder="alice@divine.video or npub1..." style="flex:1;min-width:200px;padding:0.6rem 0.75rem;border:2px solid #e2e8f0;border-radius:8px;font-size:0.95rem;font-family:inherit;outline:none;transition:border-color 0.2s;" onfocus="this.style.borderColor='#4299e1'" onblur="this.style.borderColor='#e2e8f0'">
        <button id="lookup-btn" onclick="doLookup()" style="padding:0.6rem 1.5rem;background:#4299e1;color:white;border:none;border-radius:8px;font-size:0.95rem;cursor:pointer;font-weight:600;transition:background 0.2s;" onmouseover="this.style.background='#3182ce'" onmouseout="this.style.background='#4299e1'">Check</button>
      </div>
      <div id="lookup-status" style="display:none;padding:0.5rem 0.75rem;border-radius:6px;margin-bottom:0.75rem;font-size:0.85rem;"></div>
      <div id="lookup-results"></div>
    </section>

    <!-- DIVIDER -->
    <div class="section-divider"><span>API Documentation</span></div>

    <!-- API DOCS (for developers) -->
    <section id="api-about">
      <h2>About the API</h2>
      <p>This service verifies that a Nostr pubkey is linked to accounts on supported platforms. It fetches proof posts server-side, bypassing CORS restrictions that prevent browser-based verification.</p>
      <p>Two verification methods are supported:</p>
      <ul>
        <li><strong>Proof posts</strong> &mdash; User publishes a post containing their <code>npub</code> on the external platform. The service fetches the post and checks that the npub is present and the author matches.</li>
        <li><strong>OAuth login</strong> (Twitter, Bluesky${extraPlatformNames}) &mdash; User authenticates directly. No proof post needed.</li>
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
          <td>Username (e.g., <code>jack</code>)</td>
          <td>Tweet ID</td>
          <td>Yes</td>
        </tr>
        <tr>
          <td><code>bluesky</code></td>
          <td>Handle (e.g., <code>alice.bsky.social</code>)</td>
          <td>Post rkey</td>
          <td>Yes</td>
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
          <td>Invite code</td>
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
        <tr><td><code>checked_at</code></td><td>number</td><td>Unix timestamp (seconds)</td></tr>
        <tr><td><code>cached</code></td><td>boolean</td><td><code>true</code> if served from cache</td></tr>
      </table>
    </section>

    <section id="batch-verify">
      <h2>POST /verify &mdash; Batch Verification</h2>
      <p>Verify up to 10 claims in a single request.</p>

      <h4>Request</h4>
      <pre>POST ${origin}/verify
Content-Type: application/json

{
  "claims": [
    { "platform": "github", "identity": "octocat", "proof": "aa5a315d61ae9438b18d", "pubkey": "7e7e..." },
    { "platform": "twitter", "identity": "jack", "proof": "1234567890", "pubkey": "7e7e..." }
  ]
}</pre>

      <h4>Response (200 OK)</h4>
      <pre>{
  "results": [
    { "platform": "github", "identity": "octocat", "verified": true, "checked_at": 1709571048, "cached": false },
    { "platform": "twitter", "identity": "jack", "verified": false, "error": "Tweet not found", "checked_at": 1709571048, "cached": false }
  ]
}</pre>
    </section>

    <section id="get-verify">
      <h2>GET /verify/:platform/:identity/:proof &mdash; URL-Based Verification</h2>
      <p>Verify via URL. Returns HTML for browsers, JSON for API clients. Add <code>?format=json</code> to force JSON.</p>

      <h4>Examples</h4>
      <pre>GET ${origin}/verify/github/octocat/aa5a315d61ae9438b18d?pubkey=7e7e9c42...4e
GET ${origin}/verify/mastodon/mastodon.social/@alice/109876543210?pubkey=7e7e...4e</pre>
    </section>

    <section id="nip05">
      <h2>GET /nip05/verify &mdash; NIP-05 Verification</h2>
      <p>Check that a NIP-05 identifier resolves to a given pubkey.</p>

      <pre>GET ${origin}/nip05/verify?name=_@divine.video&amp;pubkey=7e7e9c42...4e</pre>

      <h4>Response</h4>
      <pre>{ "name": "_", "domain": "divine.video", "pubkey": "7e7e...", "verified": true, "checked_at": 1709571048, "cached": false }</pre>
    </section>

    <section id="oauth">
      <h2>OAuth Verification (Twitter, Bluesky${extraPlatformNames})</h2>
      <p>Users can verify by logging in instead of posting a proof.</p>

      <h3>Start OAuth</h3>
      <pre>GET ${origin}/auth/twitter/start?pubkey=hex64&amp;return_url=${origin}/#verify-here
GET ${origin}/auth/bluesky/start?pubkey=hex64&amp;handle=alice.bsky.social&amp;return_url=${origin}/#verify-here${ytOAuthInlineExample}${ttOAuthInlineExample}</pre>

      <h3>Check OAuth Status</h3>
      <pre>GET ${origin}/auth/twitter/status?pubkey=hex64&amp;identity=jack</pre>

      <div class="note">OAuth verification is also checked as a fallback during proof-post verification for Twitter, Bluesky${extraPlatformNames}.</div>
    </section>

    <section id="other">
      <h2>Other Endpoints</h2>
      <div class="endpoint">
        <h3><span class="method get">GET</span> <code>/platforms</code></h3>
        <p>List supported platforms.</p>
      </div>
      <div class="endpoint">
        <h3><span class="method get">GET</span> <code>/health</code></h3>
        <p>Health check. Returns <code>{"status":"ok"}</code>.</p>
      </div>
    </section>

    <section id="rate-limits">
      <h2>Rate Limits &amp; Caching</h2>
      <table>
        <tr><th>Scope</th><th>Limit</th><th>Window</th></tr>
        <tr><td>Per IP</td><td>60 requests</td><td>1 minute</td></tr>
        <tr><td>Per pubkey</td><td>20 verifications</td><td>1 minute</td></tr>
        <tr><td>Per platform</td><td>30 outbound fetches</td><td>1 minute</td></tr>
        <tr><td>Batch max</td><td>10 claims</td><td>per request</td></tr>
      </table>
      <p style="margin-top:0.75rem;">Verified claims are cached for 24 hours, failures for 15 minutes, platform errors for 5 minutes.</p>
    </section>

    <script>
    const API = '${origin}';
    const DIVINE_LOGIN_URL = '${divineLoginUrl}';
    const KEYCAST_BASE = 'https://login.divine.video';
    const KEYCAST_CLIENT_ID = 'Divine Identity Verification';
    const KEYCAST_SCOPE = 'policy:social';
    const KEYCAST_SESSION_KEY = 'verifyer_keycast_session_v1';
    const KEYCAST_PKCE_KEY = 'verifyer_keycast_pkce_v1';
    const KEYCAST_STATE_KEY = 'verifyer_keycast_state_v1';
    const KEYCAST_HASH_KEY = 'verifyer_keycast_hash_v1';
    const NOSTR_TOOLS_NIP46_URL = 'https://esm.sh/nostr-tools@2.23.3/nip46?bundle';
    const NOSTR_TOOLS_PURE_URL = 'https://esm.sh/nostr-tools@2.23.3/pure?bundle';
    const PROFILE_RELAYS = ['wss://relay.divine.video', 'wss://relay.damus.io', 'wss://relay.nostr.band'];
    // NIP-46 traffic needs relays that accept kind 24133 events.
    const REMOTE_SIGNER_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social', 'wss://relay.primal.net'];
    let signerPubkeyHex = null;
    let activeSigner = null;
    let activeSignerSource = null;
    let nostrToolsPromise = null;
    let nostrConnectAbortController = null;

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

    function setStatus(elId, msg, type) {
      const el = document.getElementById(elId);
      if (!el) return;
      el.style.display = 'block';
      el.textContent = msg;
      el.style.background = type === 'error' ? '#fed7d7' : type === 'loading' ? '#fefcbf' : '#c6f6d5';
      el.style.color = type === 'error' ? '#c53030' : type === 'loading' ? '#975a16' : '#276749';
    }

    function clearStatus(elId) {
      const el = document.getElementById(elId);
      if (el) el.style.display = 'none';
    }

    function signerSourceLabel(source) {
      if (source === 'browser') return 'browser signer';
      if (source === 'keycast') return 'login.divine.video';
      if (source === 'bunker') return 'bunker';
      if (source === 'nostrconnect') return 'Nostr Connect';
      return '';
    }

    function updateSignerSummary() {
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
        throw new Error('Your login.divine.video session expired. Connect again.');
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
        nostrToolsPromise = Promise.all([
          import(NOSTR_TOOLS_NIP46_URL),
          import(NOSTR_TOOLS_PURE_URL),
        ]).then(function(modules) {
          return { nip46: modules[0], pure: modules[1] };
        });
      }
      return await nostrToolsPromise;
    }

    function safeDecodeText(input) {
      try {
        return decodeURIComponent(input);
      } catch {
        return input;
      }
    }

    async function resolveNip05ToHex(identifier) {
      const normalized = (identifier || '').trim().toLowerCase();
      const parts = normalized.split('@');
      if (parts.length !== 2) {
        throw new Error('That address does not look valid. Use format name@domain.');
      }
      const local = parts[0] || '_';
      const domain = parts[1];
      const resp = await fetch('https://' + domain + '/.well-known/nostr.json?name=' + encodeURIComponent(local));
      if (!resp.ok) {
        throw new Error('Could not find "' + normalized + '". Check spelling and try again.');
      }
      const data = await resp.json();
      const key = data && data.names ? data.names[local] : null;
      if (!key || !/^[0-9a-f]{64}$/i.test(key)) {
        throw new Error('That address did not resolve to a usable Nostr key.');
      }
      return key.toLowerCase();
    }

    function extractHexFromText(text) {
      const match = (text || '').match(/([0-9a-fA-F]{64})/);
      return match ? match[1].toLowerCase() : null;
    }

    function extractNpubFromText(text) {
      const match = (text || '').toLowerCase().match(/(npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)/);
      return match ? match[1] : null;
    }

    async function normalizePubkeyInput(raw) {
      const input = (raw || '').trim();
      if (!input) throw new Error('Enter your Divine address or npub first.');

      const decoded = safeDecodeText(input);
      const hex = extractHexFromText(decoded);
      if (hex) return hex;

      const npub = extractNpubFromText(decoded);
      if (npub) return npubToHex(npub);

      const nip05Match = decoded.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})/);
      if (nip05Match) return await resolveNip05ToHex(nip05Match[1]);

      throw new Error('Could not read your key. Paste a Divine address, npub, profile URL, or 64-character key.');
    }

    function setAccountInputValue(value) {
      const inputEl = document.getElementById('verify-pubkey-input');
      if (!inputEl) return;
      inputEl.value = value;
      if (value) localStorage.setItem('verifyer_account_input', value);
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
      const loginUrl = KEYCAST_BASE + '/api/auth/login';
      const unsignedEvent = {
        kind: 27235,
        content: '',
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['u', loginUrl],
          ['method', 'POST'],
        ],
      };

      setStatus('verify-login-status', 'Requesting signature from your browser signer...', 'loading');
      const signedEvent = await browserSigner.signEvent(unsignedEvent);
      if (!signedEvent || typeof signedEvent !== 'object') {
        throw new Error('Signer did not return a valid login event.');
      }

      setStatus('verify-login-status', 'Verifying login with login.divine.video...', 'loading');
      const resp = await fetch(API + '/auth/nostr/login', {
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
        throw new Error('The signed login event did not match your browser signer key.');
      }

      await activateSigner(browserSigner, 'browser', 'Signed in with your browser signer.');
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
      setStatus('verify-login-status', 'Finishing login.divine.video session...', 'loading');
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
        await activateSigner(createKeycastSigner(session), 'keycast', 'Connected with login.divine.video.');
      } catch (e) {
        clearKeycastSession();
        setStatus('verify-login-status', e.message || 'Could not connect login.divine.video.', 'error');
      } finally {
        cleanKeycastCallbackParams();
      }
      return true;
    }

    async function restoreKeycastSession() {
      const session = await getValidKeycastSession();
      if (!session) return false;
      try {
        await activateSigner(createKeycastSigner(session), 'keycast', 'Reconnected login.divine.video signer session.');
        return true;
      } catch {
        clearKeycastSession();
        return false;
      }
    }

    async function connectKeycastSigner() {
      clearStatus('verify-login-status');
      setStatus('verify-login-status', 'Opening secure login.divine.video...', 'loading');
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
        hideNostrConnectUi();
        await activateSigner(signer, 'bunker', 'Connected with bunker signer.');
      } catch (e) {
        setStatus('verify-login-status', e.message || 'Could not connect bunker signer.', 'error');
      } finally {
        setButtonLoading('connect-bunker-btn', false, '');
      }
    }

    async function startNostrConnect() {
      clearStatus('verify-login-status');
      try {
        setButtonLoading('start-nostr-connect-btn', true, 'Waiting...');
        setStatus('verify-login-status', 'Preparing Nostr Connect session...', 'loading');
        const tools = await loadNostrTools();
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
        if (nostrConnectAbortController) {
          nostrConnectAbortController.abort();
        }
        nostrConnectAbortController = new AbortController();
        showNostrConnectUi(uri);
        setStatus('verify-login-status', 'Waiting for your signer to approve the Nostr Connect request...', 'loading');
        const signer = await tools.nip46.BunkerSigner.fromURI(
          clientSecretKey,
          uri,
          {},
          nostrConnectAbortController.signal
        );
        nostrConnectAbortController = null;
        hideNostrConnectUi();
        await activateSigner(signer, 'nostrconnect', 'Connected with Nostr Connect.');
      } catch (e) {
        const aborted = e && (e.name === 'AbortError' || String(e.message || '').toLowerCase().includes('aborted'));
        if (aborted) {
          clearStatus('verify-login-status');
        } else {
          setStatus('verify-login-status', e.message || 'Could not connect with Nostr Connect.', 'error');
        }
      } finally {
        setButtonLoading('start-nostr-connect-btn', false, '');
      }
    }

    function cancelNostrConnect() {
      if (nostrConnectAbortController) {
        nostrConnectAbortController.abort();
        nostrConnectAbortController = null;
      }
      hideNostrConnectUi();
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
        if (isBrowserSignerAvailable()) {
          await connectBrowserSigner();
          return;
        }
        await connectKeycastSigner();
      } catch (e) {
        setStatus('verify-login-status', e.message || 'Could not sign in with Nostr.', 'error');
      } finally {
        setButtonLoading('connect-nostr-btn', false, '');
      }
    }

    async function getActivePubkey() {
      const accountInput = document.getElementById('verify-pubkey-input').value;
      if (accountInput && accountInput.trim()) {
        const parsed = await normalizePubkeyInput(accountInput);
        if (signerPubkeyHex && signerPubkeyHex !== parsed) {
          throw new Error('The typed account does not match your signed-in signer key.');
        }
        return parsed;
      }
      if (signerPubkeyHex) return signerPubkeyHex;
      throw new Error('Please sign in with Nostr first, or paste your account.');
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
        identityInput.placeholder = 'alice.bsky.social';
        proofLabel.textContent = 'Post link or proof ID (optional)';
        proofInput.placeholder = 'Paste full Bluesky post URL or leave blank for identity-link check';
        helper.textContent = 'Bluesky can verify by login or identity-link record, even without a post ID.';
      } else if (platform === 'github') {
        identityInput.placeholder = 'octocat';
        proofLabel.textContent = 'Gist link or Gist ID';
        proofInput.placeholder = 'https://gist.github.com/octocat/abc123... or abc123...';
        helper.textContent = 'Paste a gist URL and we will extract the ID for you.';
      } else if (platform === 'twitter') {
        identityInput.placeholder = 'jack';
        proofLabel.textContent = 'Post link or Tweet ID';
        proofInput.placeholder = 'https://x.com/jack/status/123... or 123...';
        helper.textContent = 'Paste an X/Twitter post URL for easiest setup.';
      } else if (platform === 'mastodon') {
        identityInput.placeholder = 'mastodon.social/@alice';
        proofLabel.textContent = 'Status link or Status ID';
        proofInput.placeholder = 'https://mastodon.social/@alice/123... or 123...';
        helper.textContent = 'Identity format is instance/@user. A full status URL also works.';
      } else if (platform === 'telegram') {
        identityInput.placeholder = 'mychannel';
        proofLabel.textContent = 'Message link or channel/message ID';
        proofInput.placeholder = 'https://t.me/mychannel/123 or mychannel/123';
        helper.textContent = 'Telegram proof should point to a public message that contains your npub.';
      } else if (platform === 'discord') {
        identityInput.placeholder = 'your server name';
        proofLabel.textContent = 'Invite link or invite code';
        proofInput.placeholder = 'https://discord.gg/abc123 or abc123';
        helper.textContent = 'Use a non-expiring invite and include your npub in server name/description.';
      } else if (platform === 'youtube') {
        identityInput.placeholder = 'UC... or @channelhandle';
        proofLabel.textContent = 'Video link or video ID';
        proofInput.placeholder = 'https://www.youtube.com/watch?v=... or 11-char ID';
        helper.textContent = 'We verify your npub inside the video description.';
      } else if (platform === 'tiktok') {
        identityInput.placeholder = 'username';
        proofLabel.textContent = 'Video link or video ID';
        proofInput.placeholder = 'https://www.tiktok.com/@user/video/123... or numeric ID';
        helper.textContent = 'Paste a TikTok video URL and we will extract the ID.';
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
        if (path[0] && path[1]) {
          const channel = path[0].replace(/^@/, '');
          return { identity: channel, proof: channel + '/' + path[1] };
        }
      }

      if (platform === 'discord') {
        if ((host === 'discord.gg' || host === 'www.discord.gg') && path[0]) {
          return { proof: path[0] };
        }
        if ((host === 'discord.com' || host === 'www.discord.com') && path[0] === 'invite' && path[1]) {
          return { proof: path[1] };
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
        const videoIdx = path.indexOf('video');
        if (videoIdx !== -1 && path[videoIdx + 1]) {
          return {
            identity: userPart ? userPart.slice(1) : undefined,
            proof: path[videoIdx + 1],
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
      if (platform === 'discord') {
        const maybeCodeUrl = tryMakeUrl(proof);
        if (maybeCodeUrl) {
          const parsed = parseProofUrl(platform, maybeCodeUrl);
          if (parsed.proof) proof = parsed.proof;
        }
      }

      proof = proof.replace(/^\\/+/, '').replace(/\\/+$/, '');
      return { identity, proof };
    }

    async function startOAuthVerification() {
      try {
        clearStatus('verify-global-status');
        clearStatus('oauth-status');
        setButtonLoading('oauth-start-btn', true, 'Opening sign-in...');
        setStatus('oauth-status', 'Checking your Divine account...', 'loading');

        const pubkey = await getActivePubkey();
        const platform = document.getElementById('oauth-platform-select').value;
        setAccountInputValue(pubkey);

        const params = new URLSearchParams({
          pubkey,
          return_url: window.location.origin + window.location.pathname + '#verify-here',
        });
        if (platform === 'bluesky') {
          const handle = document.getElementById('oauth-bluesky-handle-input').value.trim().replace(/^@/, '').toLowerCase();
          if (!handle) throw new Error('Enter your Bluesky handle (example: alice.bsky.social).');
          params.set('handle', handle);
        }
        setStatus('oauth-status', 'Opening secure ' + platform + ' sign-in...', 'loading');
        window.location.href = API + '/auth/' + platform + '/start?' + params.toString();
      } catch (e) {
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
          const method = data.method ? ' via ' + data.method.replace('_', ' ') : '';
          setStatus('proof-status', 'Success. This account is verified' + method + '.', 'ok');
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
          throw new Error('A signer session is required to publish. Connect a browser signer, login.divine.video, bunker, or Nostr Connect first.');
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

        setStatus('publish-status', 'Loading current kind 0 profile...', 'loading');
        let profile = null;
        for (const relay of PROFILE_RELAYS) {
          try {
            profile = await fetchProfile(relay, signerPubkey);
            if (profile) break;
          } catch {}
        }

        const content = profile && typeof profile.content === 'string' ? profile.content : '{}';
        const tags = Array.isArray(profile?.tags) ? profile.tags.filter(Array.isArray) : [];
        const claimKey = link.platform + ':' + link.identity;
        const nextTags = tags.filter(tag => !(tag[0] === 'i' && typeof tag[1] === 'string' && tag[1].toLowerCase() === claimKey.toLowerCase()));
        nextTags.push(['i', claimKey, link.proof]);

        const unsignedEvent = {
          kind: 0,
          created_at: Math.floor(Date.now() / 1000),
          tags: nextTags,
          content,
          pubkey: signerPubkey,
        };

        setStatus('publish-status', 'Requesting signature from your signer...', 'loading');
        const signedEvent = await activeSigner.signEvent(unsignedEvent);
        if (!signedEvent || !signedEvent.id || !signedEvent.sig) {
          throw new Error('Signer did not return a valid signed event.');
        }
        if (String(signedEvent.pubkey || '').toLowerCase() !== signerPubkey) {
          throw new Error('Signer returned an event for a different pubkey.');
        }

        setStatus('publish-status', 'Publishing kind 0 event to relays...', 'loading');
        const relayResults = await Promise.all(PROFILE_RELAYS.map(relay => publishEventToRelay(relay, signedEvent)));
        const successCount = relayResults.filter(r => r.ok).length;
        if (successCount === 0) {
          const firstError = relayResults[0] && relayResults[0].message ? relayResults[0].message : 'no relay accepted the event';
          throw new Error('Publish failed: ' + firstError);
        }

        setStatus('publish-status', 'Published to ' + successCount + '/' + PROFILE_RELAYS.length + ' relays. Your Nostr profile link is now updated.', 'ok');
      } catch (e) {
        setStatus('publish-status', e.message || 'Could not publish to Nostr profile.', 'error');
      } finally {
        setButtonLoading('publish-kind0-btn', false, '');
      }
    }

    function handleOAuthCallbackMessage() {
      const params = new URLSearchParams(window.location.search);
      let shouldClean = false;
      if (params.get('oauth_verified') === 'true') {
        const platform = params.get('platform') || 'account';
        const identity = params.get('identity') || '';
        setStatus('verify-global-status', 'Success. Your ' + platform + ' account is now linked' + (identity ? ': ' + identity : '') + '. You can now publish this to your Nostr profile below.', 'ok');

        // Pre-fill the Advanced section so the Publish button works for this OAuth result
        const proofPlatformEl = document.getElementById('proof-platform-select');
        const proofIdentityEl = document.getElementById('proof-identity-input');
        const proofProofEl = document.getElementById('proof-proof-input');
        if (proofPlatformEl && proofIdentityEl) {
          proofPlatformEl.value = platform;
          proofIdentityEl.value = identity;
          if (proofProofEl) proofProofEl.value = 'oauth';
          // Open the Advanced section and scroll the publish button into view
          const advancedDetails = document.getElementById('advanced-proof');
          if (advancedDetails) {
            advancedDetails.open = true;
            const publishBtn = document.getElementById('publish-kind0-btn');
            if (publishBtn) publishBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }

        shouldClean = true;
      } else if (params.get('oauth_error')) {
        setStatus('verify-global-status', 'Sign-in was not completed: ' + params.get('oauth_error'), 'error');
        shouldClean = true;
      }
      if (shouldClean) {
        params.delete('oauth_verified');
        params.delete('platform');
        params.delete('identity');
        params.delete('oauth_error');
        const cleanUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
        window.history.replaceState({}, '', cleanUrl);
      }
    }

    function showStatus(msg, type) {
      const el = document.getElementById('lookup-status');
      el.style.display = 'block';
      el.textContent = msg;
      el.style.background = type === 'error' ? '#fed7d7' : type === 'loading' ? '#fefcbf' : '#c6f6d5';
      el.style.color = type === 'error' ? '#c53030' : type === 'loading' ? '#975a16' : '#276749';
    }

    function hideStatus() { clearStatus('lookup-status'); }

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
        const relays = PROFILE_RELAYS;
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
        }).filter(c => ['github','twitter','mastodon','telegram','bluesky','discord'${extraLookupPlatforms}].includes(c.platform));

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

    // Verify Here wiring
    document.getElementById('connect-nostr-btn').addEventListener('click', connectNostrSigner);
    document.getElementById('connect-keycast-btn').addEventListener('click', async () => {
      clearStatus('verify-login-status');
      try {
        setButtonLoading('connect-keycast-btn', true, 'Opening...');
        await connectKeycastSigner();
      } catch (e) {
        setStatus('verify-login-status', e.message || 'Could not open login.divine.video.', 'error');
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
    document.getElementById('verify-pubkey-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startOAuthVerification();
    });
    document.getElementById('proof-identity-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifySingleHere();
    });
    document.getElementById('proof-proof-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifySingleHere();
    });
    document.getElementById('bunker-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') connectBunkerSigner();
    });
    document.getElementById('verify-pubkey-input').addEventListener('blur', () => {
      const value = document.getElementById('verify-pubkey-input').value.trim();
      if (value) localStorage.setItem('verifyer_account_input', value);
    });
    const savedAccountInput = localStorage.getItem('verifyer_account_input');
    if (savedAccountInput) {
      document.getElementById('verify-pubkey-input').value = savedAccountInput;
    }
    updateOAuthInputs();
    updateProofInputs();
    handleOAuthCallbackMessage();
    updateSignerSummary();
    (async () => {
      const handledKeycast = await maybeHandleKeycastCallback();
      if (!handledKeycast) {
        applyLoginQueryHint();
        await restoreKeycastSession();
      }
      updateSignerSummary();
    })();

    // Lookup tool Enter key
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
