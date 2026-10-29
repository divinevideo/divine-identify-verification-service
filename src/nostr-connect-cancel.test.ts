import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index'

// Runs the landing page's real Nostr Connect start and Cancel (#150) with the
// nostr-tools module the page loads, against stand-in relays, so the tests
// exercise the shipped script and library rather than copies of them.

const API = 'https://verifier.divine.video'
const RELAYS = ['wss://one.example', 'wss://two.example', 'wss://three.example', 'wss://four.example']
const SECRET = 'S'.repeat(24)

type Handler = ((event: unknown) => void) | null

// Every socket the library opened in the current test.
let sockets: FakeWebSocket[] = []
// When set, new sockets wait in CONNECTING until a test opens them.
let holdConnecting = false
// Messages sent on a socket that wasn't open, which a browser reports as an error.
let sentWhileClosed: string[] = []

// A relay that answers REQ with EOSE and EVENT with OK, and forgets a
// subscription on CLOSE. Like a browser socket, a socket closed while still
// connecting never opens.
class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = FakeWebSocket.CONNECTING
  onopen: Handler = null
  onclose: Handler = null
  onerror: Handler = null
  onmessage: Handler = null
  subscriptions = new Set<string>()

  constructor(readonly url: string) {
    sockets.push(this)
    if (!holdConnecting) setTimeout(() => this.open(), 0)
  }

  open() {
    if (this.readyState !== FakeWebSocket.CONNECTING) return
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      sentWhileClosed.push(data)
      return
    }
    const message = JSON.parse(data)
    if (message[0] === 'REQ') {
      this.subscriptions.add(message[1])
      this.deliver(['EOSE', message[1]])
    } else if (message[0] === 'CLOSE') {
      this.subscriptions.delete(message[1])
    } else if (message[0] === 'EVENT') {
      this.deliver(['OK', message[1].id, true, ''])
    }
  }

  deliver(message: unknown) {
    setTimeout(() => {
      if (this.readyState === FakeWebSocket.OPEN) this.onmessage?.({ data: JSON.stringify(message) })
    }, 0)
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    const wasConnecting = this.readyState === FakeWebSocket.CONNECTING
    this.readyState = FakeWebSocket.CLOSED
    this.subscriptions.clear()
    setTimeout(() => {
      if (wasConnecting) this.onerror?.({})
      this.onclose?.({ code: 1000 })
    }, 0)
  }
}

// Loaded by name at run time: the type check resolves packages the way the
// worker build does, which doesn't see nostr-tools' subpath exports.
const VENDOR_MODULE = '/public/vendor/nostr-tools.mjs'
const NIP44 = 'nostr-tools/nip44'
const PURE = 'nostr-tools/pure'

// The library keeps the WebSocket it finds when the module loads.
let vendorModule: Promise<unknown> | null = null
function loadVendor() {
  if (!vendorModule) {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vendorModule = import(VENDOR_MODULE)
  }
  return vendorModule
}

// The part of the page's script from one marker up to the next.
function scriptBetween(html: string, from: string, to: string): string {
  const start = html.indexOf(from)
  const end = html.indexOf(to, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

const DEPS = ['document', 'loadNostrTools', 'REMOTE_SIGNER_RELAYS', 'randomBase64Url', 'window', 'WebSocket', 'AbortController',
  'setButtonLoading', 'setStatus', 'clearStatus', 'showNostrConnectUi', 'hideNostrConnectUi', 'activateSigner']

async function nostrConnectHarness(opts: { activationFails?: boolean } = {}) {
  const res = await worker.fetch(new Request(`${API}/`), {} as never)
  const html = await res.text()
  const source = scriptBetween(html, 'async function connectBunkerSigner()', 'async function copyNostrConnectUri()')

  const vendor = await loadVendor() as { nip46: { BunkerSigner: { fromURI: unknown } } }
  // The real library, except that a bunker connects at once: these tests are
  // about what the page does with the Nostr Connect request around it.
  const tools = {
    ...vendor,
    nip46: {
      ...vendor.nip46,
      parseBunkerInput: async () => ({ pubkey: 'ab'.repeat(32), relays: ['wss://bunker.example'], secret: null }),
      BunkerSigner: {
        fromURI: vendor.nip46.BunkerSigner.fromURI,
        fromBunker: () => ({ connect: async () => {} }),
      },
    },
  }
  const { encrypt, getConversationKey } = await import(NIP44)
  const { finalizeEvent, generateSecretKey } = await import(PURE)
  const button: boolean[] = []
  const signedIn: string[] = []
  const statuses: Array<[string, string]> = []
  let shownUri = ''
  const env: Record<string, unknown> = {
    document: { getElementById: (id: string) => (id === 'bunker-input' ? { value: 'bunker://example' } : null) },
    loadNostrTools: async () => tools,
    REMOTE_SIGNER_RELAYS: RELAYS,
    randomBase64Url: () => SECRET,
    window: { location: { origin: API } },
    WebSocket: FakeWebSocket,
    AbortController,
    setButtonLoading: (id: string, loading: boolean) => { if (id === 'start-nostr-connect-btn') button.push(loading) },
    setStatus: (_id: string, message: string, type: string) => { statuses.push([message, type]) },
    clearStatus: () => { statuses.push(['', 'cleared']) },
    showNostrConnectUi: (uri: string) => { shownUri = uri },
    hideNostrConnectUi: () => {},
    activateSigner: async (_signer: unknown, source: string) => {
      if (opts.activationFails) throw new Error('Signer returned an invalid pubkey.')
      signedIn.push(source)
    },
  }
  const page = new Function(...DEPS,
    `let nostrConnectAttempt = null;\n${source}\nreturn { startNostrConnect, cancelNostrConnect, connectBunkerSigner };`,
  )(...DEPS.map(d => env[d]))

  // The signer's approval of the shown request, sent on every subscription
  // still open on an open relay. Returns how many subscriptions it reached.
  function approve() {
    const clientPubkey = shownUri.slice('nostrconnect://'.length, shownUri.indexOf('?'))
    const signerKey = generateSecretKey()
    const content = encrypt(JSON.stringify({ id: 'approve', result: SECRET }), getConversationKey(signerKey, clientPubkey))
    const approval = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', clientPubkey]], content }, signerKey)
    let reached = 0
    for (const socket of sockets) {
      for (const id of socket.subscriptions) {
        socket.deliver(['EVENT', id, approval])
        reached++
      }
    }
    return reached
  }

  return {
    page,
    approve,
    signedIn,
    buttonIsWaiting: () => button[button.length - 1] === true,
    lastStatus: () => statuses[statuses.length - 1],
    waitingShown: () => shownUri !== '',
  }
}

const settle = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms))

// Waits up to 2 seconds for a condition, then fails with a clear message
// rather than a test timeout.
async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (condition()) return
    await settle(5)
  }
  throw new Error(`Timed out waiting until ${what}`)
}

// Waits until the latest request has subscribed on all its relays, so an
// approval sent next reaches it. A fixed wait raced the request's startup on
// slower machines: the approval then reached no subscription and the test hung.
function untilSubscribed() {
  return until(() => {
    const latest = sockets.slice(-RELAYS.length)
    return latest.length === RELAYS.length && latest.every(s => s.subscriptions.size > 0)
  }, 'the Nostr Connect request subscribed on its relays')
}

describe('Nostr Connect Cancel (#150)', () => {
  afterEach(() => {
    for (const socket of sockets) socket.close()
    sockets = []
    holdConnecting = false
    sentWhileClosed = []
  })

  it('without Cancel, an approval signs in with Nostr Connect and puts the button back', async () => {
    const h = await nostrConnectHarness()
    const started = h.page.startNostrConnect()
    await untilSubscribed()
    h.approve()
    await started
    expect(h.signedIn).toEqual(['nostrconnect'])
    expect(h.buttonIsWaiting()).toBe(false)
  })

  it('Cancel puts the Start button back', async () => {
    const h = await nostrConnectHarness()
    h.page.startNostrConnect()
    await untilSubscribed()
    expect(h.buttonIsWaiting()).toBe(true)
    h.page.cancelNostrConnect()
    await settle()
    expect(h.buttonIsWaiting()).toBe(false)
  })

  it('Cancel closes every relay connection the request opened', async () => {
    const h = await nostrConnectHarness()
    h.page.startNostrConnect()
    await untilSubscribed()
    expect(sockets).toHaveLength(RELAYS.length)
    h.page.cancelNostrConnect()
    await settle()
    expect(sockets.map(s => s.readyState)).toEqual(RELAYS.map(() => FakeWebSocket.CLOSED))
  })

  it('Cancel sends nothing on a connection it closed', async () => {
    const h = await nostrConnectHarness()
    h.page.startNostrConnect()
    await untilSubscribed()
    h.page.cancelNostrConnect()
    await settle()
    expect(sentWhileClosed).toEqual([])
  })

  it('starting again closes the earlier request\'s relay connections', async () => {
    const h = await nostrConnectHarness()
    h.page.startNostrConnect()
    await untilSubscribed()
    const earlier = [...sockets]
    h.page.startNostrConnect()
    await untilSubscribed()
    expect(earlier.map(s => s.readyState)).toEqual(RELAYS.map(() => FakeWebSocket.CLOSED))
  })

  it('a cancelled request that ends late leaves a new request waiting', async () => {
    const h = await nostrConnectHarness()
    h.page.startNostrConnect()
    await untilSubscribed()
    h.page.cancelNostrConnect()
    h.page.startNostrConnect()
    await untilSubscribed()
    expect(h.buttonIsWaiting()).toBe(true)
    expect(h.lastStatus()).toEqual(['Waiting for your signer to approve the Nostr Connect request...', 'loading'])
  })

  it('when the approved signer cannot be used, its relay connections close and the error shows', async () => {
    const h = await nostrConnectHarness({ activationFails: true })
    const started = h.page.startNostrConnect()
    await untilSubscribed()
    h.approve()
    await started
    expect(h.lastStatus()).toEqual(['Signer returned an invalid pubkey.', 'error'])
    expect(h.buttonIsWaiting()).toBe(false)
    expect(sockets.length).toBeGreaterThan(0)
    expect(sockets.every(s => s.readyState === FakeWebSocket.CLOSED)).toBe(true)
    expect(sentWhileClosed).toEqual([])
  })

  it('starting again after Cancel signs in when the new request is approved', async () => {
    const h = await nostrConnectHarness()
    h.page.startNostrConnect()
    await untilSubscribed()
    h.page.cancelNostrConnect()
    await settle()
    const second = h.page.startNostrConnect()
    await untilSubscribed()
    h.approve()
    await second
    expect(h.signedIn).toEqual(['nostrconnect'])
    expect(h.buttonIsWaiting()).toBe(false)
  })

  it('connecting a bunker ends the waiting request', async () => {
    const h = await nostrConnectHarness()
    h.page.startNostrConnect()
    await untilSubscribed()
    await h.page.connectBunkerSigner()
    await settle()
    expect(h.signedIn).toEqual(['bunker'])
    expect(sockets.map(s => s.readyState)).toEqual(RELAYS.map(() => FakeWebSocket.CLOSED))
    expect(h.buttonIsWaiting()).toBe(false)
    expect(h.approve()).toBe(0)
    await settle(1200)
    expect(h.signedIn).toEqual(['bunker'])
  })

  it('an approval sent after Cancel does not sign in', async () => {
    const h = await nostrConnectHarness()
    h.page.startNostrConnect()
    await untilSubscribed()
    h.page.cancelNostrConnect()
    await settle()
    expect(h.approve()).toBe(0)
    await settle(1200)
    expect(h.signedIn).toEqual([])
  })

  it('a relay still connecting at Cancel cannot sign in once it connects', async () => {
    holdConnecting = true
    const h = await nostrConnectHarness()
    h.page.startNostrConnect()
    await until(() => h.waitingShown() && sockets.length === RELAYS.length, 'the request opened its relay connections')
    h.page.cancelNostrConnect()
    await settle()
    for (const socket of sockets) socket.open()
    await settle()
    expect(h.approve()).toBe(0)
    await settle(1200)
    expect(h.signedIn).toEqual([])
  })

  it('an approval already arriving when Cancel is pressed does not sign in', async () => {
    const h = await nostrConnectHarness()
    h.page.startNostrConnect()
    await untilSubscribed()
    h.approve()
    await settle()
    h.page.cancelNostrConnect()
    await settle(1200)
    expect(h.signedIn).toEqual([])
    expect(h.buttonIsWaiting()).toBe(false)
  })
})
