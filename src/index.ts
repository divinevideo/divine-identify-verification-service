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
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Divine Identity Verification — Prove You Are Who You Say You Are</title>
  <meta name="description" content="Verify your identity across platforms. Link your Twitter, GitHub, Bluesky, Mastodon, YouTube, TikTok, and more to your Nostr profile to prevent impersonation and build trust.">
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
        <p>When someone finds your Divine profile, they can see that your Twitter, GitHub, Bluesky, YouTube, and other accounts are all confirmed to be you. No guessing, no doubt.</p>
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
      <div class="platform-pill">
        <svg viewBox="0 0 24 24" fill="#333"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
        YouTube
      </div>
      <div class="platform-pill">
        <svg viewBox="0 0 24 24" fill="#333"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>
        TikTok
      </div>
    </div>

    <!-- HOW TO VERIFY -->
    <section id="how-to-verify">
      <h2>How to Get Verified</h2>
      <p>It takes about a minute. You're basically telling both platforms "these accounts belong to the same person."</p>

      <div class="steps">
        <div class="step">
          <div class="step-number">1</div>
          <h4>Open your Divine settings</h4>
          <p>Go to <a href="https://divine.video">divine.video</a> and click on your profile settings.</p>
        </div>
        <div class="step">
          <div class="step-number">2</div>
          <h4>Pick a platform to link</h4>
          <p>Choose Twitter, GitHub, Bluesky, Mastodon, Telegram, Discord, YouTube, or TikTok.</p>
        </div>
        <div class="step">
          <div class="step-number">3</div>
          <h4>Connect your account</h4>
          <p>For Twitter and Bluesky, just log in. For others, post a short message that includes your unique key.</p>
        </div>
        <div class="step">
          <div class="step-number">4</div>
          <h4>Done &mdash; you're verified</h4>
          <p>A checkmark shows up on your profile. Anyone can click it to confirm the link is real.</p>
        </div>
      </div>

      <div class="note">
        <strong>No posting required for Twitter, Bluesky, YouTube, and TikTok.</strong> Just sign in with your account and we'll confirm it's yours. For other platforms, you post a short proof message &mdash; you can delete it afterward if you want, though it's better to keep it up.
      </div>
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
        <li><strong>OAuth login</strong> (Twitter, Bluesky, YouTube, TikTok) &mdash; User authenticates directly. No proof post needed.</li>
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
        <tr>
          <td><code>youtube</code></td>
          <td>Channel ID (<code>UCxxxx</code>) or handle (<code>@user</code>)</td>
          <td>Video ID (11 chars)</td>
          <td>Yes</td>
        </tr>
        <tr>
          <td><code>tiktok</code></td>
          <td>Username (without @)</td>
          <td>Video ID (numeric)</td>
          <td>Yes</td>
        </tr>
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
        <tr><td><code>platform</code></td><td>string</td><td>One of: <code>github</code>, <code>twitter</code>, <code>bluesky</code>, <code>mastodon</code>, <code>telegram</code>, <code>discord</code>, <code>youtube</code>, <code>tiktok</code></td></tr>
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
      <h2>OAuth Verification (Twitter, Bluesky, YouTube, TikTok)</h2>
      <p>Users can verify by logging in instead of posting a proof.</p>

      <h3>Start OAuth</h3>
      <pre>GET ${origin}/auth/twitter/start?pubkey=hex64&amp;return_url=https://divine.video/settings
GET ${origin}/auth/bluesky/start?pubkey=hex64&amp;handle=alice.bsky.social&amp;return_url=https://divine.video/settings
GET ${origin}/auth/youtube/start?pubkey=hex64&amp;return_url=https://divine.video/settings
GET ${origin}/auth/tiktok/start?pubkey=hex64&amp;return_url=https://divine.video/settings</pre>

      <h3>Check OAuth Status</h3>
      <pre>GET ${origin}/auth/twitter/status?pubkey=hex64&amp;identity=jack</pre>

      <div class="note">OAuth verification is also checked as a fallback during proof-post verification for Twitter, Bluesky, YouTube, and TikTok.</div>
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
        }).filter(c => ['github','twitter','mastodon','telegram','bluesky','discord','youtube','tiktok'].includes(c.platform));

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
