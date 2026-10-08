import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_BATCH_SIZE, renderVerifyHtml } from './verify'
import type { VerifyResult } from '../types'
import { VALID_PLATFORMS } from '../utils/validation'

// Runs the real script of the page behind a verification link (its init()
// and the code it reads linked accounts with) against stand-ins for the
// relays, the network and the page, so the test exercises the shipped script
// rather than a copy of it.

const PUBKEY = 'ab'.repeat(32)
const API = 'https://verifier.divine.video'
const RESULT: VerifyResult = { platform: 'github', identity: 'octocat', verified: true, checked_at: 1_700_000_000, cached: false }

function pageScript() {
  const html = renderVerifyHtml(RESULT, 'github', 'octocat', 'abc123', PUBKEY, 'npub1test', `${API}/verify/github/octocat/abc123?pubkey=${PUBKEY}`, API)
  const batchSize = Number(html.match(/var VERIFY_BATCH_SIZE = (\d+);/)?.[1])
  return { html, batchSize }
}

function section(html: string, from: string, to: string) {
  const start = html.indexOf(from)
  const end = html.indexOf(to, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

function loadInit() {
  const { html, batchSize } = pageScript()
  expect(batchSize).toBe(MAX_BATCH_SIZE)
  const source = section(html, 'function linkedAccountClaims(', '\n    init();')
  const deps = ['RELAYS', 'PUBKEY', 'API', 'VERIFY_BATCH_SIZE', 'fetchEventByKind', 'renderProfile', 'renderOtherIdentities',
    'tryParseJSON', 'proofUrl', 'document', 'fetch']
  return (env: Record<string, unknown>) =>
    new Function(...deps, `${source}\nreturn init;`)(...deps.map(d => d === 'VERIFY_BATCH_SIZE' ? batchSize : env[d]))
}

function iTag(platform: string, identity: string, proof: string) {
  return ['i', `${platform}:${identity}`, proof]
}

type Event = { kind: number, tags: unknown, content: string } | null

function harness(opts: {
  identityEvent?: Event
  profile?: Event
  // Per-relay answers; when set, a relay not listed has neither event.
  relays?: Record<string, { identityEvent?: Event, profile?: Event } | 'unreachable'>
  failBatch?: number
  nip05Breaks?: boolean
  canonicalProof?: string
  // Extra ticks before a relay answers the identity-event query.
  slowIdentityAnswer?: number
}) {
  const rendered: Array<Array<Record<string, unknown>>> = []
  // Order of what the page did: relay queries and the header being shown.
  const steps: string[] = []
  const requests: string[] = []
  const profiles: unknown[] = []
  const verifyBatches: number[] = []
  const listElement = { innerHTML: '', style: { display: '' } }
  const env: Record<string, unknown> = {
    RELAYS: opts.relays ? Object.keys(opts.relays) : ['wss://relay.example'],
    PUBKEY,
    API,
    fetchEventByKind: async (relay: string, _pubkey: string, kind: number) => {
      steps.push(`query ${relay} ${kind}`)
      const ticks = 1 + (kind === 10011 ? (opts.slowIdentityAnswer ?? 0) : 0)
      for (let t = 0; t < ticks; t++) await Promise.resolve()
      steps.push(`answer ${relay} ${kind}`)
      const answers = opts.relays ? (opts.relays[relay] ?? {}) : opts
      if (answers === 'unreachable') throw new Error('ws error')
      return kind === 10011 ? (answers.identityEvent ?? null) : (answers.profile ?? null)
    },
    renderProfile: (profile: unknown) => { profiles.push(profile); steps.push('header') },
    renderOtherIdentities: (results: Array<Record<string, unknown>>) => { rendered.push(results) },
    tryParseJSON: (s: unknown) => { try { return JSON.parse(s as string) } catch { return null } },
    proofUrl: (platform: string, identity: string, proof: string) => `https://proof.example/${platform}/${identity}/${proof}`,
    document: { getElementById: () => listElement },
    fetch: async (url: string, init?: { body?: string }) => {
      requests.push(url)
      if (url.startsWith(`${API}/nip05/verify`)) {
        if (opts.nip05Breaks) return { json: async () => { throw new SyntaxError('Unexpected token <') } }
        return { json: async () => ({ verified: true, cached: false }) }
      }
      if (url === `${API}/verify`) {
        const { claims } = JSON.parse(init!.body!) as { claims: Array<{ platform: string, identity: string }> }
        verifyBatches.push(claims.length)
        // Mirror the server's batch limit.
        if (claims.length > MAX_BATCH_SIZE) return { json: async () => ({ error: `Maximum ${MAX_BATCH_SIZE} claims per request` }) }
        if (opts.failBatch === verifyBatches.length) throw new TypeError('Failed to fetch')
        return { json: async () => ({ results: claims.map(c => ({ ...c, verified: true, cached: false, ...(opts.canonicalProof ? { canonical_proof: opts.canonicalProof } : {}) })) }) }
      }
      throw new Error(`unexpected fetch ${url}`)
    },
  }
  return { env, rendered, profiles, verifyBatches, listElement, steps, requests }
}

const profileWith = (content: Record<string, unknown>, tags: unknown = []): Event => ({ kind: 0, tags, content: JSON.stringify(content) })
const identityEventWith = (tags: unknown): Event => ({ kind: 10011, tags, content: '' })
const rows = (results: Array<Record<string, unknown>>) => results.map(r => `${r.platform}:${r.identity}`)

describe('verification-link page: all verified identities', () => {
  it('checks every platform accepted by the API and skips unknown platforms', async () => {
    const init = loadInit()
    const h = harness({
      identityEvent: identityEventWith([...VALID_PLATFORMS.map(platform => iTag(platform, 'account', 'proof')), iTag('unknown', 'account', 'proof')]),
      profile: profileWith({}),
    })
    await init(h.env)()
    expect(h.rendered[0].map(result => result.platform)).toEqual(VALID_PLATFORMS)
  })

  it('lists the accounts in the identity event, not only the older profile format', async () => {
    const init = loadInit()
    const h = harness({
      identityEvent: identityEventWith([iTag('github', 'octocat', 'abc123'), iTag('bluesky', 'alice.bsky.social', 'post1')]),
      profile: profileWith({ name: 'Alice' }, [iTag('twitter', 'old_handle', '111')]),
    })
    await init(h.env)()
    expect(rows(h.rendered[0])).toEqual(['github:octocat', 'bluesky:alice.bsky.social'])
    expect(h.profiles[0]).toMatchObject({ kind: 0 })
  })

  it('falls back to the accounts in the profile when there is no identity event', async () => {
    const init = loadInit()
    const h = harness({ profile: profileWith({ name: 'Alice' }, [iTag('github', 'octocat', 'abc123')]) })
    await init(h.env)()
    expect(rows(h.rendered[0])).toEqual(['github:octocat'])
  })

  // Two full batches and a partial one, whatever the server's limit is.
  const accounts = 2 * MAX_BATCH_SIZE + 3
  const manyTags = () => Array.from({ length: accounts }, (_, i) => iTag('github', `user${i}`, `gist${i}`))

  it('checks more accounts than one request allows, in batches the server accepts', async () => {
    const init = loadInit()
    const h = harness({ identityEvent: identityEventWith(manyTags()), profile: profileWith({}) })
    await init(h.env)()
    expect(h.verifyBatches).toEqual([MAX_BATCH_SIZE, MAX_BATCH_SIZE, 3])
    expect(h.rendered[0]).toHaveLength(accounts)
    const last = accounts - 1
    expect(h.rendered[0][last]).toMatchObject({ identity: `user${last}`, _proofUrl: `https://proof.example/github/user${last}/gist${last}` })
  })

  it('skips entries that are not well-formed linked accounts and lists the rest', async () => {
    const init = loadInit()
    const h = harness({
      identityEvent: identityEventWith([
        null,
        'i',
        ['i', 123, 'proof'],
        ['i', 'github:no-proof'],
        ['i', 'github:numeric-proof', 7],
        ['i', { platform: 'github' }, 'proof'],
        iTag('github', 'octocat', 'abc123'),
      ]),
      profile: profileWith({}),
    })
    await init(h.env)()
    expect(rows(h.rendered[0])).toEqual(['github:octocat'])
  })

  it('shows nothing, without failing, when the identity event\'s tags are not a list', async () => {
    const init = loadInit()
    const h = harness({ identityEvent: identityEventWith({ 0: ['i', 'github:octocat', 'abc123'] }), profile: profileWith({}) })
    await expect(init(h.env)()).resolves.toBeUndefined()
    expect(h.rendered).toEqual([])
    expect(h.verifyBatches).toEqual([])
  })

  it('still checks and lists the other batches when one in the middle fails', async () => {
    const init = loadInit()
    const h = harness({ identityEvent: identityEventWith(manyTags()), profile: profileWith({}), failBatch: 2 })
    await init(h.env)()
    expect(h.verifyBatches).toEqual([MAX_BATCH_SIZE, MAX_BATCH_SIZE, 3])
    expect(h.rendered[0]).toHaveLength(MAX_BATCH_SIZE + 3)
    expect(h.rendered[0][MAX_BATCH_SIZE + 2]).toMatchObject({ identity: `user${accounts - 1}` })
  })

  it('looks on other relays until it has both events, then stops', async () => {
    const init = loadInit()
    const h = harness({
      relays: {
        'wss://one.example': { identityEvent: identityEventWith([iTag('github', 'octocat', 'abc123')]) },
        'wss://two.example': { profile: profileWith({ name: 'Alice' }) },
        'wss://three.example': {},
      },
    })
    await init(h.env)()
    expect(h.profiles[0]).toMatchObject({ kind: 0 })
    expect(rows(h.rendered[0])).toEqual(['github:octocat'])
    expect(h.steps.some(step => step.includes('three.example'))).toBe(false)
  })

  it('moves on to the next relay when one can\'t be reached', async () => {
    const init = loadInit()
    const h = harness({
      relays: {
        'wss://down.example': 'unreachable',
        'wss://up.example': { identityEvent: identityEventWith([iTag('github', 'octocat', 'abc123')]), profile: profileWith({ name: 'Alice' }) },
      },
    })
    await init(h.env)()
    expect(h.profiles[0]).toMatchObject({ kind: 0 })
    expect(rows(h.rendered[0])).toEqual(['github:octocat'])
  })

  it('asks each relay for both events at once', async () => {
    const init = loadInit()
    const h = harness({
      relays: { 'wss://one.example': { identityEvent: identityEventWith([iTag('github', 'octocat', 'abc123')]), profile: profileWith({}) } },
    })
    await init(h.env)()
    const firstAnswer = h.steps.findIndex(step => step.startsWith('answer'))
    expect(h.steps.slice(0, firstAnswer)).toEqual(['query wss://one.example 10011', 'query wss://one.example 0'])
  })

  it('shows the header when the profile answers, without waiting for the identity event', async () => {
    const init = loadInit()
    const h = harness({
      relays: { 'wss://one.example': { identityEvent: identityEventWith([iTag('github', 'octocat', 'abc123')]), profile: profileWith({ name: 'Alice' }) } },
      slowIdentityAnswer: 10,
    })
    await init(h.env)()
    expect(h.steps.indexOf('header')).toBeLessThan(h.steps.indexOf('answer wss://one.example 10011'))
  })

  it('lists the accounts from the identity event when no relay has a profile', async () => {
    const init = loadInit()
    const h = harness({ identityEvent: identityEventWith([iTag('github', 'octocat', 'abc123')]) })
    await init(h.env)()
    expect(rows(h.rendered[0])).toEqual(['github:octocat'])
    expect(h.profiles).toEqual([null])
    expect(h.requests.some(url => url.includes('/nip05/verify'))).toBe(false)
  })

  it('shows the profile header as soon as it has the profile, before asking other relays', async () => {
    const init = loadInit()
    const h = harness({
      relays: {
        'wss://one.example': { profile: profileWith({ name: 'Alice' }, [iTag('github', 'octocat', 'abc123')]) },
        'wss://two.example': {},
      },
    })
    await init(h.env)()
    expect(h.steps.indexOf('header')).toBeGreaterThan(-1)
    expect(h.steps.indexOf('header')).toBeLessThan(h.steps.findIndex(step => step.includes('two.example')))
    expect(h.steps.filter(step => step === 'header')).toHaveLength(1)
    expect(rows(h.rendered[0])).toEqual(['github:octocat'])
  })

  it('links each account\'s proof with the post number the server resolved', async () => {
    const init = loadInit()
    const h = harness({
      identityEvent: identityEventWith([iTag('tiktok', 'alice', 'https://vm.tiktok.com/ZMabc/')]),
      profile: profileWith({}),
      canonicalProof: '7380000000000000000',
    })
    await init(h.env)()
    expect(h.rendered[0][0]).toMatchObject({ _proofUrl: 'https://proof.example/tiktok/alice/7380000000000000000' })
  })

  it('leaves out a NIP-05 that isn\'t text, without checking it', async () => {
    const init = loadInit()
    const h = harness({ identityEvent: identityEventWith([iTag('github', 'octocat', 'abc123')]), profile: profileWith({ nip05: 42 }) })
    await init(h.env)()
    expect(rows(h.rendered[0])).toEqual(['github:octocat'])
    expect(h.requests.some(url => url.includes('/nip05/verify'))).toBe(false)
  })

  it('shows the NIP-05 as not verified, and keeps the other accounts, when its check fails', async () => {
    const init = loadInit()
    const h = harness({
      identityEvent: identityEventWith([iTag('github', 'octocat', 'abc123')]),
      profile: profileWith({ nip05: 'alice@divine.video' }),
      nip05Breaks: true,
    })
    await init(h.env)()
    expect(h.rendered[0]).toEqual([
      expect.objectContaining({ platform: 'nip05', identity: 'alice@divine.video', verified: false }),
      expect.objectContaining({ platform: 'github', identity: 'octocat', verified: true }),
    ])
  })
})

describe('verification-link page: asking a relay for an event', () => {
  afterEach(() => { vi.useRealTimers() })

  function loadFetchEventByKind() {
    const { html } = pageScript()
    const source = section(html, 'function fetchEventByKind(', '\n    function tryParseJSON')
    return new Function('WebSocket', `${source}\nreturn fetchEventByKind;`)
  }

  it('gives up cleanly, with no timer left to fire, when the socket can\'t be opened', async () => {
    vi.useFakeTimers()
    const Throws = function () { throw new Error('blocked') } as unknown as typeof WebSocket
    const fetchEvent = loadFetchEventByKind()(Throws)
    await expect(fetchEvent('wss://relay.example', PUBKEY, 0)).rejects.toThrow('blocked')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops waiting when the relay hangs up without answering', async () => {
    vi.useFakeTimers()
    let socket: { onclose?: () => void, close: () => void, send: () => void } | undefined
    const Hangs = function (this: unknown) { socket = { close: () => {}, send: () => {} }; return socket } as unknown as typeof WebSocket
    const fetchEvent = loadFetchEventByKind()(Hangs)
    const result = fetchEvent('wss://relay.example', PUBKEY, 0)
    socket!.onclose!()
    await expect(result).rejects.toThrow('ws closed')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('verification-link page: profile header', () => {
  function loadRenderProfile() {
    const { html } = pageScript()
    const source = section(html, 'function renderProfile(', '\n    // Render other verified identities')
    return new Function('document', 'NPUB', 'esc', 'tryParseJSON', `${source}\nreturn renderProfile;`)
  }

  it('renders a profile whose name, picture and NIP-05 are not text, without failing', () => {
    const header = { innerHTML: '', style: { display: '' }, classList: { remove: () => {} }, querySelector: () => null }
    const document = {
      getElementById: () => header,
      querySelector: () => null,
      createElement: () => ({ setAttribute: () => {} }),
      head: { appendChild: () => {} },
    }
    const esc = (s: unknown) => String(s ?? '')
    const tryParseJSON = (s: string) => JSON.parse(s)
    const renderProfile = loadRenderProfile()(document, 'npub1test', esc, tryParseJSON)
    renderProfile({ kind: 0, tags: [], content: JSON.stringify({ name: { first: 'A' }, picture: 5, nip05: 42 }) })
    expect(header.style.display).toBe('flex')
    expect(header.innerHTML).toContain('npub1test')
    expect(header.innerHTML).not.toContain('42')
  })
})

describe('verification-link page: values placed in links and images', () => {
  // A stand-in for a browser element: like a real one, reading innerHTML back
  // from textContent escapes &, < and > (and no-break spaces) but not quotes.
  function fakeElement() {
    let text = ''
    return {
      set textContent(v: string) { text = String(v) },
      get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;') },
    }
  }

  function pageFunctions() {
    const { html } = pageScript()
    const esc = section(html, 'function esc(s) {', '\n    function proofUrl(')
    const renderOther = section(html, 'function renderOtherIdentities(', '\n    // The linked accounts on an event')
    const renderProfile = section(html, 'function renderProfile(', '\n    // Render other verified identities')
    return { esc, renderOther, renderProfile }
  }

  // Every attribute value in the output is one quoted string: a value with a
  // quote in it is escaped, so it can't end the attribute early.
  function attributes(markup: string) {
    return [...markup.matchAll(/\s([a-z-]+)=("[^"]*"|'[^']*')/g)].map(m => [m[1], m[2]])
  }

  it('keeps a proof link with quotes in it inside its href', () => {
    const { esc, renderOther } = pageFunctions()
    const list = { innerHTML: '', style: { display: '' } }
    const document = { createElement: fakeElement, getElementById: () => list }
    const render = new Function('document', 'PLATFORM_LABELS', 'CURRENT_PLATFORM', 'CURRENT_IDENTITY', 'platformIconHtml',
      `${esc}\n${renderOther}\nreturn renderOtherIdentities;`)(document, { github: 'GitHub' }, 'github', 'octocat', () => '')
    render([{ platform: 'github', identity: 'someone', verified: true, _proofUrl: 'https://gist.github.com/someone/x" data-extra="1' }])
    const hrefs = attributes(list.innerHTML).filter(([name]) => name === 'href')
    expect(hrefs).toEqual([['href', '"https://gist.github.com/someone/x&quot; data-extra=&quot;1"']])
    expect(list.innerHTML).not.toContain('data-extra="1"')
  })

  it('keeps a picture and profile link with quotes in them inside their attributes', () => {
    const { esc, renderProfile } = pageFunctions()
    const header = { innerHTML: '', style: { display: '' }, classList: { remove: () => {} }, querySelector: () => null }
    const document = {
      createElement: fakeElement,
      getElementById: () => header,
      querySelector: () => ({ setAttribute: () => {} }),
      head: { appendChild: () => {} },
    }
    const render = new Function('document', 'NPUB', 'tryParseJSON', `${esc}\n${renderProfile}\nreturn renderProfile;`)(
      document, 'npub1test', (s: string) => JSON.parse(s))
    render({ kind: 0, tags: [], content: JSON.stringify({ name: 'Alice', picture: 'https://img.example/a.png" data-extra="1', nip05: `x'y"z@divine.video` }) })
    expect(header.innerHTML).not.toContain('data-extra="1"')
    const src = attributes(header.innerHTML).find(([name]) => name === 'src')
    expect(src).toEqual(['src', '"https://img.example/a.png&quot; data-extra=&quot;1"'])
    const profileLink = attributes(header.innerHTML).find(([name]) => name === 'href')
    expect(profileLink).toEqual(['href', '"https://x&#39;y&quot;z.divine.video"'])
  })
})
