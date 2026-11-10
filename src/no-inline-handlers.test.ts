import { describe, expect, it } from 'vitest'
import worker from './index'
import { renderVerifyHtml } from './routes/verify'
import type { VerifyResult } from './types'

// A Content-Security-Policy with a script nonce blocks inline event-handler
// attributes and javascript: links, so no page may carry one. Buttons are
// wired from each page's script instead.

const API = 'https://verifier.divine.video'
const PUBKEY = 'ab'.repeat(32)
const RESULT: VerifyResult = { platform: 'github', identity: 'octocat', verified: true, checked_at: 1_700_000_000, cached: false }

// Every start tag, treating a '>' inside a quoted attribute value as part of it.
const START_TAG = /<[a-z](?:"[^"]*"|'[^']*'|[^>"'])*>/gi

// True when a start tag carries an on* attribute, whatever its quoting.
function hasInlineHandler(markup: string): boolean {
  return (markup.match(START_TAG) ?? []).some(tag => /\son[a-z]+\s*=/i.test(tag.replace(/"[^"]*"|'[^']*'/g, '""')))
}
const JAVASCRIPT_URL = /(?:href|src|action|formaction|xlink:href)\s*=\s*["']?\s*javascript:/i

// The page with its <script> bodies removed, so only markup is checked.
function markupOnly(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '')
}

async function mainPage(): Promise<string> {
  return (await worker.fetch(new Request(`${API}/`), {} as never)).text()
}

async function lookupPage(): Promise<string> {
  return (await worker.fetch(new Request(`${API}/lookup`), {} as never)).text()
}

function verificationPage(): string {
  return renderVerifyHtml(RESULT, 'github', 'octocat', 'abc123', PUBKEY, 'npub1test', `${API}/verify/github/octocat/abc123?pubkey=${PUBKEY}`, API, 'test-nonce')
}

const BUTTONS: Array<[string, string]> = [
  ['load-links-btn', 'loadLinkedVerifications'],
  ['remove-cancel-btn', 'cancelRemove'],
  ['remove-confirm-btn', 'executeRemoveVerification'],
  ['retry-revoke-btn', 'retryRemoveVerification'],
]

// Runs the page's real button-wiring lines against stand-in buttons, so a
// commented-out, misplaced or mis-paired listener fails here, not on the live page.
async function wireButtons() {
  const html = await mainPage()
  const start = html.indexOf('// Buttons wired here rather')
  const end = html.indexOf('// Start-up: a returning sign-in is handled first', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const listeners: Record<string, Array<[string, () => void]>> = {}
  const calls: string[] = []
  const document = {
    getElementById: (id: string) => BUTTONS.some(([b]) => b === id)
      ? { addEventListener: (type: string, fn: () => void) => { (listeners[id] ??= []).push([type, fn]) } }
      : null,
  }
  const handlers = BUTTONS.map(([, fn]) => () => { calls.push(fn) })
  new Function('document', ...BUTTONS.map(([, fn]) => fn), html.slice(start, end))(document, ...handlers)
  const click = (id: string) => (listeners[id] ?? []).forEach(([type, fn]) => { if (type === 'click') fn() })
  return { click, calls }
}

// Runs the lookup page's real wiring lines against a stand-in button and input
// box, so a missing or mis-paired listener fails here, not on the live page.
async function wireLookup() {
  const html = await lookupPage()
  const start = html.indexOf('// Wired here, not with inline onclick attributes')
  const end = html.indexOf('</script>', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const listeners: Record<string, Array<[string, (event: unknown) => void]>> = {}
  const calls: string[] = []
  const document = {
    getElementById: (id: string) => ['lookup-btn', 'lookup-input'].includes(id)
      ? { addEventListener: (type: string, fn: (event: unknown) => void) => { (listeners[id] ??= []).push([type, fn]) } }
      : null,
  }
  new Function('document', 'doLookup', html.slice(start, end))(document, () => { calls.push('doLookup') })
  const fire = (id: string, type: string, event: unknown) =>
    (listeners[id] ?? []).forEach(([t, fn]) => { if (t === type) fn(event) })
  return { fire, calls }
}

describe('pages carry no inline handlers', () => {
  it('the main page has no on* attribute and no javascript: URL in its markup', async () => {
    const markup = markupOnly(await mainPage())
    expect(hasInlineHandler(markup)).toBe(false)
    expect(markup).not.toMatch(JAVASCRIPT_URL)
  })

  it('the lookup page has no on* attribute and no javascript: URL in its markup', async () => {
    const markup = markupOnly(await lookupPage())
    expect(hasInlineHandler(markup)).toBe(false)
    expect(markup).not.toMatch(JAVASCRIPT_URL)
  })

  it('the verification-link page has no on* attribute and no javascript: URL in its markup', () => {
    const markup = markupOnly(verificationPage())
    expect(hasInlineHandler(markup)).toBe(false)
    expect(markup).not.toMatch(JAVASCRIPT_URL)
  })

  it('no page builds on* attributes or javascript: URLs inside its script strings', async () => {
    for (const html of [await mainPage(), await lookupPage(), verificationPage()]) {
      expect(html).not.toMatch(/\son[a-z]+\s*=\s*["'\\]/i)
      expect(html).not.toMatch(/javascript:/i)
    }
  })

  it('the checker sees an on* attribute after a quoted ">"', () => {
    expect(hasInlineHandler('<div data-x=">" onclick="go()">')).toBe(true)
    expect(hasInlineHandler('<div data-x=">" class="a">')).toBe(false)
  })

  it('the main page has each wired button once', async () => {
    const html = await mainPage()
    for (const [id] of BUTTONS) expect(html.split(`id="${id}"`).length - 1).toBe(1)
  })

  it('every wired button is type="button", so it can never submit a form', async () => {
    const html = await mainPage()
    for (const [id] of BUTTONS) expect(html).toMatch(new RegExp(`<button id="${id}"[^>]*type="button"|<button[^>]*type="button"[^>]*id="${id}"`))
  })

  it('the lookup page has lookup-btn once, and it is type="button"', async () => {
    const html = await lookupPage()
    expect(html.split('id="lookup-btn"').length - 1).toBe(1)
    expect(html).toMatch(/<button id="lookup-btn"[^>]*type="button"/)
  })

  it('clicking lookup-btn on /lookup runs doLookup, and nothing else', async () => {
    const page = await wireLookup()
    page.fire('lookup-btn', 'click', {})
    expect(page.calls).toEqual(['doLookup'])
  })

  it('pressing Enter in the /lookup box runs doLookup; other keys do not', async () => {
    const page = await wireLookup()
    page.fire('lookup-input', 'keydown', { key: 'a' })
    expect(page.calls).toEqual([])
    page.fire('lookup-input', 'keydown', { key: 'Enter' })
    expect(page.calls).toEqual(['doLookup'])
  })

  it.each(BUTTONS)('clicking %s runs %s, and nothing else', async (id, fn) => {
    const page = await wireButtons()
    page.click(id)
    expect(page.calls).toEqual([fn])
  })

  it('the buttons are wired before start-up code runs, so a start-up error cannot leave them dead', async () => {
    const html = await mainPage()
    const startUp = html.indexOf('// Start-up: a returning sign-in is handled first')
    expect(startUp).toBeGreaterThan(-1)
    for (const id of ['load-links-btn', 'remove-cancel-btn', 'remove-confirm-btn']) {
      const wired = html.indexOf(`getElementById('${id}').addEventListener(`)
      expect(wired).toBeGreaterThan(-1)
      expect(wired).toBeLessThan(startUp)
    }
  })
})
