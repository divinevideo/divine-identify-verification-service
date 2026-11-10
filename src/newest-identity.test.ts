import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import { NOSTR_TOOLS_MODULE_PATH } from './generated/vendor'

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
const LIST_UNREAD = 'Couldn\'t load your linked accounts right now. Please try again in a moment.'
// Divine's own relay, where a person's list is expected to be.
const DIVINE = 'wss://relay.divine.video'

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

const DEPS = ['document', 'fetch', 'API', 'DIVINE_RELAY', 'PROFILE_RELAYS', 'WebSocket', 'setTimeout', 'clearTimeout', 'loadNostrTools',
  'publishEventToRelay', 'activeSigner', 'getActivePubkey', 'signerPubkeyHex', 'setStatus', 'clearStatus', 'setButtonLoading',
  'setAccountInputValue', 'updateSignerSummary', 'currentProofContext', 'renderLinkedVerifications',
  'OAUTH_PLATFORMS_SET']

async function loadPage() {
  const html = await pageHtml()
  const source = [
    scriptBetween(html, "// Shown instead of publishing when the current list couldn't be read", '// --- Manage / Remove linked verifications ---'),
    scriptBetween(html, 'async function publishIdentityTagToNostr()', 'const PENDING_SIGN_IN_KEY'),
    scriptBetween(html, 'async function loadLinkedVerifications()', '// Renders manage table'),
    scriptBetween(html, 'const pendingRemovalRetries = new Map();', '// A platform pill links to the card'),
    scriptBetween(html, "document.getElementById('remove-confirm-btn').addEventListener", '// Start-up: a returning sign-in is handled first'),
  ].join('\n')
  return (env: Record<string, unknown>) => {
    const actualSetStatus = new Function('document', `${scriptBetween(html, 'function setStatus(elId, msg, type)', 'function clearStatus(elId)')}\nreturn setStatus;`)(env.document)
    // The page's own clearStatus too, so a test sees whether a status survives the list reload.
    const actualClearStatus = new Function('document', `${scriptBetween(html, 'function clearStatus(elId)', 'function signerSourceLabel(')}\nreturn clearStatus;`)(env.document)
    const recordStatus = env.setStatus as (...args: unknown[]) => void
    const deps = { ...env, clearStatus: actualClearStatus, setStatus: (...args: unknown[]) => { actualSetStatus(...args); recordStatus(...args) } }
    return new Function(...DEPS, `${source}\nreturn { publishIdentityTagToNostr, loadLinkedVerifications, executeRemoveVerification };`)(...DEPS.map(d => deps[d as keyof typeof deps]))
  }
}

type NostrEvent = { id: string, pubkey: string, kind: number, created_at: number, tags: string[][], content: string, sig: string }
type Filter = { kinds: number[], authors: string[], limit?: number }
// How a stand-in relay behaves: the events it holds, events it sends whatever
// was asked, or a way of failing.
type Relay = NostrEvent[] | { sendsAnyway: Array<NostrEvent | null> } | 'unreachable' | 'throws' | 'hangs' | 'refuses' | 'hangs-up'

function iTag(platform: string, identity: string, proof: string) {
  return ['i', `${platform}:${identity}`, proof]
}

function event(kind: number, createdAt: number, tags: string[][], overrides: Partial<NostrEvent> = {}): NostrEvent {
  return { id: '11'.repeat(32), pubkey: PUBKEY, kind, created_at: createdAt, tags, content: '', sig: GOOD_SIG, ...overrides }
}

// Lets every pending promise and stand-in relay answer run.
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

function harness(relays: Record<string, Relay>, opts: { removing?: { platform: string, identity: string }, noChecker?: boolean, revokeOk?: boolean, revokeError?: string, publishOk?: boolean, revokeThrows?: boolean } = {}) {
  const published: NostrEvent[] = []
  const fetches: Array<{ url: string, init: RequestInit }> = []
  let signs = 0
  const statuses: Array<[string, string, string]> = []
  const listed: string[][][] = []
  // What the page did, in order: sockets opened and relays answering.
  const steps: string[] = []
  const requests: Array<{ relay: string, filters: Filter[] }> = []
  const checked: unknown[] = []
  // Relays whose socket the page closed.
  const closed: string[] = []
  // The page's timers, held so a test can fire them.
  const timers = new Map<number, { fn: () => void, ms: number }>()
  let nextTimer = 1
  const dialog = { style: { display: '' }, dataset: opts.removing ?? {} }
  const elements = new Map<string, { textContent: string, innerHTML: string, style: Record<string, string>, hidden: boolean, disabled: boolean, addEventListener: (type: string, fn: () => Promise<void>) => void, click: () => Promise<void> }>()
  const element = (id: string) => {
    if (!elements.has(id)) {
      const listeners = new Map<string, () => Promise<void>>()
      elements.set(id, { textContent: '', innerHTML: '', style: {}, hidden: id === 'retry-revoke-btn', disabled: false,
        addEventListener: (type, fn) => { listeners.set(type, fn) }, click: async () => { await listeners.get('click')?.() } })
    }
    return elements.get(id)!
  }

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
          : (relay as { sendsAnyway: Array<NostrEvent | null> }).sendsAnyway
        for (const e of sent) this.onmessage?.({ data: JSON.stringify(['EVENT', subId, e]) })
        steps.push(`answer ${this.url}`)
        this.onmessage?.({ data: JSON.stringify(['EOSE', subId]) })
      })
    }
    close() { closed.push(this.url); queueMicrotask(() => this.onclose?.()) }
  }

  const env: Record<string, unknown> = {
    API,
    DIVINE_RELAY: DIVINE,
    PROFILE_RELAYS: Object.keys(relays),
    WebSocket: StandInSocket,
    setTimeout: (fn: () => void, ms: number) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id: number) => { timers.delete(id) },
    loadNostrTools: async () => {
      if (opts.noChecker) throw new TypeError('Failed to fetch dynamically imported module')
      return { pure: { verifyEvent: (e: NostrEvent) => { checked.push(e); return e.sig === GOOD_SIG } } }
    },
    document: { getElementById: (id: string) => id === 'remove-confirm-dialog' ? dialog : element(id) },
    fetch: async (url: string, init: RequestInit) => { fetches.push({ url, init }); if (opts.revokeThrows) throw new TypeError('Failed to fetch'); return { ok: opts.revokeOk ?? true, json: async () => ({ error: opts.revokeError }) } },
    publishEventToRelay: async (_relay: string, signed: NostrEvent) => {
      published.push(signed)
      return { ok: opts.publishOk ?? true }
    },
    activeSigner: {
      getPublicKey: async () => PUBKEY,
      signEvent: async (unsigned: Omit<NostrEvent, 'id' | 'sig'>) => { signs++; return { ...unsigned, id: 'ee'.repeat(32), sig: GOOD_SIG } },
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
  return { env, published, fetches, statuses, signs: () => signs, publishedTags, errors, listed, steps, requests, checked, closed, timers, fireTimers, element }
}

const GITHUB = iTag('github', 'octocat', 'gist1')
const MASTODON = iTag('mastodon', 'mastodon.social/@alice', 'post1')
const BLUESKY = iTag('bluesky', 'alice.bsky.social', 'post2')
const NEW_CLAIM = iTag('github', 'newuser', 'newgist')

describe('publishing a linked account', () => {
  it('builds on the newest identity event, not the first relay\'s copy', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [event(10011, 100, [GITHUB])],
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
      [DIVINE]: [event(10011, 300, [GITHUB], { id: 'bb'.repeat(32) })],
      'wss://two.example': [event(10011, 300, [MASTODON], { id: 'aa'.repeat(32) })],
      'wss://three.example': [event(10011, 300, [BLUESKY], { id: 'cc'.repeat(32) })],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([MASTODON, NEW_CLAIM])
  })

  it('asks every relay before any of them answers', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [event(10011, 100, [GITHUB])],
      'wss://two.example': [],
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.steps.slice(0, 3)).toEqual([`open ${DIVINE}`, 'open wss://two.example', 'open wss://three.example'])
    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('asks each relay once, for the identity event and the profile in one request', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [event(10011, 100, [GITHUB])],
      'wss://two.example': [],
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    const both = [{ kinds: [10011], authors: [PUBKEY], limit: 1 }, { kinds: [0], authors: [PUBKEY], limit: 1 }]
    expect(h.requests).toEqual([
      { relay: DIVINE, filters: both },
      { relay: 'wss://two.example', filters: both },
      { relay: 'wss://three.example', filters: both },
    ])
  })

  it('publishes nothing when Divine\'s relay can\'t be reached, even if another relay has a valid copy', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: 'unreachable',
      'wss://two.example': [event(10011, 100, [GITHUB])],
      'wss://three.example': [event(10011, 200, [GITHUB, MASTODON])],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.published).toEqual([])
    expect(h.errors()).toEqual([['publish-status', UNREAD, 'error']])
  })

  it('publishes nothing when Divine\'s relay can\'t be reached and the others have only a profile', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: 'unreachable', 'wss://two.example': [event(0, 100, [])], 'wss://three.example': [] })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.published).toEqual([])
    expect(h.errors()).toEqual([['publish-status', UNREAD, 'error']])
  })

  it('publishes nothing when Divine\'s relay sends a copy that fails the checks, even if another relay has a valid one', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [event(10011, 100, [GITHUB]), event(10011, 300, [BLUESKY], { sig: BAD_SIG })],
      'wss://two.example': [event(10011, 200, [GITHUB, MASTODON])],
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.published).toEqual([])
    expect(h.errors()).toEqual([['publish-status', UNREAD, 'error']])
  })

  it('falls back to the newest profile when no relay has an identity event', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [event(0, 100, [GITHUB])],
      'wss://two.example': [event(0, 200, [GITHUB, MASTODON])],
      'wss://three.example': 'unreachable',
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, MASTODON, NEW_CLAIM])
  })

  it('uses an identity event over a newer profile, since the identity event replaced the profile\'s list', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [event(0, 900, [BLUESKY])],
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
      [DIVINE]: [event(10011, 100, [GITHUB])],
      'wss://two.example': [badlySigned],
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.checked).toContainEqual(badlySigned)
    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('ignores a newer copy by someone else', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [event(10011, 100, [GITHUB])],
      'wss://two.example': [event(10011, 900, [BLUESKY], { pubkey: OTHER_PUBKEY })],
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('ignores a newer event of a kind it didn\'t ask for', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [event(0, 100, [GITHUB])],
      'wss://two.example': { sendsAnyway: [event(3, 900, [BLUESKY])] },
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('waits at most 8 seconds for a relay that never answers', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [event(10011, 100, [GITHUB])],
      'wss://two.example': 'hangs',
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
    const h = harness({ [DIVINE]: [], 'wss://two.example': 'unreachable', 'wss://three.example': 'unreachable' })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.errors()).toEqual([])
    expect(h.publishedTags()).toEqual([NEW_CLAIM])
  })

  it('publishes nothing when Divine\'s relay can\'t be reached and the others have no copy', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: 'unreachable', 'wss://two.example': [], 'wss://three.example': [] })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.published).toEqual([])
    expect(h.errors()).toEqual([['publish-status', UNREAD, 'error']])
  })

  it('publishes nothing when no relay could be read', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: 'unreachable', 'wss://two.example': 'hangs-up', 'wss://three.example': 'throws' })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.published).toEqual([])
    expect(h.errors()).toEqual([['publish-status', UNREAD, 'error']])
  })

  it('publishes nothing when the only copy Divine\'s relay sent fails the checks', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [event(10011, 100, [GITHUB], { sig: BAD_SIG })],
      'wss://two.example': [event(10011, 200, [GITHUB], { pubkey: OTHER_PUBKEY })],
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.published).toEqual([])
    expect(h.errors()).toEqual([['publish-status', UNREAD, 'error']])
  })

  it('publishes nothing when the relays sent copies but they couldn\'t be checked', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [],
      'wss://two.example': [event(10011, 100, [GITHUB])],
      'wss://three.example': [],
    }, { noChecker: true })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.published).toEqual([])
    expect(h.errors()).toEqual([['publish-status', UNREAD, 'error']])
  })

  it('doesn\'t need the checker when no relay sent a copy', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: [], 'wss://two.example': [], 'wss://three.example': [] }, { noChecker: true })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([NEW_CLAIM])
  })

  it('stops waiting for a relay that refuses the request or hangs up', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: 'refuses', 'wss://two.example': 'hangs-up', 'wss://three.example': 'refuses' })

    void page(h.env).publishIdentityTagToNostr()
    await settle()

    expect(h.errors()).toEqual([['publish-status', UNREAD, 'error']])
    expect(h.timers.size).toBe(0)
  })

  it('closes each relay\'s socket once it has answered', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: [], 'wss://two.example': [event(10011, 100, [GITHUB])], 'wss://three.example': [] })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.closed.sort()).toEqual([DIVINE, 'wss://three.example', 'wss://two.example'])
  })

  it('skips an empty event a relay sends', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [],
      'wss://two.example': { sendsAnyway: [null, event(10011, 100, [GITHUB])] },
      'wss://three.example': [],
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.errors()).toEqual([])
    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('leaves no timer running when a socket can\'t be opened', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: [], 'wss://two.example': 'throws', 'wss://three.example': 'throws' })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.timers.size).toBe(0)
    expect(h.publishedTags()).toEqual([NEW_CLAIM])
  })

  describe('dating the new list', () => {
    afterEach(() => { vi.useRealTimers() })

    it('dates it one second past the list it replaces when that is later than now', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const now = 1_800_000_000
      vi.setSystemTime(now * 1000)
      const page = await loadPage()
      const h = harness({ [DIVINE]: [event(10011, now + 120, [GITHUB])], 'wss://two.example': [], 'wss://three.example': [] })

      await page(h.env).publishIdentityTagToNostr()

      expect(h.errors()).toEqual([])
      expect(h.published[0].created_at).toBe(now + 121)
    })

    it('dates it now when the list it replaces is older', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const now = 1_800_000_000
      vi.setSystemTime(now * 1000)
      const page = await loadPage()
      const h = harness({ [DIVINE]: [event(10011, 100, [GITHUB])], 'wss://two.example': [], 'wss://three.example': [] })

      await page(h.env).publishIdentityTagToNostr()

      expect(h.published[0].created_at).toBe(now)
    })

    it('does not inherit a future profile date when creating the first identity list', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const now = 1_800_000_000
      vi.setSystemTime(now * 1000)
      const page = await loadPage()
      const h = harness({ [DIVINE]: [event(0, now + 120, [GITHUB])] })

      await page(h.env).publishIdentityTagToNostr()

      expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
      expect(h.published[0].created_at).toBe(now)
    })
  })
})

describe('listing linked accounts to manage', () => {
  it('lists the newest identity event\'s accounts', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [event(10011, 100, [GITHUB])],
      'wss://two.example': [event(10011, 200, [GITHUB, MASTODON])],
      'wss://three.example': [],
    })

    await page(h.env).loadLinkedVerifications()

    expect(h.listed).toEqual([[GITHUB, MASTODON]])
  })

  it('lists the newest profile\'s accounts when no relay has an identity event', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [event(0, 100, [GITHUB])],
      'wss://two.example': [event(0, 200, [GITHUB, MASTODON])],
      'wss://three.example': [],
    })

    await page(h.env).loadLinkedVerifications()

    expect(h.listed).toEqual([[GITHUB, MASTODON]])
  })

  it('says the list couldn\'t be loaded when it couldn\'t be read', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: 'unreachable', 'wss://two.example': [], 'wss://three.example': 'refuses' })

    await page(h.env).loadLinkedVerifications()

    expect(h.listed).toEqual([])
    expect(h.errors()).toEqual([['manage-status', LIST_UNREAD, 'error']])
    expect(h.element('manage-links-container').textContent).toBe('')
  })

  it('says the list couldn\'t be loaded when Divine\'s relay can\'t be reached, even if another relay has a copy', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: 'unreachable', 'wss://two.example': [event(10011, 100, [GITHUB])], 'wss://three.example': [] })

    await page(h.env).loadLinkedVerifications()

    expect(h.listed).toEqual([])
    expect(h.errors()).toEqual([['manage-status', LIST_UNREAD, 'error']])
  })

  it('says there are none when the list was read and is empty', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: [], 'wss://two.example': 'unreachable', 'wss://three.example': [] })

    await page(h.env).loadLinkedVerifications()

    expect(h.listed).toEqual([])
    expect(h.errors()).toEqual([])
    expect(h.element('manage-links-container').textContent).toBe('No linked verifications found.')
  })
})

describe('removing a linked account', () => {
  const removing = { platform: 'mastodon', identity: 'mastodon.social/@alice' }
  const TWITTER = iTag('twitter', 'alice', 'oauth')

  afterEach(() => { vi.useRealTimers() })

  it('builds on the newest identity event, not the first relay\'s copy', async () => {
    const page = await loadPage()
    const h = harness({
      [DIVINE]: [event(10011, 100, [GITHUB, MASTODON])],
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
      [DIVINE]: [event(0, 100, [GITHUB, MASTODON])],
      'wss://two.example': [event(0, 200, [GITHUB, MASTODON, BLUESKY])],
      'wss://three.example': [],
    }, { removing })

    await page(h.env).executeRemoveVerification()

    expect(h.publishedTags()).toEqual([GITHUB, BLUESKY])
  })

  it('sends the list it published to revoke and asks for no other signature', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: [event(10011, 100, [GITHUB, TWITTER])], 'wss://two.example': [], 'wss://three.example': [] },
      { removing: { platform: 'twitter', identity: 'alice' } })

    await page(h.env).executeRemoveVerification()

    expect(h.fetches).toHaveLength(1)
    expect(h.fetches[0].url).toBe(`${API}/auth/oauth/revoke`)
    expect(h.fetches[0].init.method).toBe('POST')
    expect(h.fetches[0].init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(h.fetches[0].init.body as string)).toEqual({ platform: 'twitter', identity: 'alice', pubkey: PUBKEY, list: h.published[0] })
    expect(h.signs()).toBe(1)
    expect(h.statuses[h.statuses.length - 1]).toEqual(['manage-status', 'Verification removed from your Nostr profile.', 'ok'])
  })

  it('dates the new list one second past the list it replaces when that is later than now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = 1_800_000_000
    vi.setSystemTime(now * 1000)
    const page = await loadPage()
    const h = harness({ [DIVINE]: [event(10011, now + 120, [GITHUB, TWITTER])], 'wss://two.example': [], 'wss://three.example': [] },
      { removing: { platform: 'twitter', identity: 'alice' } })

    await page(h.env).executeRemoveVerification()

    expect(h.published[0].created_at).toBe(now + 121)
  })

  it('dates the new list now when the list it replaces is older', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = 1_800_000_000
    vi.setSystemTime(now * 1000)
    const page = await loadPage()
    const h = harness({ [DIVINE]: [event(10011, 100, [GITHUB, TWITTER])], 'wss://two.example': [], 'wss://three.example': [] },
      { removing: { platform: 'twitter', identity: 'alice' } })

    await page(h.env).executeRemoveVerification()

    expect(h.published[0].created_at).toBe(now)
  })

  it('does not inherit a future profile date when removing from a legacy profile', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = 1_800_000_000
    vi.setSystemTime(now * 1000)
    const page = await loadPage()
    const h = harness({ [DIVINE]: [event(0, now + 120, [GITHUB, TWITTER])] },
      { removing: { platform: 'twitter', identity: 'alice' } })

    await page(h.env).executeRemoveVerification()

    expect(h.publishedTags()).toEqual([GITHUB])
    expect(h.published[0].created_at).toBe(now)
  })

  it.each([' Twitter ', 'X', ' x ', ' Bluesky ', ' YOUTUBE ', ' TikTok '])('canonicalizes %s for revoke but filters the raw claim', async platform => {
    const page = await loadPage()
    const canonical = platform.trim().toLowerCase().replace(/^x$/, 'twitter')
    const otherClaim = iTag(canonical, 'someone-else', 'oauth')
    const h = harness({ [DIVINE]: [event(10011, 100, [GITHUB, iTag(platform, 'alice', 'oauth'), otherClaim])] },
      { removing: { platform, identity: 'alice' } })

    await page(h.env).executeRemoveVerification()

    expect(h.publishedTags()).toEqual([GITHUB, otherClaim])
    expect(JSON.parse(h.fetches[0].init.body as string).platform).toBe(canonical)
  })

  it('says the sign-in record did not clear when revoke is refused', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: [event(10011, 100, [GITHUB, TWITTER])], 'wss://two.example': [], 'wss://three.example': [] },
      { removing: { platform: 'twitter', identity: 'alice' }, revokeOk: false })

    await page(h.env).executeRemoveVerification()

    expect(h.statuses[h.statuses.length - 1]).toEqual(['manage-status', 'Removed from profile, but sign-in record removal failed: OAuth cache revoke did not complete.', 'error'])
    expect(h.element('retry-revoke-btn').hidden).toBe(false)
  })

  it('does not call revoke when no relay accepted the new list', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: [event(10011, 100, [GITHUB, TWITTER])], 'wss://two.example': [], 'wss://three.example': [] },
      { removing: { platform: 'twitter', identity: 'alice' }, publishOk: false })

    await page(h.env).executeRemoveVerification()

    expect(h.fetches).toEqual([])
    expect(h.errors()).toEqual([['manage-status', 'No relay accepted the updated event.', 'error']])
  })

  it('says the sign-in record did not clear when the revoke request fails to send', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: [event(10011, 100, [GITHUB, TWITTER])], 'wss://two.example': [], 'wss://three.example': [] },
      { removing: { platform: 'twitter', identity: 'alice' }, revokeThrows: true })

    await page(h.env).executeRemoveVerification()

    expect(h.statuses[h.statuses.length - 1]).toEqual(['manage-status', 'Removed from profile, but sign-in record removal failed: OAuth cache revoke did not complete.', 'error'])
    expect(h.element('retry-revoke-btn').hidden).toBe(false)
  })

  it('shows the server refusal as text and retries from the newest list after the row disappears', async () => {
    const page = await loadPage()
    const relays: Record<string, Relay> = { [DIVINE]: [event(10011, 100, [iTag(' X ', 'alice', 'oauth')])] }
    const opts = { removing: { platform: ' X ', identity: 'alice' }, revokeOk: false, revokeError: '<img src=x onerror=alert(1)>' }
    const h = harness(relays, opts)
    const instance = page(h.env)
    await instance.executeRemoveVerification()

    expect(h.published[0].tags).toEqual([])
    expect(h.element('manage-status').textContent).toContain(opts.revokeError)
    expect(h.element('manage-status').innerHTML).toBe('')
    expect(h.element('retry-revoke-btn').hidden).toBe(false)
    relays[DIVINE] = [event(10011, h.published[0].created_at, [])]
    await instance.loadLinkedVerifications()
    expect(h.element('manage-links-container').textContent).toBe('No linked verifications found.')
    expect(h.element('retry-revoke-btn').hidden).toBe(false)

    relays[DIVINE] = [event(10011, h.published[0].created_at + 10, [GITHUB, BLUESKY])]
    await h.element('retry-revoke-btn').click()
    expect(h.signs()).toBe(2)
    expect(h.published[1].tags).toEqual([GITHUB, BLUESKY])
    expect(h.published[1].created_at).toBe(h.published[0].created_at + 11)
    expect(JSON.parse(h.fetches[1].init.body as string)).toEqual({ platform: 'twitter', identity: 'alice', pubkey: PUBKEY, list: h.published[1] })
    expect(h.element('retry-revoke-btn').hidden).toBe(false)

    opts.revokeOk = true
    await h.element('retry-revoke-btn').click()
    expect(h.signs()).toBe(3)
    expect(h.fetches).toHaveLength(3)
    expect(h.element('retry-revoke-btn').hidden).toBe(true)
  })

  it('keeps the refusal visible after the list reloads', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: [event(10011, 100, [TWITTER])] },
      { removing: { platform: 'twitter', identity: 'alice' }, revokeOk: false, revokeError: 'This list is older than the sign-in link.' })
    await page(h.env).executeRemoveVerification()

    const status = h.element('manage-status')
    expect(status.style.display).not.toBe('none')
    expect(status.textContent).toContain('This list is older than the sign-in link.')
  })

  it('retains two failed removals, rotates failures, and clears only the successful claim', async () => {
    const page = await loadPage()
    const removing = { platform: 'twitter', identity: 'alice' }
    const opts = { removing, revokeOk: false }
    const h = harness({ [DIVINE]: [event(10011, 100, [TWITTER, BLUESKY])] }, opts)
    const instance = page(h.env)
    await instance.executeRemoveVerification()
    removing.platform = 'bluesky'
    removing.identity = BLUESKY[1].slice('bluesky:'.length)
    await instance.executeRemoveVerification()
    expect(h.element('retry-revoke-btn').textContent).toContain('2 pending')

    // The first still fails, but the next click must reach the second claim.
    await h.element('retry-revoke-btn').click()
    expect(h.element('retry-revoke-btn').textContent).toContain('2 pending')
    opts.revokeOk = true
    await h.element('retry-revoke-btn').click()
    expect(JSON.parse(h.fetches[3].init.body as string).platform).toBe('bluesky')
    expect(h.element('retry-revoke-btn').hidden).toBe(false)
    expect(h.element('retry-revoke-btn').textContent).toContain('1 pending')
    await h.element('retry-revoke-btn').click()
    expect(JSON.parse(h.fetches[4].init.body as string).platform).toBe('twitter')
    expect(h.element('retry-revoke-btn').hidden).toBe(true)
  })

  it.each([
    { label: 'later timestamp', offset: 1, id: 'ff'.repeat(32), cancelled: true },
    { label: 'same second, lower ID', offset: 0, id: 'dd'.repeat(32), cancelled: true },
    { label: 'same second, higher ID', offset: 0, id: 'ff'.repeat(32), cancelled: false },
    { label: 'same event', offset: 0, id: 'ee'.repeat(32), cancelled: false },
    { label: 'older stale relay list', offset: -1, id: '11'.repeat(32), cancelled: false },
  ])('checks relink ordering before retry: $label', async ({ offset, id, cancelled }) => {
    const page = await loadPage()
    const relays: Record<string, Relay> = { [DIVINE]: [event(10011, 100, [TWITTER])] }
    const h = harness(relays, { removing: { platform: 'twitter', identity: 'alice' }, revokeOk: false })
    await page(h.env).executeRemoveVerification()
    relays[DIVINE] = [event(10011, h.published[0].created_at + offset, [TWITTER], { id })]

    await h.element('retry-revoke-btn').click()

    expect(h.signs()).toBe(cancelled ? 1 : 2)
    expect(h.published).toHaveLength(cancelled ? 1 : 2)
    expect(h.fetches).toHaveLength(cancelled ? 1 : 2)
    expect(h.element('retry-revoke-btn').hidden).toBe(cancelled)
    // Both ways the list is shown again: after the retry, or with the
    // account back in it, so the person can remove it.
    expect(h.listed).toHaveLength(2)
    if (cancelled) {
      expect(h.listed[1]).toEqual([TWITTER])
      expect(h.element('manage-status').textContent).toContain('linked again; remove it from the list if you still want to unlink')
    }
  })

  it('dates a retry past its own first removal when a relay returns an older list', async () => {
    const page = await loadPage()
    const ahead = Math.floor(Date.now() / 1000) + 300
    const relays: Record<string, Relay> = { [DIVINE]: [event(10011, ahead, [TWITTER])] }
    const h = harness(relays, { removing: { platform: 'twitter', identity: 'alice' }, revokeOk: false })
    await page(h.env).executeRemoveVerification()
    expect(h.published[0].created_at).toBe(ahead + 1)
    // A relay that missed the first removal answers with an older list.
    relays[DIVINE] = [event(10011, 100, [GITHUB])]
    await h.element('retry-revoke-btn').click()
    expect(h.published).toHaveLength(2)
    expect(h.published[1].created_at).toBe(ahead + 2)
  })

  it('clears a pending retry when the account is removed in another form', async () => {
    const page = await loadPage()
    const removing = { platform: 'X', identity: 'Alice' }
    const opts = { removing, revokeOk: false }
    const h = harness({ [DIVINE]: [event(10011, 100, [iTag('X', 'Alice', 'oauth'), TWITTER])] }, opts)
    const instance = page(h.env)
    await instance.executeRemoveVerification()
    expect(h.element('retry-revoke-btn').hidden).toBe(false)
    removing.platform = 'twitter'
    removing.identity = 'alice'
    opts.revokeOk = true
    await instance.executeRemoveVerification()
    expect(h.element('retry-revoke-btn').hidden).toBe(true)
  })

  it('preserves the original removal ordering after another revoke failure', async () => {
    const page = await loadPage()
    const relays: Record<string, Relay> = { [DIVINE]: [event(10011, 100, [TWITTER])] }
    const h = harness(relays, { removing: { platform: 'twitter', identity: 'alice' }, revokeOk: false })
    await page(h.env).executeRemoveVerification()
    const originalTime = h.published[0].created_at
    relays[DIVINE] = [event(10011, originalTime + 10, [GITHUB])]
    await h.element('retry-revoke-btn').click()
    expect(h.signs()).toBe(2)
    // A different relay can later reveal a relink newer than the first removal,
    // even though it predates the latest failed retry's replacement list.
    relays[DIVINE] = [event(10011, originalTime + 5, [TWITTER])]
    await h.element('retry-revoke-btn').click()
    expect(h.signs()).toBe(2)
    expect(h.published).toHaveLength(2)
    expect(h.fetches).toHaveLength(2)
    expect(h.element('retry-revoke-btn').hidden).toBe(true)
    expect(h.element('manage-status').textContent).toContain('linked again; remove it from the list if you still want to unlink')
  })

  it('disables the retry button while a retry runs', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: [event(10011, 100, [TWITTER])] },
      { removing: { platform: 'twitter', identity: 'alice' }, revokeOk: false })
    const button = h.element('retry-revoke-btn')
    let duringRetry: boolean | undefined
    const fetchOnce = h.env.fetch as (...args: unknown[]) => Promise<unknown>
    h.env.fetch = async (...args: unknown[]) => { duringRetry = button.disabled; return fetchOnce(...args) }
    page(h.env)
    await h.element('remove-confirm-btn').click()
    expect(button.disabled).toBe(false)
    duringRetry = undefined
    await button.click()

    expect(duringRetry).toBe(true)
    expect(button.disabled).toBe(false)
  })

  it('retries the original claim after the dialog was reopened for another row', async () => {
    const page = await loadPage()
    const removing = { platform: 'twitter', identity: 'alice' }
    const h = harness({ [DIVINE]: [event(10011, 100, [TWITTER])] }, { removing, revokeOk: false })
    page(h.env)
    await h.element('remove-confirm-btn').click()
    removing.platform = 'youtube'
    removing.identity = 'someone-else'
    await h.element('retry-revoke-btn').click()

    expect(h.fetches).toHaveLength(2)
    expect(JSON.parse(h.fetches[1].init.body as string)).toMatchObject({ platform: 'twitter', identity: 'alice' })
  })

  it('keeps retry owned by the original signer across an account switch', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: [event(10011, 100, [TWITTER])] },
      { removing: { platform: 'twitter', identity: 'alice' }, revokeOk: false })
    let pubkey = PUBKEY
    h.env.getActivePubkey = async () => pubkey
    ;(h.env.activeSigner as { getPublicKey: () => Promise<string> }).getPublicKey = async () => pubkey
    page(h.env)
    await h.element('remove-confirm-btn').click()
    const requests = h.requests.length
    pubkey = OTHER_PUBKEY
    await h.element('retry-revoke-btn').click()

    expect(h.element('manage-status').textContent).toBe('Sign in with the original account to retry this removal.')
    expect(h.signs()).toBe(1)
    expect(h.fetches).toHaveLength(1)
    expect(h.requests).toHaveLength(requests)
    expect(h.element('retry-revoke-btn').hidden).toBe(false)
    pubkey = PUBKEY
    await h.element('retry-revoke-btn').click()
    expect(h.signs()).toBe(2)
  })

  it('does not call revoke for a platform without sign-in', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: [event(10011, 100, [GITHUB, MASTODON])], 'wss://two.example': [], 'wss://three.example': [] }, { removing })

    await page(h.env).executeRemoveVerification()

    expect(h.fetches).toEqual([])
  })

  it('publishes nothing when the current list couldn\'t be read', async () => {
    const page = await loadPage()
    const h = harness({ [DIVINE]: 'unreachable', 'wss://two.example': [], 'wss://three.example': 'refuses' }, { removing })

    await page(h.env).executeRemoveVerification()

    expect(h.published).toEqual([])
    expect(h.errors()).toEqual([['manage-status', UNREAD, 'error']])
  })
})

describe('loading nostr-tools', () => {
  it('loads it from the verifier itself', async () => {
    const html = await pageHtml()
    expect(NOSTR_TOOLS_MODULE_PATH).toMatch(/^\/vendor\/nostr-tools\.mjs\?v=[0-9a-f]{12}$/)
    expect(html).toContain(`const NOSTR_TOOLS_URL = '${NOSTR_TOOLS_MODULE_PATH}';`)
    expect(html).not.toContain('esm.sh')
  })

  // Runs the page's real loader. Functions made with new Function can't use
  // import() here, so the loader's import() goes to a stand-in that records
  // each address and fails until `available` is set.
  async function loadLoader() {
    const html = await pageHtml()
    const source = scriptBetween(html, 'async function loadNostrTools()', 'function extractHexFromText(text)')
    // The loader's state, as the page declares it.
    const declarations = scriptBetween(html, 'let nostrToolsPromise = null;', 'let nostrConnectAttempt')
    expect(source.match(/\bimport\(/g)).toHaveLength(1)
    const addresses: string[] = []
    const state = { available: false }
    const importModule = async (address: string) => {
      addresses.push(address)
      if (!state.available) throw new TypeError(`Failed to fetch dynamically imported module: ${address}`)
      return { address }
    }
    const loadNostrTools = new Function('importModule', 'NOSTR_TOOLS_URL',
      `${declarations}\n${source.replace(/\bimport\(/g, 'importModule(')}\nreturn loadNostrTools;`)(importModule, '/vendor/nostr-tools.mjs?v=1')
    return { loadNostrTools: loadNostrTools as () => Promise<{ address: string }>, state, addresses }
  }

  // A browser can keep the result of a module load that failed and hand it
  // back for the same address, so each try after a failure asks for a new one.
  it('tries again at a new address after an import fails', async () => {
    const l = await loadLoader()
    await expect(l.loadNostrTools()).rejects.toThrow('Failed to fetch')
    await expect(l.loadNostrTools()).rejects.toThrow('Failed to fetch')

    l.state.available = true
    const tools = await l.loadNostrTools()
    expect(l.addresses).toEqual([
      '/vendor/nostr-tools.mjs?v=1',
      '/vendor/nostr-tools.mjs?v=1&retry=1',
      '/vendor/nostr-tools.mjs?v=1&retry=2',
    ])
    expect(tools).toEqual({ address: '/vendor/nostr-tools.mjs?v=1&retry=2' })
  })

  it('keeps a successful import', async () => {
    const l = await loadLoader()
    l.state.available = true
    const first = await l.loadNostrTools()
    const second = await l.loadNostrTools()
    expect(second).toBe(first)
    expect(l.addresses).toEqual(['/vendor/nostr-tools.mjs?v=1'])
  })
})
