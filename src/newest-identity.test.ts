import { describe, expect, it } from 'vitest'
import worker from './index'

// Runs the landing page's real code for publishing, listing and removing
// linked accounts, including its relay requests, against stand-in relays, a
// stand-in signer and page, so the tests exercise the shipped script rather
// than a copy of it. The relays can each hold a different copy of the identity
// event (kind 10011) or the profile (kind 0); the page must build on the newest.

const API = 'https://verifier.divine.video'
const PUBKEY = 'ab'.repeat(32)
const OTHER_PUBKEY = 'cd'.repeat(32)
const GOOD_SIG = 'aa'.repeat(64)
const BAD_SIG = 'bb'.repeat(64)
const UNREAD = 'Couldn\'t load your current linked accounts, so nothing was published. Please try again in a moment.'

async function pageHtml(): Promise<string> {
  const res = await worker.fetch(new Request(`${API}/`), {} as never)
  return res.text()
}

// The part of the page's script from one marker up to the next.
function scriptBetween(html: string, from: string, to: string): string {
  const start = html.indexOf(from)
  const end = html.indexOf(to, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

const DEPS = ['document', 'fetch', 'API', 'PROFILE_RELAYS', 'WebSocket', 'setTimeout', 'clearTimeout', 'loadNostrTools',
  'publishEventToRelay', 'activeSigner', 'getActivePubkey', 'signerPubkeyHex', 'setStatus', 'clearStatus', 'setButtonLoading',
  'setAccountInputValue', 'updateSignerSummary', 'currentProofContext', 'renderLinkedVerifications', 'buildNip98EventForRevoke',
  'OAUTH_PLATFORMS_SET']

async function loadPage() {
  const html = await pageHtml()
  const source = [
    scriptBetween(html, 'function fetchIdentityEvent(relayUrl, pubkey)', '// --- Manage / Remove linked verifications ---'),
    scriptBetween(html, 'async function publishIdentityTagToNostr()', 'const PENDING_SIGN_IN_KEY'),
    scriptBetween(html, 'async function loadLinkedVerifications()', '// Renders manage table'),
    scriptBetween(html, 'async function executeRemoveVerification()', 'async function buildNip98EventForRevoke('),
  ].join('\n')
  return (env: Record<string, unknown>) =>
    new Function(...DEPS, `${source}\nreturn { publishIdentityTagToNostr, loadLinkedVerifications, executeRemoveVerification };`)(...DEPS.map(d => env[d]))
}

type NostrEvent = { id: string, pubkey: string, kind: number, created_at: number, tags: string[][], content: string, sig: string }
type Filter = { kinds: number[], authors: string[], limit?: number }
// How a stand-in relay behaves: the events it holds, events it sends whatever
// was asked, or a way of failing.
type Relay = NostrEvent[] | { sendsAnyway: NostrEvent[] } | 'unreachable' | 'throws' | 'hangs' | 'refuses' | 'hangs-up'

function iTag(platform: string, identity: string, proof: string) {
  return ['i', `${platform}:${identity}`, proof]
}

function event(kind: number, createdAt: number, tags: string[][], overrides: Partial<NostrEvent> = {}): NostrEvent {
  return { id: '11'.repeat(32), pubkey: PUBKEY, kind, created_at: createdAt, tags, content: '', sig: GOOD_SIG, ...overrides }
}

// Lets every pending promise and stand-in relay answer run.
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

function harness(relays: Record<string, Relay>, opts: { removing?: { platform: string, identity: string }, noChecker?: boolean } = {}) {
  const published: NostrEvent[] = []
  const statuses: Array<[string, string, string]> = []
  const listed: string[][][] = []
  // What the page did, in order: sockets opened and relays answering.
  const steps: string[] = []
  const requests: Array<{ relay: string, filters: Filter[] }> = []
  const checked: unknown[] = []
  // The page's timers, held so a test can fire them.
  const timers = new Map<number, { fn: () => void, ms: number }>()
  let nextTimer = 1
  const dialog = { style: { display: '' }, dataset: opts.removing ?? {} }

  class StandInSocket {
    onopen?: () => void
    onmessage?: (msg: { data: string }) => void
    onerror?: () => void
    onclose?: () => void
    constructor(readonly url: string) {
      const relay = relays[url]
      if (relay === 'throws') throw new Error('blocked')
      steps.push(`open ${url}`)
      queueMicrotask(() => {
        if (relay === 'unreachable') { this.onerror?.(); this.onclose?.(); return }
        this.onopen?.()
      })
    }
    send(raw: string) {
      const message = JSON.parse(raw)
      if (message[0] !== 'REQ') return
      const [, subId, ...filters] = message as [string, string, ...Filter[]]
      requests.push({ relay: this.url, filters })
      const relay = relays[this.url]
      queueMicrotask(() => {
        if (relay === 'hangs') return
        if (relay === 'hangs-up') { this.onclose?.(); return }
        if (relay === 'refuses') { this.onmessage?.({ data: JSON.stringify(['CLOSED', subId, 'blocked: not allowed']) }); return }
        const sent = Array.isArray(relay)
          ? filters.flatMap(filter => relay.filter(e => filter.kinds.includes(e.kind)))
          : (relay as { sendsAnyway: NostrEvent[] }).sendsAnyway
        for (const e of sent) this.onmessage?.({ data: JSON.stringify(['EVENT', subId, e]) })
        steps.push(`answer ${this.url}`)
        this.onmessage?.({ data: JSON.stringify(['EOSE', subId]) })
      })
    }
    close() { queueMicrotask(() => this.onclose?.()) }
  }

  const env: Record<string, unknown> = {
    API,
    PROFILE_RELAYS: Object.keys(relays),
    WebSocket: StandInSocket,
    setTimeout: (fn: () => void, ms: number) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id: number) => { timers.delete(id) },
    loadNostrTools: async () => {
      if (opts.noChecker) throw new TypeError('Failed to fetch dynamically imported module')
      return { pure: { verifyEvent: (e: NostrEvent) => { checked.push(e); return e.sig === GOOD_SIG } } }
    },
    document: { getElementById: (id: string) => id === 'remove-confirm-dialog' ? dialog : { textContent: '', innerHTML: '' } },
    fetch: async () => ({ ok: true }),
    publishEventToRelay: async (_relay: string, signed: NostrEvent) => {
      published.push(signed)
      return { ok: true }
    },
    activeSigner: {
      getPublicKey: async () => PUBKEY,
      signEvent: async (unsigned: Omit<NostrEvent, 'id' | 'sig'>) => ({ ...unsigned, id: 'ee'.repeat(32), sig: GOOD_SIG }),
    },
    getActivePubkey: async () => PUBKEY,
    signerPubkeyHex: null,
    setStatus: (id: string, msg: string, type: string) => { statuses.push([id, msg, type]) },
    clearStatus: () => {},
    setButtonLoading: () => {},
    setAccountInputValue: () => {},
    updateSignerSummary: () => {},
    currentProofContext: () => ({ platform: 'github', identity: 'newuser', proof: 'newgist' }),
    renderLinkedVerifications: (iTags: string[][]) => { listed.push(iTags) },
    buildNip98EventForRevoke: async () => ({}),
    OAUTH_PLATFORMS_SET: new Set(['twitter', 'bluesky', 'youtube', 'tiktok']),
  }
  const errors = () => statuses.filter(([, , type]) => type === 'error')
  // The tags of the event the page published (sent to every relay).
  const publishedTags = () => {
    expect(published).toHaveLength(Object.keys(relays).length)
    return published[0].tags
  }
  const fireTimers = () => {
    for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn() }
  }
  return { env, published, publishedTags, errors, listed, steps, requests, checked, timers, fireTimers }
}

const GITHUB = iTag('github', 'octocat', 'gist1')
const MASTODON = iTag('mastodon', 'mastodon.social/@alice', 'post1')
const BLUESKY = iTag('bluesky', 'alice.bsky.social', 'post2')
const NEW_CLAIM = iTag('github', 'newuser', 'newgist')

describe('publishing a linked account', () => {
  it('builds on the newest identity event, not the first relay\'s copy', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': [event(10011, 100, [GITHUB])],
      'wss://two.example': [event(10011, 300, [GITHUB, MASTODON, BLUESKY])],
      'wss://three.example': [event(10011, 200, [GITHUB, MASTODON])],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.errors()).toEqual([])
    expect(h.publishedTags()).toEqual([GITHUB, MASTODON, BLUESKY, NEW_CLAIM])
  })

  it('keeps the copy with the lowest id when two have the same created_at, as NIP-01 says', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': [event(10011, 300, [GITHUB], { id: 'bb'.repeat(32) })],
      'wss://two.example': [event(10011, 300, [MASTODON], { id: 'aa'.repeat(32) })],
      'wss://three.example': [event(10011, 300, [BLUESKY], { id: 'cc'.repeat(32) })],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([MASTODON, NEW_CLAIM])
  })

  it('asks every relay before any of them answers', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': [event(10011, 100, [GITHUB])],
      'wss://two.example': [],
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.steps.slice(0, 3)).toEqual(['open wss://one.example', 'open wss://two.example', 'open wss://three.example'])
    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('asks each relay once, for the identity event and the profile in one request', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': [event(10011, 100, [GITHUB])],
      'wss://two.example': [],
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    const both = [{ kinds: [10011], authors: [PUBKEY], limit: 1 }, { kinds: [0], authors: [PUBKEY], limit: 1 }]
    expect(h.requests).toEqual([
      { relay: 'wss://one.example', filters: both },
      { relay: 'wss://two.example', filters: both },
      { relay: 'wss://three.example', filters: both },
    ])
  })

  it('still uses the newest copy when another relay can\'t be reached', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': 'unreachable',
      'wss://two.example': [event(10011, 100, [GITHUB])],
      'wss://three.example': [event(10011, 200, [GITHUB, MASTODON])],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, MASTODON, NEW_CLAIM])
  })

  it('falls back to the newest profile when no relay has an identity event', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': [event(0, 100, [GITHUB])],
      'wss://two.example': [event(0, 200, [GITHUB, MASTODON])],
      'wss://three.example': 'unreachable',
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, MASTODON, NEW_CLAIM])
  })

  it('uses an identity event over a newer profile, since the identity event replaced the profile\'s list', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': [event(0, 900, [BLUESKY])],
      'wss://two.example': [event(10011, 100, [GITHUB]), event(0, 50, [MASTODON])],
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('ignores a newer copy whose signature doesn\'t check out, for the older one that does', async () => {
    const page = await loadPage()
    const badlySigned = event(10011, 900, [BLUESKY], { sig: BAD_SIG })
    const h = harness({
      'wss://one.example': [badlySigned],
      'wss://two.example': [event(10011, 100, [GITHUB])],
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.checked).toContainEqual(badlySigned)
    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('ignores a newer copy by someone else', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': [event(10011, 900, [BLUESKY], { pubkey: OTHER_PUBKEY })],
      'wss://two.example': [event(10011, 100, [GITHUB])],
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('ignores a newer event of a kind it didn\'t ask for', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { sendsAnyway: [event(3, 900, [BLUESKY])] },
      'wss://two.example': [event(0, 100, [GITHUB])],
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('waits at most 8 seconds for a relay that never answers', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': 'hangs',
      'wss://two.example': [event(10011, 100, [GITHUB])],
      'wss://three.example': [],
    })

    void page(h.env).publishIdentityTagToNostr()
    await settle()
    expect(h.published).toEqual([])
    expect([...h.timers.values()].map(t => t.ms)).toEqual([8000])

    h.fireTimers()
    await settle()
    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('adds the first linked account for someone with none yet', async () => {
    const page = await loadPage()
    const h = harness({ 'wss://one.example': [], 'wss://two.example': [], 'wss://three.example': 'unreachable' })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.errors()).toEqual([])
    expect(h.publishedTags()).toEqual([NEW_CLAIM])
  })

  it('publishes nothing when no relay could be read', async () => {
    const page = await loadPage()
    const h = harness({ 'wss://one.example': 'unreachable', 'wss://two.example': 'hangs-up', 'wss://three.example': 'throws' })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.published).toEqual([])
    expect(h.errors()).toEqual([['publish-status', UNREAD, 'error']])
  })

  it('publishes nothing when every copy the relays sent was ignored', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': [event(10011, 100, [GITHUB], { sig: BAD_SIG })],
      'wss://two.example': [event(10011, 200, [GITHUB], { pubkey: OTHER_PUBKEY })],
      'wss://three.example': 'unreachable',
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.published).toEqual([])
    expect(h.errors()).toEqual([['publish-status', UNREAD, 'error']])
  })

  it('publishes nothing when the relays sent copies but they couldn\'t be checked', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': [],
      'wss://two.example': [event(10011, 100, [GITHUB])],
      'wss://three.example': [],
    }, { noChecker: true })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.published).toEqual([])
    expect(h.errors()).toEqual([['publish-status', UNREAD, 'error']])
  })

  it('doesn\'t need the checker when no relay sent a copy', async () => {
    const page = await loadPage()
    const h = harness({ 'wss://one.example': [], 'wss://two.example': [], 'wss://three.example': [] }, { noChecker: true })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([NEW_CLAIM])
  })

  it('stops waiting for a relay that refuses the request or hangs up', async () => {
    const page = await loadPage()
    const h = harness({ 'wss://one.example': 'refuses', 'wss://two.example': 'hangs-up', 'wss://three.example': 'refuses' })

    void page(h.env).publishIdentityTagToNostr()
    await settle()

    expect(h.errors()).toEqual([['publish-status', UNREAD, 'error']])
    expect(h.timers.size).toBe(0)
  })

  it('leaves no timer running when a socket can\'t be opened', async () => {
    const page = await loadPage()
    const h = harness({ 'wss://one.example': 'throws', 'wss://two.example': [], 'wss://three.example': [] })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.timers.size).toBe(0)
    expect(h.publishedTags()).toEqual([NEW_CLAIM])
  })
})

describe('listing linked accounts to manage', () => {
  it('lists the newest identity event\'s accounts', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': [event(10011, 100, [GITHUB])],
      'wss://two.example': [event(10011, 200, [GITHUB, MASTODON])],
      'wss://three.example': [],
    })

    await page(h.env).loadLinkedVerifications()

    expect(h.listed).toEqual([[GITHUB, MASTODON]])
  })

  it('lists the newest profile\'s accounts when no relay has an identity event', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': [event(0, 100, [GITHUB])],
      'wss://two.example': [event(0, 200, [GITHUB, MASTODON])],
      'wss://three.example': [],
    })

    await page(h.env).loadLinkedVerifications()

    expect(h.listed).toEqual([[GITHUB, MASTODON]])
  })
})

describe('removing a linked account', () => {
  const removing = { platform: 'mastodon', identity: 'mastodon.social/@alice' }

  it('builds on the newest identity event, not the first relay\'s copy', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': [event(10011, 100, [GITHUB, MASTODON])],
      'wss://two.example': [event(10011, 200, [GITHUB, MASTODON, BLUESKY])],
      'wss://three.example': [],
    }, { removing })

    await page(h.env).executeRemoveVerification()

    expect(h.errors()).toEqual([])
    expect(h.publishedTags()).toEqual([GITHUB, BLUESKY])
  })

  it('falls back to the newest profile when no relay has an identity event', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': [event(0, 100, [GITHUB, MASTODON])],
      'wss://two.example': [event(0, 200, [GITHUB, MASTODON, BLUESKY])],
      'wss://three.example': [],
    }, { removing })

    await page(h.env).executeRemoveVerification()

    expect(h.publishedTags()).toEqual([GITHUB, BLUESKY])
  })

  it('publishes nothing when no relay could be read', async () => {
    const page = await loadPage()
    const h = harness({ 'wss://one.example': 'unreachable', 'wss://two.example': 'unreachable', 'wss://three.example': 'refuses' }, { removing })

    await page(h.env).executeRemoveVerification()

    expect(h.published).toEqual([])
    expect(h.errors()).toEqual([['manage-status', UNREAD, 'error']])
  })
})
