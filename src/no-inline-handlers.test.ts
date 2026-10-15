import { describe, expect, it } from 'vitest'
import worker from './index'
import { renderVerifyHtml } from './routes/verify'
import type { VerifyResult } from './types'

// A Content-Security-Policy with a script nonce blocks inline event-handler
// attributes and javascript: links, so neither page may carry one. Buttons are
// wired from each page's script instead.

const API = 'https://verifier.divine.video'
const PUBKEY = 'ab'.repeat(32)
const RESULT: VerifyResult = { platform: 'github', identity: 'octocat', verified: true, checked_at: 1_700_000_000, cached: false }

const INLINE_HANDLER = /<[a-z][^>]*\s+on[a-z]+\s*=/i
const JAVASCRIPT_URL = /(?:href|src|action|formaction|xlink:href)\s*=\s*["']?\s*javascript:/i

// The page with its <script> bodies removed, so only markup is checked.
function markupOnly(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '')
}

async function mainPage(): Promise<string> {
  return (await worker.fetch(new Request(`${API}/`), {} as never)).text()
}

function verificationPage(): string {
  return renderVerifyHtml(RESULT, 'github', 'octocat', 'abc123', PUBKEY, 'npub1test', `${API}/verify/github/octocat/abc123?pubkey=${PUBKEY}`, API)
}

describe('pages carry no inline handlers', () => {
  it('the main page has no on* attribute and no javascript: URL in its markup', async () => {
    const markup = markupOnly(await mainPage())
    expect(markup).not.toMatch(INLINE_HANDLER)
    expect(markup).not.toMatch(JAVASCRIPT_URL)
  })

  it('the verification-link page has no on* attribute and no javascript: URL in its markup', () => {
    const markup = markupOnly(verificationPage())
    expect(markup).not.toMatch(INLINE_HANDLER)
    expect(markup).not.toMatch(JAVASCRIPT_URL)
  })

  it('neither page builds on* attributes or javascript: URLs inside its script strings', async () => {
    for (const html of [await mainPage(), verificationPage()]) {
      expect(html).not.toMatch(/\son[a-z]+\s*=\s*["'\\]/i)
      expect(html).not.toMatch(/javascript:/i)
    }
  })

  it('the main page wires its four buttons from script', async () => {
    const html = await mainPage()
    for (const [id, fn] of [
      ['load-links-btn', 'loadLinkedVerifications'],
      ['remove-cancel-btn', 'cancelRemove'],
      ['remove-confirm-btn', 'executeRemoveVerification'],
      ['lookup-btn', 'doLookup'],
    ]) {
      expect(html).toContain(`id="${id}"`)
      expect(html).toContain(`document.getElementById('${id}').addEventListener('click', ${fn});`)
    }
  })
})
