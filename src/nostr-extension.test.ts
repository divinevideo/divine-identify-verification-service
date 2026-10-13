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

// Runs the page's real "Use a Nostr extension" handler (connectNostrSigner,
// with the extension check it uses) against stand-ins for the browser and the
// two ways it can sign in.
async function loadConnectNostrSigner() {
  const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)).text()
  const source = [
    scriptBetween(html, 'function isBrowserSignerAvailable()', 'function createBrowserSigner()'),
    scriptBetween(html, 'async function connectNostrSigner()', 'async function getActivePubkey()'),
  ].join('\n')
  const deps = ['window', 'clearStatus', 'setStatus', 'setButtonLoading', 'connectBrowserSigner', 'connectKeycastSigner']
  return (env: Record<string, unknown>) =>
    new Function(...deps, `${source}\nreturn connectNostrSigner;`)(...deps.map(d => env[d]))
}

function harness(nostr?: unknown) {
  const statuses: Array<[string, string, string]> = []
  const calls: string[] = []
  const env = {
    window: nostr === undefined ? {} : { nostr },
    clearStatus: () => {},
    setStatus: (id: string, msg: string, type: string) => { statuses.push([id, msg, type]) },
    setButtonLoading: () => {},
    connectBrowserSigner: async () => { calls.push('extension') },
    connectKeycastSigner: async () => { calls.push('divine login') },
  }
  return { env, statuses, calls }
}

const extension = { getPublicKey: async () => 'ab'.repeat(32), signEvent: async () => ({}) }

describe('"Use a Nostr extension"', () => {
  it('says no extension was found, and stays on the page, when none is installed', async () => {
    const h = harness()
    await (await loadConnectNostrSigner())(h.env)()
    expect(h.calls).toEqual([])
    expect(h.statuses).toEqual([['verify-login-status', 'No Nostr extension found. Sign in with your Divine login instead, or install one.', 'error']])
  })

  // Inside the Divine app's frame the page installs its own window.nostr and
  // connects this way on load, so that path must keep using the extension.
  it('signs in with the extension when there is one', async () => {
    const h = harness(extension)
    await (await loadConnectNostrSigner())(h.env)()
    expect(h.calls).toEqual(['extension'])
    expect(h.statuses).toEqual([])
  })
})
