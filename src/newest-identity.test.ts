import { describe, expect, it } from 'vitest'
import worker from './index'

// Runs the landing page's real code for publishing, listing and removing
// linked accounts against stand-ins for the relays, the signer and the page,
// so the tests exercise the shipped script rather than a copy of it. The
// relays can each hold a different copy of the identity event (kind 10011)
// or the profile (kind 0); the page must build on the newest.

const API = 'https://verifier.divine.video'
const PUBKEY = 'ab'.repeat(32)
const OTHER_PUBKEY = 'cd'.repeat(32)
const RELAYS = ['wss://one.example', 'wss://two.example', 'wss://three.example']

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

const DEPS = ['document', 'fetch', 'API', 'PROFILE_RELAYS', 'fetchEventByKind', 'publishEventToRelay', 'activeSigner',
  'getActivePubkey', 'signerPubkeyHex', 'setStatus', 'clearStatus', 'setButtonLoading', 'setAccountInputValue',
  'updateSignerSummary', 'currentProofContext', 'renderLinkedVerifications', 'buildNip98EventForRevoke', 'OAUTH_PLATFORMS_SET']

async function loadPage() {
  const html = await pageHtml()
  const source = [
    // The relay read helpers, without fetchEventByKind itself (a stand-in replaces it).
    scriptBetween(html, 'function fetchIdentityEvent(relayUrl, pubkey)', 'function fetchEventByKind(relayUrl, pubkey, kind)'),
    scriptBetween(html, 'async function publishIdentityTagToNostr()', 'const PENDING_SIGN_IN_KEY'),
    scriptBetween(html, 'async function loadLinkedVerifications()', '// Renders manage table'),
    scriptBetween(html, 'async function executeRemoveVerification()', 'async function buildNip98EventForRevoke('),
  ].join('\n')
  return (env: Record<string, unknown>) =>
    new Function(...DEPS, `${source}\nreturn { publishIdentityTagToNostr, loadLinkedVerifications, executeRemoveVerification };`)(...DEPS.map(d => env[d]))
}

type NostrEvent = { id: string, pubkey: string, kind: number, created_at: number, tags: string[][], content: string }
type RelayAnswers = { [kind: number]: NostrEvent | 'error' }

function iTag(platform: string, identity: string, proof: string) {
  return ['i', `${platform}:${identity}`, proof]
}

function event(kind: number, createdAt: number, tags: string[][], overrides: Partial<NostrEvent> = {}): NostrEvent {
  return { id: '11'.repeat(32), pubkey: PUBKEY, kind, created_at: createdAt, tags, content: '', ...overrides }
}

function harness(relays: Record<string, RelayAnswers>, opts: { removing?: { platform: string, identity: string } } = {}) {
  const published: NostrEvent[] = []
  const statuses: Array<[string, string, string]> = []
  const listed: string[][][] = []
  // Each relay query, in the order the page made them.
  const queries: string[] = []
  const dialog = { style: { display: '' }, dataset: opts.removing ?? {} }
  const env: Record<string, unknown> = {
    API,
    PROFILE_RELAYS: Object.keys(relays),
    document: { getElementById: (id: string) => id === 'remove-confirm-dialog' ? dialog : { textContent: '', innerHTML: '' } },
    fetch: async () => ({ ok: true }),
    fetchEventByKind: async (relay: string, pubkey: string, kind: number) => {
      queries.push(`${relay} ${kind}`)
      await Promise.resolve()
      const answer = relays[relay]?.[kind]
      if (answer === 'error') throw new Error('ws error')
      return answer ?? null
    },
    publishEventToRelay: async (_relay: string, signed: NostrEvent) => {
      published.push(signed)
      return { ok: true }
    },
    activeSigner: {
      getPublicKey: async () => PUBKEY,
      signEvent: async (unsigned: Omit<NostrEvent, 'id'>) => ({ ...unsigned, id: 'ee'.repeat(32), sig: 'ff'.repeat(64) }),
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
    expect(published).toHaveLength(RELAYS.length)
    return published[0].tags
  }
  return { env, publishedTags, errors, listed, queries }
}

const GITHUB = iTag('github', 'octocat', 'gist1')
const MASTODON = iTag('mastodon', 'mastodon.social/@alice', 'post1')
const BLUESKY = iTag('bluesky', 'alice.bsky.social', 'post2')
const NEW_CLAIM = iTag('github', 'newuser', 'newgist')

describe('publishing a linked account', () => {
  it('builds on the newest identity event, not the first relay\'s copy', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 10011: event(10011, 100, [GITHUB]) },
      'wss://two.example': { 10011: event(10011, 300, [GITHUB, MASTODON, BLUESKY]) },
      'wss://three.example': { 10011: event(10011, 200, [GITHUB, MASTODON]) },
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.errors()).toEqual([])
    expect(h.publishedTags()).toEqual([GITHUB, MASTODON, BLUESKY, NEW_CLAIM])
  })

  it('keeps the copy with the lowest id when two have the same created_at, as NIP-01 says', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 10011: event(10011, 300, [GITHUB], { id: 'bb'.repeat(32) }) },
      'wss://two.example': { 10011: event(10011, 300, [MASTODON], { id: 'aa'.repeat(32) }) },
      'wss://three.example': { 10011: event(10011, 300, [BLUESKY], { id: 'cc'.repeat(32) }) },
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([MASTODON, NEW_CLAIM])
  })

  it('asks every relay before any of them answers', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 10011: event(10011, 100, [GITHUB]) },
      'wss://two.example': {},
      'wss://three.example': {},
    })
    // Hold the first relay's answer until the page has asked all three. A
    // page that asks one relay at a time never gets there; let the answer go
    // after a moment then, so the test fails rather than hangs.
    const answer = h.env.fetchEventByKind as (relay: string, pubkey: string, kind: number) => Promise<unknown>
    let askedAll!: () => void
    const allAsked = new Promise<void>(resolve => { askedAll = resolve })
    setTimeout(() => askedAll(), 50)
    let askedBeforeFirstAnswer = 0
    h.env.fetchEventByKind = async (relay: string, pubkey: string, kind: number) => {
      const result = answer(relay, pubkey, kind)
      if (h.queries.length === RELAYS.length) askedAll()
      await allAsked
      if (!askedBeforeFirstAnswer) askedBeforeFirstAnswer = h.queries.length
      return result
    }

    await page(h.env).publishIdentityTagToNostr()

    expect(askedBeforeFirstAnswer).toBe(RELAYS.length)
    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('still uses the newest copy when another relay fails', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 10011: 'error' },
      'wss://two.example': { 10011: event(10011, 100, [GITHUB]) },
      'wss://three.example': { 10011: event(10011, 200, [GITHUB, MASTODON]) },
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, MASTODON, NEW_CLAIM])
  })

  it('falls back to the newest profile when no relay has an identity event', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 0: event(0, 100, [GITHUB]) },
      'wss://two.example': { 0: event(0, 200, [GITHUB, MASTODON]) },
      'wss://three.example': { 0: 'error' },
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, MASTODON, NEW_CLAIM])
  })

  it('uses an identity event over a newer profile, since the identity event replaced the profile\'s list', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 0: event(0, 900, [BLUESKY]) },
      'wss://two.example': { 10011: event(10011, 100, [GITHUB]) },
      'wss://three.example': {},
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('ignores a copy signed by someone else, however new', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 10011: event(10011, 900, [BLUESKY], { pubkey: OTHER_PUBKEY }) },
      'wss://two.example': { 10011: event(10011, 100, [GITHUB]) },
      'wss://three.example': {},
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('ignores a copy of another kind, however new', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 10011: event(3, 900, [BLUESKY]) },
      'wss://two.example': { 10011: event(10011, 100, [GITHUB]) },
      'wss://three.example': {},
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('ignores a copy whose created_at is not a whole number', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 10011: event(10011, '900' as unknown as number, [BLUESKY]) },
      'wss://two.example': { 10011: event(10011, 900.5, [MASTODON]) },
      'wss://three.example': { 10011: event(10011, 100, [GITHUB]) },
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })

  it('ignores a copy without an id, which it could not break a tie with', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 10011: event(10011, 900, [BLUESKY], { id: undefined as unknown as string }) },
      'wss://two.example': { 10011: event(10011, 100, [GITHUB]) },
      'wss://three.example': {},
    })

    await page(h.env).publishIdentityTagToNostr()

    expect(h.publishedTags()).toEqual([GITHUB, NEW_CLAIM])
  })
})

describe('listing linked accounts to manage', () => {
  it('lists the newest identity event\'s accounts', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 10011: event(10011, 100, [GITHUB]) },
      'wss://two.example': { 10011: event(10011, 200, [GITHUB, MASTODON]) },
      'wss://three.example': {},
    })

    await page(h.env).loadLinkedVerifications()

    expect(h.listed).toEqual([[GITHUB, MASTODON]])
  })

  it('lists the newest profile\'s accounts when no relay has an identity event', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 0: event(0, 100, [GITHUB]) },
      'wss://two.example': { 0: event(0, 200, [GITHUB, MASTODON]) },
      'wss://three.example': {},
    })

    await page(h.env).loadLinkedVerifications()

    expect(h.listed).toEqual([[GITHUB, MASTODON]])
  })
})

describe('removing a linked account', () => {
  it('builds on the newest identity event, not the first relay\'s copy', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 10011: event(10011, 100, [GITHUB, MASTODON]) },
      'wss://two.example': { 10011: event(10011, 200, [GITHUB, MASTODON, BLUESKY]) },
      'wss://three.example': {},
    }, { removing: { platform: 'mastodon', identity: 'mastodon.social/@alice' } })

    await page(h.env).executeRemoveVerification()

    expect(h.errors()).toEqual([])
    expect(h.publishedTags()).toEqual([GITHUB, BLUESKY])
  })

  it('falls back to the newest profile when no relay has an identity event', async () => {
    const page = await loadPage()
    const h = harness({
      'wss://one.example': { 0: event(0, 100, [GITHUB, MASTODON]) },
      'wss://two.example': { 0: event(0, 200, [GITHUB, MASTODON, BLUESKY]) },
      'wss://three.example': {},
    }, { removing: { platform: 'mastodon', identity: 'mastodon.social/@alice' } })

    await page(h.env).executeRemoveVerification()

    expect(h.publishedTags()).toEqual([GITHUB, BLUESKY])
  })
})
