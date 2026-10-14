import { describe, expect, it } from 'vitest'
import worker from './index'

// The part of the page's script from one marker up to the next.
function scriptBetween(html: string, from: string, to: string): string {
  const start = html.indexOf(from)
  const end = html.indexOf(to, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

// Runs the page's real "Use a Nostr extension" code (connectNostrSigner, the
// extension check, the extension sign-in and the signed-in label) against
// stand-ins for the browser and the Divine login.
async function loadSignIn() {
  const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)).text()
  const source = [
    scriptBetween(html, 'function signerSourceLabel(source)', 'function updateSignerSummary()'),
    scriptBetween(html, 'function isBrowserSignerAvailable()', 'function createBrowserSigner()'),
    scriptBetween(html, 'async function connectBrowserSigner()', 'async function startKeycastLogin()'),
    scriptBetween(html, 'async function connectNostrSigner()', 'async function getActivePubkey()'),
  ].join('\n')
  const deps = ['window', 'API', 'fetch', 'clearStatus', 'setStatus', 'setButtonLoading', 'createBrowserSigner', 'activateSigner', 'connectKeycastSigner']
  return (env: Record<string, unknown>) =>
    new Function(...deps, `${source}\nreturn { connectNostrSigner, signerSourceLabel };`)(...deps.map(d => env[d]))
}

const KEY = 'ab'.repeat(32)
const extension = { getPublicKey: async () => KEY, signEvent: async () => ({ id: 'x', sig: 'y', pubkey: KEY }) }

function harness(opts: { nostr?: unknown, embedded?: boolean, loginPubkey?: string } = {}) {
  const statuses: Array<[string, string, string]> = []
  const calls: string[] = []
  const signedIn: Array<[string, string]> = []
  const win: Record<string, unknown> = {}
  if (opts.nostr !== undefined) win.nostr = opts.nostr
  if (opts.embedded) win.__divineEmbedded = true
  const env = {
    window: win,
    API: 'https://verifier.divine.video',
    fetch: async () => ({ ok: true, json: async () => ({ pubkey: opts.loginPubkey ?? KEY }) }),
    clearStatus: () => {},
    setStatus: (id: string, msg: string, type: string) => { statuses.push([id, msg, type]) },
    setButtonLoading: () => {},
    createBrowserSigner: () => { calls.push('extension'); return win.nostr },
    activateSigner: async (_signer: unknown, source: string, message: string) => { signedIn.push([source, message]) },
    connectKeycastSigner: async () => { calls.push('divine login') },
  }
  return { env, statuses, calls, signedIn }
}

describe('"Use a Nostr extension"', () => {
  it('says no extension was found, and stays on the page, when none is installed', async () => {
    const h = harness()
    await (await loadSignIn())(h.env).connectNostrSigner()
    expect(h.calls).toEqual([])
    expect(h.statuses).toEqual([['verify-login-status', 'No Nostr extension found. Sign in with your Divine login instead, or install one.', 'error']])
  })

  it('signs in with the extension when there is one, and names it', async () => {
    const h = harness({ nostr: extension })
    await (await loadSignIn())(h.env).connectNostrSigner()
    expect(h.calls).toEqual(['extension'])
    expect(h.statuses[0]).toEqual(['verify-login-status', 'Requesting a signature from your Nostr extension...', 'loading'])
    expect(h.signedIn).toEqual([['browser', 'Signed in with your Nostr extension.']])
  })

  it('says the sign-in did not match the extension\'s account when it does not', async () => {
    const h = harness({ nostr: extension, loginPubkey: 'cd'.repeat(32) })
    await (await loadSignIn())(h.env).connectNostrSigner()
    expect(h.signedIn).toEqual([])
    expect(h.statuses[h.statuses.length - 1]).toEqual(['verify-login-status', "The sign-in didn't match the account in your Nostr extension. Try again.", 'error'])
  })
})

// Inside the Divine app's frame the page signs in on load through the app's
// own window.nostr. Those people are signed in to Divine and have no
// extension, so the page speaks of their Divine account.
describe('signing in inside the Divine app', () => {
  it('speaks of the Divine account, not an extension', async () => {
    const h = harness({ nostr: extension, embedded: true })
    const page = (await loadSignIn())(h.env)
    await page.connectNostrSigner()
    expect(h.statuses[0]).toEqual(['verify-login-status', 'Requesting a signature from your Divine account...', 'loading'])
    expect(h.signedIn).toEqual([['embedded', 'Signed in with your Divine account.']])
    expect(page.signerSourceLabel('embedded')).toBe('your Divine account')
    expect(h.statuses.map(([, msg]) => msg).join(' ')).not.toMatch(/extension/i)
  })

  it('says the sign-in did not match the Divine account when it does not', async () => {
    const h = harness({ nostr: extension, embedded: true, loginPubkey: 'cd'.repeat(32) })
    await (await loadSignIn())(h.env).connectNostrSigner()
    expect(h.statuses[h.statuses.length - 1]).toEqual(['verify-login-status', "The sign-in didn't match your Divine account. Try again.", 'error'])
  })

  // The app's window.nostr is always there when the page knows it is
  // embedded. If it ever went missing, keep the earlier behaviour (open the
  // Divine login) rather than tell someone in the app to install an extension.
  it('never says "No Nostr extension found"', async () => {
    const h = harness({ embedded: true })
    await (await loadSignIn())(h.env).connectNostrSigner()
    expect(h.calls).toEqual(['divine login'])
    expect(h.statuses.map(([, msg]) => msg).join(' ')).not.toContain('No Nostr extension found')
  })
})

// Runs the page's real updateSignerSummary against a stub Step 1. The signer
// state lives in the loaded code, so clearSigner can drop it between calls.
async function summaryHarness(opts: { embedded: boolean, signer: boolean, source: string }) {
  const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)).text()
  const source = scriptBetween(html, 'function signerSourceLabel(source)', 'function isBrowserSignerAvailable()')
  const elements: Record<string, { hidden?: boolean, style?: { display: string }, textContent?: string }> = {
    'step1-signin-options': { hidden: false },
    'step1-remote-signer-options': { hidden: false },
    'signer-session-summary': { style: { display: 'none' }, textContent: '' },
  }
  const document = { getElementById: (id: string) => elements[id] ?? null }
  const window = opts.embedded ? { __divineEmbedded: true } : {}
  const signer = opts.signer ? extension : null
  const page = new Function('document', 'window', 'signer', 'source', 'key', `
    let activeSigner = signer;
    let activeSignerSource = signer ? source : null;
    let signerPubkeyHex = signer ? key : null;
    ${source}
    return {
      updateSignerSummary,
      clearSigner() { activeSigner = null; activeSignerSource = null; signerPubkeyHex = null; },
    };`)(document, window, signer, opts.source, KEY)
  return { page, elements, clearSigner: page.clearSigner as () => void }
}

describe('Step 1 inside the Divine app', () => {
  it('inside the Divine app, Step 1 shows only that you are signed in', async () => {
    const h = await summaryHarness({ embedded: true, signer: true, source: 'embedded' })
    h.page.updateSignerSummary()
    expect(h.elements['step1-signin-options'].hidden).toBe(true)
    expect(h.elements['step1-remote-signer-options'].hidden).toBe(true)
    expect(h.elements['signer-session-summary'].style?.display).toBe('block')
    expect(h.elements['signer-session-summary'].textContent).toContain('Connected via your Divine account.')
  })

  it('in a browser, Step 1 keeps every way to sign in', async () => {
    const h = await summaryHarness({ embedded: false, signer: true, source: 'keycast' })
    h.page.updateSignerSummary()
    expect(h.elements['step1-signin-options'].hidden).toBe(false)
    expect(h.elements['step1-remote-signer-options'].hidden).toBe(false)
  })

  it('inside the Divine app, Step 1 keeps the ways to sign in after signing in with the Divine login instead', async () => {
    const h = await summaryHarness({ embedded: true, signer: true, source: 'keycast' })
    h.page.updateSignerSummary()
    expect(h.elements['step1-signin-options'].hidden).toBe(false)
    expect(h.elements['step1-remote-signer-options'].hidden).toBe(false)
  })

  // A remembered sign-in can bring back the 'embedded' source on a load
  // outside the app (reattachSigner), so the source alone isn't enough.
  it('outside the Divine app, Step 1 keeps every way to sign in even when the signer source reads embedded', async () => {
    const h = await summaryHarness({ embedded: false, signer: true, source: 'embedded' })
    h.page.updateSignerSummary()
    expect(h.elements['step1-signin-options'].hidden).toBe(false)
    expect(h.elements['step1-remote-signer-options'].hidden).toBe(false)
  })

  it('inside the Divine app, Step 1 shows the ways to sign in again once the signer is gone', async () => {
    const h = await summaryHarness({ embedded: true, signer: true, source: 'embedded' })
    h.page.updateSignerSummary()
    h.clearSigner()
    h.page.updateSignerSummary()
    expect(h.elements['step1-signin-options'].hidden).toBe(false)
    expect(h.elements['step1-remote-signer-options'].hidden).toBe(false)
  })
})
