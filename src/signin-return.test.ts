import { beforeAll, describe, expect, it, vi } from 'vitest'
import worker from './index'

const API = 'https://verifier.divine.video'
const PUBKEY = 'ab'.repeat(32)
const PENDING_PREFIX = 'verifier_pending_sign_in:'
const NONCE = '0123456789abcdef'.repeat(2)
const PENDING_KEY = PENDING_PREFIX + NONCE
// The shared test vector's one-time code, start secret and start check.
const CODE = 'C'.repeat(43)
const START_SECRET = 'S'.repeat(43)
const START_CHECK = 'G2CN_J8Es1JmsWz0QXd2Kc-4p-lCo8GCsR-tVw6vre4'
const NOT_STARTED_HERE = 'This sign-in wasn\'t started on this page. If someone sent you a sign-in link, don\'t continue.'
const NOT_STARTED: [string, string, string] = ['verify-global-status', NOT_STARTED_HERE, 'error']
const UNCONFIRMED: [string, string, string] = ['verify-global-status', 'This page could not confirm a sign-in. Start the sign-in again from this page.', 'error']
const SIGNED_IN = 'Signed in to Twitter as jack. Publish to link it to your Divine account.'
const SAVE_REFUSED: [string, string, string] = ['oauth-status', 'This browser blocked the page from saving your sign-in, so it can\'t be confirmed. Allow this site to store data and try again.', 'error']

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

// Runs the landing page's real sign-in return code (from the pending sign-in
// helpers through handleOAuthCallbackMessage and resumeWaitingSignIn) against
// stand-ins for the browser, so the test exercises the shipped script rather
// than a copy of it.
async function loadReturnHandler() {
  const source = scriptBetween(await pageHtml(), 'const PENDING_SIGN_IN_KEY', 'function showStatus(msg, type)')
  const deps = ['window', 'localStorage', 'fetch', 'setStatus', 'clearStatus', 'document', 'updateProofInputs', 'activeSigner', 'activateSigner', 'createBrowserSigner', 'isBrowserSignerAvailable']
  return (env: Record<string, unknown>) =>
    new Function(...deps, `${source}\nreturn { handleOAuthCallbackMessage, resumeWaitingSignIn, rememberPendingSignIn, newSignInNonce, readPendingSignIn };`)(...deps.map(d => env[d]))
}

// Runs the page's real sign-in start (startOAuthVerification, with the
// hashing, setAccountInputValue and pending sign-in helpers it calls) against
// stand-ins for the browser and the rest of the page.
async function loadSignInStart() {
  const html = await pageHtml()
  const source = [
    scriptBetween(html, 'function bytesToBase64Url(bytes)', 'async function createKeycastPkce()'),
    scriptBetween(html, 'function setAccountInputValue(value)', 'function inferLoginQueryPubkey(params)'),
    scriptBetween(html, 'async function startOAuthVerification()', 'async function verifySingleHere()'),
    scriptBetween(html, 'const PENDING_SIGN_IN_KEY', 'function showStatus(msg, type)'),
  ].join('\n')
  const deps = ['window', 'localStorage', 'fetch', 'API', 'setStatus', 'clearStatus', 'setButtonLoading', 'document', 'activeSigner', 'activeSignerSource', 'crypto', 'btoa']
  return (env: Record<string, unknown>) =>
    new Function(...deps, `${source}\nreturn { startOAuthVerification, startCheckFor, confirmBindingFor, setAccountInputValue };`)(...deps.map(d => env[d]))
}

// Stands in for localStorage in a browser that blocks site data, where every
// use of it throws.
const blockedStorage = () => {
  const blocked = (): never => { throw new Error('SecurityError: access is denied for this document') }
  return { get length() { return blocked() }, key: blocked, getItem: blocked, setItem: blocked, removeItem: blocked }
}

function startHarness(opts: { refusePending?: boolean, blockStorage?: boolean } = {}) {
  const store = new Map<string, string>()
  const statuses: Array<[string, string, string]> = []
  const buttons: Array<[string, boolean]> = []
  // Every time the page leaves: where to, and what it had saved by then.
  const departures: Array<{ url: string, saved: string[] }> = []
  // Every request the page sent to start a sign-in.
  const posts: Array<{ url: string; body: Record<string, unknown>; method: string }> = []
  const leave = (url: string) => { departures.push({ url, saved: [...store.keys()] }) }
  const fields: Record<string, { value: string }> = {
    'oauth-platform-select': { value: 'twitter' },
    'oauth-bluesky-handle-input': { value: '' },
    'verify-pubkey-input': { value: '' },
  }
  const env: Record<string, unknown> = {
    API,
    window: { location: { origin: API, pathname: '/', search: '', hash: '', assign: leave, set href(url: string) { leave(url) } } },
    localStorage: opts.blockStorage ? blockedStorage() : {
      get length() { return store.size },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (opts.refusePending && k.startsWith(PENDING_PREFIX)) throw new Error('QuotaExceededError')
        store.set(k, v)
      },
      removeItem: (k: string) => { store.delete(k) },
    },
    fetch: async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)), method: String(init.method) })
      return new Response(JSON.stringify({ url: 'https://twitter.com/i/oauth2/authorize?state=s' }), { status: 200 })
    },
    setStatus: (id: string, msg: string, type: string) => { statuses.push([id, msg, type]) },
    clearStatus: () => {},
    setButtonLoading: (id: string, loading: boolean) => { buttons.push([id, loading]) },
    document: { getElementById: (id: string) => fields[id] ?? null },
    activeSigner: { getPublicKey: async () => PUBKEY, signEvent: async () => ({}) },
    activeSignerSource: 'keycast',
    crypto,
    btoa,
  }
  return { env, store, statuses, buttons, departures, posts }
}

// Runs the page's start-up code, from handling a returning sign-in through the
// Divine login checks, with the page functions it calls replaced by recorders.
async function loadStartup() {
  const source = scriptBetween(await pageHtml(), '// Start-up: a returning sign-in is handled first', '// Lookup tool Enter key')
  const pageFunctions = ['updateOAuthInputs', 'updateProofInputs', 'handleOAuthCallbackMessage', 'resumeWaitingSignIn', 'forgetExpiredSignIns', 'updateSignerSummary', 'maybeHandleKeycastCallback', 'applyLoginQueryHint', 'restoreKeycastSession']
  return () => {
    const calls: string[] = []
    const windowListeners: Record<string, (event: { persisted: boolean }) => void> = {}
    const buttons: Array<[string, boolean]> = []
    const cleared: string[] = []
    const env: Record<string, unknown> = {
      window: { addEventListener: (type: string, listener: (event: { persisted: boolean }) => void) => { windowListeners[type] = listener } },
      setButtonLoading: (id: string, loading: boolean) => { buttons.push([id, loading]) },
      clearStatus: (id: string) => { cleared.push(id) },
      ...Object.fromEntries(pageFunctions.map(name => [name, async () => { calls.push(name); return false }])),
    }
    const deps = ['window', 'setButtonLoading', 'clearStatus', ...pageFunctions]
    new Function(...deps, source)(...deps.map(d => env[d]))
    return { calls, windowListeners, buttons, cleared }
  }
}

let returnPage: Awaited<ReturnType<typeof loadReturnHandler>>
beforeAll(async () => { returnPage = await loadReturnHandler() })

// A fresh copy of the page's return code (as if in its own tab) with stand-ins
// for the browser. The address is `search` + `hash`; `pending` is stored under
// the test's sign-in id; `store` is shared localStorage from another tab;
// `env` replaces any of the stand-ins.
function returnHarness(opts: { search: string, hash?: string, pending?: unknown, stored?: Record<string, string>, store?: Map<string, string>, readyState?: 'loading' | 'interactive', env?: Record<string, unknown> }) {
  const store = opts.store ?? new Map<string, string>(Object.entries(opts.stored ?? {}))
  if (opts.pending !== undefined) store.set(PENDING_KEY, JSON.stringify(opts.pending))
  const statuses: Array<[string, string, string]> = []
  // Every request the page sent. A return asks the verifier nothing.
  const fetches: string[] = []
  // Every address the page rewrote itself to.
  const replaced: string[] = []
  // Each signer the page connected again: how, and the address's # part at that moment.
  const activated: Array<{ source: string, hash: string }> = []
  // The proof platform each time the page updated the proof form's labels.
  const labelUpdates: string[] = []
  // Which elements the page scrolled into view, in order, and the sign-in
  // message showing each time it brought that message into view.
  const scrolledTo: string[] = []
  const scrolledWith: string[] = []
  // A stand-in element: a value, optional extras, and event listeners a test can fire.
  type Field = { value: string, textContent?: string, hidden?: boolean, scrollIntoView?: () => void, listeners: Record<string, Array<() => void>>, addEventListener: (type: string, fn: () => void) => void, removeEventListener: (type: string, fn: () => void) => void }
  const field = (extra: Partial<Field> = {}): Field => {
    const listeners: Record<string, Array<() => void>> = {}
    return {
      value: '',
      ...extra,
      listeners,
      addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn) },
      removeEventListener: (type, fn) => { listeners[type] = (listeners[type] ?? []).filter(f => f !== fn) },
    }
  }
  const fields: Record<string, Field> = {
    'proof-platform-select': field(),
    'proof-identity-input': field(),
    'proof-proof-input': field(),
    'publish-status': field(),
    'publish-kind0-btn': field({ scrollIntoView: () => { scrolledTo.push('publish-kind0-btn') } }),
    'verify-global-status': field({ scrollIntoView: () => { scrolledTo.push('verify-global-status'); scrolledWith.push(statuses[statuses.length - 1]?.[1] ?? '') } }),
  }
  const location = { search: opts.search, pathname: '/', hash: opts.hash ?? '#verify-here' }
  // The page's load listeners, so a test can finish loading the page.
  const loadListeners: Array<() => void> = []
  const doc = { readyState: opts.readyState ?? 'complete', getElementById: (id: string) => fields[id] ?? null }
  const finishLoading = () => { doc.readyState = 'complete'; loadListeners.splice(0).forEach(fn => fn()) }
  const replaceState = (_state: unknown, _title: string, url: string) => {
    replaced.push(url)
    const hashAt = url.indexOf('#')
    const queryAt = url.indexOf('?')
    location.search = queryAt > -1 ? url.slice(queryAt, hashAt > -1 ? hashAt : undefined) : ''
    location.hash = hashAt > -1 ? url.slice(hashAt) : ''
  }
  const env: Record<string, unknown> = {
    window: { location, addEventListener: (type: string, fn: () => void) => { if (type === 'load') loadListeners.push(fn) }, history: { replaceState } },
    localStorage: {
      get length() { return store.size },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    },
    fetch: async (url: string) => {
      fetches.push(url)
      return { ok: false, status: 500, json: async () => ({}) }
    },
    setStatus: (id: string, msg: string, type: string) => {
      statuses.push([id, msg, type])
      if (fields[id]) { fields[id].textContent = msg; fields[id].hidden = false }
    },
    clearStatus: (id: string) => { if (fields[id]) fields[id].hidden = true },
    document: doc,
    updateProofInputs: () => { labelUpdates.push(fields['proof-platform-select'].value) },
    // No signer is connected yet on a fresh page load.
    activeSigner: null,
    activateSigner: async (_signer: unknown, source: string) => { activated.push({ source, hash: location.hash }) },
    createBrowserSigner: () => ({}),
    isBrowserSignerAvailable: () => true,
    ...opts.env,
  }
  const page = returnPage(env)
  // Runs a field's listeners, the way the browser would for a person's edit or click.
  const fire = (id: string, type: string) => { [...(fields[id].listeners[type] ?? [])].forEach(fn => fn()) }
  return { env, page, statuses, fetches, fields, store, location, replaced, activated, labelUpdates, scrolledTo, scrolledWith, finishLoading, fire }
}

// A pending sign-in as the page saves it at start.
const startedEntry = (extra: Record<string, unknown> = {}) => ({
  platform: 'twitter', pubkey: PUBKEY, nonce: NONCE, startedAt: Date.now(),
  startSecret: START_SECRET, startCheck: START_CHECK, signer: 'keycast', ...extra,
})
const waitingEntry = (extra: Record<string, unknown> = {}) => JSON.stringify(startedEntry(extra))
// The address the verifier sends the person back to, with the code after the #.
const back = (extra = '') => ({ search: `?signin=${NONCE}&platform=twitter&identity=jack${extra}`, hash: `#oauth_confirm=${CODE}` })
const savedEntry = (h: { store: Map<string, string> }, key = PENDING_KEY) => JSON.parse(h.store.get(key) as string)

describe('sign-in return on the verifier page', () => {
  it('fills the Publish form for a sign-in the page started and says which account signed in', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(h.fetches).toEqual([])
    expect(h.statuses).toEqual([['verify-global-status', SIGNED_IN, 'ok'], ['publish-status', SIGNED_IN, 'ok']])
    expect(h.fields['proof-platform-select'].value).toBe('twitter')
    expect(h.fields['proof-identity-input'].value).toBe('jack')
    expect(h.fields['proof-proof-input'].value).toBe('oauth')
    expect(h.location.search).toBe('')
    expect(h.location.hash).toBe('#verify-here')
  })

  it('does not fill the form when the page did not start a sign-in', async () => {
    const h = returnHarness(back())
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([NOT_STARTED])
    expect(h.fields['proof-identity-input'].value).toBe('')
  })

  it('says it could not confirm a sign-in that came back without a code, and forgets it', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&oauth_verified=true&platform=twitter&identity=jack`, pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([UNCONFIRMED])
    expect(h.store.has(PENDING_KEY)).toBe(false)
    expect(h.fields['proof-identity-input'].value).toBe('')
    expect(h.location.search).toBe('')
  })

  it('does not take the code for a different platform than the one the page started', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry({ platform: 'bluesky' }) })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([NOT_STARTED])
    expect(h.store.has(PENDING_KEY)).toBe(false)
  })

  it('does not take the code for a sign-in started more than 11 minutes ago', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry({ startedAt: Date.now() - 12 * 60 * 1000 }) })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([NOT_STARTED])
    expect([...h.store.values()].join()).not.toContain(CODE)
  })

  // The page starts its clock at the click; the verifier's 10 minutes start a
  // little later and it enforces them itself, so the page allows a minute more.
  it('still takes the code for a sign-in started 10 and a half minutes ago', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry({ startedAt: Date.now() - 10.5 * 60 * 1000 }) })
    await h.page.handleOAuthCallbackMessage()
    expect(savedEntry(h).code).toBe(CODE)
    expect(h.statuses[h.statuses.length - 1][2]).toBe('ok')
  })

  it('still takes the code for a sign-in started 9 minutes ago', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry({ startedAt: Date.now() - 9 * 60 * 1000 }) })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses[h.statuses.length - 1][2]).toBe('ok')
  })

  it('keeps the sign-in, start secret included, waiting for Publish to confirm it', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(savedEntry(h)).toMatchObject({
      platform: 'twitter', pubkey: PUBKEY, nonce: NONCE, startSecret: START_SECRET, startCheck: START_CHECK, signer: 'keycast',
      code: CODE, identity: 'jack',
    })
  })

  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['not lowercase hex', 'N'.repeat(32)],
  ])('ignores a sign-in id that is %s, even if something is stored under it', async (_label, nonce) => {
    const h = returnHarness({
      search: `?signin=${nonce}&platform=twitter&identity=jack`,
      hash: `#oauth_confirm=${CODE}`,
      stored: { [PENDING_PREFIX + nonce]: waitingEntry({ nonce }) },
    })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([NOT_STARTED])
    expect([...h.store.values()].join()).not.toContain(CODE)
  })

  it('only handles sign-in platforms the verifier supports', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&platform=mastodon&identity=jack`, hash: `#oauth_confirm=${CODE}`, pending: startedEntry({ platform: 'mastodon' }) })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([NOT_STARTED])
    expect([...h.store.values()].join()).not.toContain(CODE)
  })

  it('does not take the code when the return names no account', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&platform=twitter&identity=`, hash: `#oauth_confirm=${CODE}`, pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([NOT_STARTED])
    expect(h.store.has(PENDING_KEY)).toBe(false)
  })

  // The verifier sends a reason code next to its wording (#104). The page
  // reads the code, and names the platform only from the sign-in it started.
  const unfinished = (code: string, text = 'any wording') => `oauth_error=${encodeURIComponent(text)}&oauth_error_code=${code}`
  it.each([
    ['cancelled', 'twitter', 'Sign-in was not completed: cancelled or declined at Twitter'],
    ['cancelled', 'bluesky', 'Sign-in was not completed: cancelled or declined at Bluesky'],
    ['provider_error', 'tiktok', 'Sign-in was not completed: could not be completed at TikTok'],
    ['provider_error', 'youtube', 'Sign-in was not completed: could not be completed at YouTube'],
    ['failed', 'twitter', 'Sign-in was not completed: the account could not be verified.'],
    ['update_required', 'twitter', 'Sign-in was not completed.'],
    ['something_new', 'twitter', 'Sign-in was not completed.'],
  ])('shows a known message for oauth_error_code=%s after a %s sign-in started here', async (code, platform, expected) => {
    const h = returnHarness({ search: `?signin=${NONCE}&${unfinished(code)}`, pending: startedEntry({ platform }) })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([['verify-global-status', expected, 'error']])
    expect(h.location.search).toBe('')
  })

  it.each([
    ['cancelled', 'Sign-in was not completed: it was cancelled or declined.'],
    ['provider_error', 'Sign-in was not completed: it could not be completed.'],
    ['failed', 'Sign-in was not completed: the account could not be verified.'],
    ['something_new', 'Sign-in was not completed.'],
  ])('shows a message without a platform for oauth_error_code=%s when no sign-in was started here', async (code, expected) => {
    const h = returnHarness({ search: `?${unfinished(code)}` })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([['verify-global-status', expected, 'error']])
    expect(h.location.search).toBe('')
  })

  it.each([
    'cancelled or declined at Twitter',
    'Verification failed',
    '<b>anything else</b>',
  ])('no longer reads the wording: oauth_error=%s with no code gets the plain message', async (text) => {
    const h = returnHarness({ search: `?signin=${NONCE}&oauth_error=${encodeURIComponent(text)}`, pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([['verify-global-status', 'Sign-in was not completed.', 'error']])
  })

  it('handles a return that carries only a reason code', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&oauth_error_code=cancelled`, pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([['verify-global-status', 'Sign-in was not completed: cancelled or declined at Twitter', 'error']])
    expect(h.store.has(PENDING_KEY)).toBe(false)
    expect(h.location.search).toBe('')
  })

  it('uses up the pending sign-in when the return reports an error', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&oauth_error=${encodeURIComponent('Verification failed')}`, pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(h.store.has(PENDING_KEY)).toBe(false)
  })

  it('reports whether the pending sign-in could be saved', async () => {
    const h = returnHarness({ search: '' })
    expect(h.page.rememberPendingSignIn('bluesky', PUBKEY, NONCE)).toBe(true)
    const full = returnHarness({ search: '' })
    ;(full.env.localStorage as { setItem: () => void }).setItem = () => { throw new Error('QuotaExceededError') }
    expect(full.page.rememberPendingSignIn('bluesky', PUBKEY, NONCE)).toBe(false)
  })

  it('does not leave for the provider when the pending sign-in could not be saved', async () => {
    const load = await loadSignInStart()
    const h = startHarness({ refusePending: true })
    await load(h.env).startOAuthVerification()
    expect(h.departures).toEqual([])
    expect(h.statuses[h.statuses.length - 1]).toEqual(SAVE_REFUSED)
    expect(h.buttons[h.buttons.length - 1]).toEqual(['oauth-start-btn', false])
  })

  it('says why it cannot start a sign-in when the browser blocks storage entirely', async () => {
    const load = await loadSignInStart()
    const h = startHarness({ blockStorage: true })
    await load(h.env).startOAuthVerification()
    expect(h.departures).toEqual([])
    expect(h.statuses[h.statuses.length - 1]).toEqual(SAVE_REFUSED)
  })

  it('tells API callers that the page only reports sign-ins it started', async () => {
    const html = await pageHtml()
    const section = html.slice(html.indexOf('<section id="oauth">'), html.indexOf('</section>', html.indexOf('<section id="oauth">')))
    expect(section).toContain('The verifier page only reports sign-ins it started itself.')
  })

  it('does nothing on an ordinary page load', async () => {
    const h = returnHarness({ search: '' })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([])
    expect(h.replaced).toEqual([])
  })

  it('checks for a returning sign-in when the page loads', async () => {
    const startup = await loadStartup()
    const { calls } = startup()
    expect(calls.filter(name => name === 'handleOAuthCallbackMessage')).toHaveLength(1)
  })

  it('handles a returning sign-in before restoring any signer', async () => {
    const startup = (await loadStartup())()
    await new Promise(resolve => setTimeout(resolve, 0))
    const order = startup.calls
    expect(order.indexOf('handleOAuthCallbackMessage')).toBeGreaterThan(-1)
    expect(order.indexOf('handleOAuthCallbackMessage')).toBeLessThan(order.indexOf('resumeWaitingSignIn'))
    expect(order.indexOf('resumeWaitingSignIn')).toBeLessThan(order.indexOf('restoreKeycastSession'))
    expect(order.indexOf('handleOAuthCallbackMessage')).toBeLessThan(order.indexOf('maybeHandleKeycastCallback'))
  })

  it('clears out expired pending sign-ins when the page loads', async () => {
    const startup = await loadStartup()
    const { calls } = startup()
    expect(calls.filter(name => name === 'forgetExpiredSignIns')).toHaveLength(1)
  })

  it('re-enables the sign-in button when Back restores the page from the cache', async () => {
    const startup = await loadStartup()
    const { windowListeners, buttons, cleared } = startup()
    windowListeners.pageshow({ persisted: false })
    expect(buttons).toEqual([])
    windowListeners.pageshow({ persisted: true })
    expect(buttons).toEqual([['oauth-start-btn', false]])
    expect(cleared).toEqual(['oauth-status'])
  })

  it('remembers the platform and account when a sign-in starts', async () => {
    const h = returnHarness({ search: '' })
    h.page.rememberPendingSignIn('bluesky', PUBKEY, NONCE)
    const saved = savedEntry(h)
    expect(saved).toMatchObject({ platform: 'bluesky', pubkey: PUBKEY, nonce: NONCE })
    expect(typeof saved.startedAt).toBe('number')
  })

  it('saves the pending sign-in before leaving for the provider', async () => {
    const h = startHarness()
    await (await loadSignInStart())(h.env).startOAuthVerification()
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0].url).toBe(`${API}/auth/twitter/start`)
    expect(h.posts[0].body.pubkey).toBe(PUBKEY)
    // The same sign-in id goes into the return address the provider sends the person back to.
    const returnUrl = new URL(String(h.posts[0].body.return_url))
    expect(returnUrl.origin + returnUrl.pathname + returnUrl.hash).toBe(`${API}/#verify-here`)
    const code = returnUrl.searchParams.get('signin') as string
    expect(code).toMatch(/^[0-9a-f]{32}$/)
    expect(h.departures).toHaveLength(1)
    expect(h.departures[0].saved).toContain(PENDING_PREFIX + code)
    expect(JSON.parse(h.store.get(PENDING_PREFIX + code) as string)).toMatchObject({ platform: 'twitter', pubkey: PUBKEY, nonce: code })
  })

  it('takes the code for a sign-in it started once the provider sends the person back', async () => {
    const start = await loadSignInStart()
    const startTab = startHarness()
    await start(startTab.env).startOAuthVerification()
    const startedWith = new URL(String(startTab.posts[0].body.return_url))
    const nonce = startedWith.searchParams.get('signin') as string
    // The verifier's callback adds the result to the return address, and the code after the #.
    const h = returnHarness({ search: `${startedWith.search}&platform=twitter&identity=jack`, hash: `#oauth_confirm=${CODE}`, store: startTab.store })
    await h.page.handleOAuthCallbackMessage()
    expect(h.fetches).toEqual([])
    expect(h.statuses[h.statuses.length - 1][2]).toBe('ok')
    expect(h.fields['proof-identity-input'].value).toBe('jack')
    const saved = savedEntry(h, PENDING_PREFIX + nonce)
    expect(saved).toMatchObject({ code: CODE, identity: 'jack', startCheck: startTab.posts[0].body.start_check })
  })

  it('makes a fresh 32-character sign-in id for each sign-in', async () => {
    const h = returnHarness({ search: '' })
    const codes = Array.from({ length: 50 }, () => h.page.newSignInNonce())
    for (const code of codes) expect(code).toMatch(/^[0-9a-f]{32}$/)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it.each([
    ['missing', ''],
    // Well formed, so it gets past the format check and is looked up.
    ['different', 'f'.repeat(32)],
  ])('does not take the code when the sign-in id in the return address is %s', async (_label, nonce) => {
    const h = returnHarness({ search: `?signin=${nonce}&platform=twitter&identity=jack`, hash: `#oauth_confirm=${CODE}`, pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([NOT_STARTED])
    expect(h.fields['proof-identity-input'].value).toBe('')
    expect([...h.store.values()].join()).not.toContain(CODE)
  })

  it('keeps the account the sign-in started with, not one named in the return address', async () => {
    const h = returnHarness({ ...back(`&pubkey=${'cd'.repeat(32)}`), pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(savedEntry(h).pubkey).toBe(PUBKEY)
  })

  it('updates the Publish form labels for the platform it fills in', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(h.labelUpdates).toEqual(['twitter'])
  })

  it.each([
    ['account', { pubkey: 42 }],
    ['start time', { startedAt: 'now' }],
    ['sign-in id', { nonce: 7 }],
    ['platform', { platform: 42 }],
  ])('ignores a pending sign-in with a malformed %s', async (_label, broken) => {
    const h = returnHarness({ ...back(), pending: startedEntry(broken) })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([NOT_STARTED])
    expect([...h.store.values()].join()).not.toContain(CODE)
  })

  it('finds a sign-in started in another tab of the same browser', async () => {
    // Each tab runs its own copy of the page script; only localStorage is shared.
    const startTab = returnHarness({ search: '' })
    expect(startTab.page.rememberPendingSignIn('twitter', PUBKEY, NONCE, { startSecret: START_SECRET, startCheck: START_CHECK, signer: 'keycast' })).toBe(true)
    const returnTab = returnHarness({ ...back(), store: startTab.store })
    await returnTab.page.handleOAuthCallbackMessage()
    expect(returnTab.statuses[returnTab.statuses.length - 1][2]).toBe('ok')
    expect(savedEntry(startTab).code).toBe(CODE)
  })

  it('uses only the sign-in whose id came back', async () => {
    // Well formed, so the page could read it, but it must leave it alone.
    const otherKey = PENDING_PREFIX + 'd'.repeat(32)
    const other = waitingEntry({ nonce: 'd'.repeat(32) })
    const h = returnHarness({ ...back(), pending: startedEntry(), stored: { [otherKey]: other } })
    await h.page.handleOAuthCallbackMessage()
    expect(savedEntry(h).code).toBe(CODE)
    expect(h.store.get(otherKey)).toBe(other)
  })

  it('clears out expired pending sign-ins when a new one starts', async () => {
    const expiredKey = PENDING_PREFIX + 'e'.repeat(32)
    const freshKey = PENDING_PREFIX + 'f'.repeat(32)
    const h = returnHarness({
      search: '',
      stored: {
        [expiredKey]: waitingEntry({ startedAt: Date.now() - 12 * 60 * 1000 }),
        [freshKey]: waitingEntry(),
        [PENDING_PREFIX + 'b'.repeat(32)]: 'not json',
        [PENDING_PREFIX + 'c'.repeat(32)]: waitingEntry({ startedAt: 'now' }),
        'some_other_setting': 'kept',
      },
    })
    h.page.rememberPendingSignIn('bluesky', PUBKEY, NONCE)
    expect(h.store.has(expiredKey)).toBe(false)
    expect(h.store.has(PENDING_PREFIX + 'b'.repeat(32))).toBe(false)
    expect(h.store.has(PENDING_PREFIX + 'c'.repeat(32))).toBe(false)
    expect(h.store.has(freshKey)).toBe(true)
    expect(h.store.get('some_other_setting')).toBe('kept')
    expect(h.store.has(PENDING_KEY)).toBe(true)
  })

  it('removes the one-time code from the address after handling the return', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(h.location.search).toBe('')
    expect(h.location.hash).toBe('#verify-here')
  })

  it('keeps other parameters and the section anchor when it cleans the address', async () => {
    const h = returnHarness({ ...back('&ref=home'), pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(h.replaced).toEqual(['/?ref=home#verify-here'])
  })
})

describe('coming back from a sign-in', () => {
  it('removes the code from the address before doing anything that waits', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&platform=twitter&identity=example`, hash: '#oauth_confirm=' + CODE })
    h.store.set(PENDING_KEY, waitingEntry({ signer: 'browser' }))
    const running = h.page.handleOAuthCallbackMessage()
    // Synchronously, before the handler's first await:
    expect(h.replaced).toEqual(['/#verify-here'])
    await running
    // The signer reconnects only after the code has left the address.
    expect(h.activated).toEqual([{ source: 'browser', hash: '#verify-here' }])
  })

  it('keeps the code, removes it from the address, and names the account', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&platform=twitter&identity=example`, hash: '#oauth_confirm=' + CODE })
    h.store.set(PENDING_KEY, waitingEntry())
    await h.page.handleOAuthCallbackMessage()
    const saved = JSON.parse(h.store.get(PENDING_KEY) as string)
    expect(saved.code).toBe(CODE)
    expect(saved.identity).toBe('example')
    expect(typeof saved.finishedAt).toBe('number')
    expect(h.fields['proof-identity-input'].value).toBe('example')
    expect(h.statuses.some(([, msg]) => msg === 'Signed in to Twitter as example. Publish to link it to your Divine account.')).toBe(true)
    expect(h.fetches).toHaveLength(0)
  })

  it('takes the code from the query when the verifier puts it there', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&platform=twitter&identity=example&oauth_confirm=${CODE}`, hash: '#verify-here' })
    h.store.set(PENDING_KEY, waitingEntry())
    await h.page.handleOAuthCallbackMessage()
    expect(JSON.parse(h.store.get(PENDING_KEY) as string).code).toBe(CODE)
    expect(h.replaced[h.replaced.length - 1]).toBe('/#verify-here')
  })

  it('takes the code from the query over one after the #', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&platform=twitter&identity=example&oauth_confirm=${CODE}`, hash: '#oauth_confirm=' + 'D'.repeat(43) })
    h.store.set(PENDING_KEY, waitingEntry())
    await h.page.handleOAuthCallbackMessage()
    expect(JSON.parse(h.store.get(PENDING_KEY) as string).code).toBe(CODE)
    expect(h.replaced).toEqual(['/#verify-here'])
  })

  it('puts the section anchor back when the code came in the query with no fragment', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&platform=twitter&identity=example&oauth_confirm=${CODE}`, hash: '' })
    h.store.set(PENDING_KEY, waitingEntry())
    await h.page.handleOAuthCallbackMessage()
    expect(h.replaced).toEqual(['/#verify-here'])
  })

  it('removes a fragment that carries the code\'s name percent-encoded', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&platform=twitter&identity=example`, hash: '#oauth%5Fconfirm=' + CODE })
    h.store.set(PENDING_KEY, waitingEntry())
    await h.page.handleOAuthCallbackMessage()
    expect(h.replaced).toEqual(['/#verify-here'])
  })

  it('keeps the fragment of a return that carries no code, even one mentioning the code\'s name', async () => {
    const h = returnHarness({ search: `?oauth_error=${encodeURIComponent('Verification failed')}`, hash: '#not-oauth_confirm' })
    await h.page.handleOAuthCallbackMessage()
    expect(h.replaced).toEqual(['/#not-oauth_confirm'])
  })

  it('handles a return that carries only the code (no oauth_verified, as once confirmation is required)', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&platform=twitter&identity=example`, hash: '#oauth_confirm=' + CODE })
    h.store.set(PENDING_KEY, waitingEntry())
    await h.page.handleOAuthCallbackMessage()
    expect(JSON.parse(h.store.get(PENDING_KEY) as string).code).toBe(CODE)
  })

  it('drops a code this page did not start, and warns', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&platform=twitter&identity=example`, hash: '#oauth_confirm=' + CODE })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses[h.statuses.length - 1]).toEqual(['verify-global-status', NOT_STARTED_HERE, 'error'])
    expect([...h.store.values()].join()).not.toContain(CODE)
  })

  it('drops a code whose platform or Bluesky handle is not what this page started', async () => {
    const wrongPlatform = returnHarness({ search: `?signin=${NONCE}&platform=youtube&identity=example`, hash: '#oauth_confirm=' + CODE })
    wrongPlatform.store.set(PENDING_KEY, waitingEntry())
    await wrongPlatform.page.handleOAuthCallbackMessage()
    expect(wrongPlatform.statuses[wrongPlatform.statuses.length - 1]?.[1]).toBe(NOT_STARTED_HERE)

    const wrongHandle = returnHarness({ search: `?signin=${NONCE}&platform=bluesky&identity=mallory.bsky.social`, hash: '#oauth_confirm=' + CODE })
    wrongHandle.store.set(PENDING_KEY, waitingEntry({ platform: 'bluesky', handle: 'alice.bsky.social' }))
    await wrongHandle.page.handleOAuthCallbackMessage()
    expect(wrongHandle.statuses[wrongHandle.statuses.length - 1]?.[1]).toBe(NOT_STARTED_HERE)
  })

  it('picks up a waiting sign-in after a reload (a login.divine.video round trip), refilling the form', async () => {
    const h = returnHarness({ search: '', hash: '#verify-here' })
    h.store.set(PENDING_KEY, waitingEntry({ code: CODE, identity: 'example', finishedAt: Date.now() }))
    await h.page.resumeWaitingSignIn()
    expect(h.fields['proof-platform-select'].value).toBe('twitter')
    expect(h.fields['proof-identity-input'].value).toBe('example')
    expect(h.statuses.some(([, msg]) => msg === 'Signed in to Twitter as example. Publish to link it to your Divine account.')).toBe(true)
  })

  it('does not overwrite a form the person has started filling in', async () => {
    const h = returnHarness({ search: '', hash: '' })
    h.fields['proof-identity-input'].value = 'something-else'
    h.store.set(PENDING_KEY, waitingEntry({ code: CODE, identity: 'example', finishedAt: Date.now() }))
    await h.page.resumeWaitingSignIn()
    expect(h.fields['proof-identity-input'].value).toBe('something-else')
  })

  it('does nothing on a reload when no sign-in is waiting', async () => {
    const h = returnHarness({ search: '', hash: '' })
    await h.page.resumeWaitingSignIn()
    expect(h.statuses).toHaveLength(0)
  })

  it('does not pick up a sign-in that came back more than 11 minutes ago', async () => {
    const h = returnHarness({ search: '', hash: '#verify-here' })
    h.store.set(PENDING_KEY, waitingEntry({ code: CODE, identity: 'example', startedAt: Date.now() - 13 * 60 * 1000, finishedAt: Date.now() - 12 * 60 * 1000 }))
    await h.page.resumeWaitingSignIn()
    expect(h.statuses).toEqual([])
    expect(h.fields['proof-identity-input'].value).toBe('')
  })

  // The verifier keeps a returned code for 10 minutes from the return, not from the start.
  it('still picks up a sign-in started 15 minutes ago that came back 2 minutes ago', async () => {
    const h = returnHarness({ search: '', hash: '#verify-here' })
    h.store.set(PENDING_KEY, waitingEntry({ code: CODE, identity: 'example', startedAt: Date.now() - 15 * 60 * 1000, finishedAt: Date.now() - 2 * 60 * 1000 }))
    await h.page.resumeWaitingSignIn()
    expect(h.fields['proof-identity-input'].value).toBe('example')
  })

  it('drops a sign-in that comes back a second time with a different code', async () => {
    const earlier = 'D'.repeat(43)
    const h = returnHarness({ ...back(), pending: startedEntry({ code: earlier, identity: 'jack', finishedAt: Date.now() }) })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([NOT_STARTED])
    expect(h.store.has(PENDING_KEY)).toBe(false)
    expect(h.fields['proof-identity-input'].value).toBe('')
  })

  it('drops a sign-in whose code comes back again naming a different account', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry({ code: CODE, identity: 'someone-else', finishedAt: Date.now() }) })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([NOT_STARTED])
    expect(h.store.has(PENDING_KEY)).toBe(false)
  })

  it('treats the same return again (a reload before the address was cleaned) as the same sign-in', async () => {
    const finishedAt = Date.now() - 60 * 1000
    const h = returnHarness({ ...back(), pending: startedEntry({ code: CODE, identity: 'jack', finishedAt }) })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([['verify-global-status', SIGNED_IN, 'ok'], ['publish-status', SIGNED_IN, 'ok']])
    // Its 11 minutes still count from the first return.
    expect(savedEntry(h)).toMatchObject({ code: CODE, identity: 'jack', finishedAt })
  })

  it('accepts a Bluesky handle that comes back in different capitals', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&platform=bluesky&identity=Alice.Bsky.Social`, hash: `#oauth_confirm=${CODE}`, pending: startedEntry({ platform: 'bluesky', handle: 'alice.bsky.social' }) })
    await h.page.handleOAuthCallbackMessage()
    expect(savedEntry(h).code).toBe(CODE)
  })

  it.each([
    ['too short', 'C'.repeat(42)],
    ['too long', 'C'.repeat(44)],
    ['not base64url', 'C'.repeat(42) + '+'],
    ['padded', 'C'.repeat(42) + '='],
  ])('drops a code that is %s, storing nothing', async (_label, code) => {
    const h = returnHarness({ search: `?signin=${NONCE}&platform=twitter&identity=jack`, hash: `#oauth_confirm=${encodeURIComponent(code)}`, pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([NOT_STARTED])
    expect(h.store.has(PENDING_KEY)).toBe(false)
    expect(h.replaced).toEqual(['/#verify-here'])
  })

  it('says which account signed in while the extension is still asking to connect', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry({ signer: 'browser' }), env: { activateSigner: () => new Promise(() => {}) } })
    void h.page.handleOAuthCallbackMessage()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.statuses).toEqual([['verify-global-status', SIGNED_IN, 'ok'], ['publish-status', SIGNED_IN, 'ok']])
    expect(h.fields['proof-identity-input'].value).toBe('jack')
  })

  it('says which account signed in after a reload while the extension is still asking to connect', async () => {
    const h = returnHarness({ search: '', hash: '#verify-here', env: { activateSigner: () => new Promise(() => {}) } })
    h.store.set(PENDING_KEY, waitingEntry({ signer: 'browser', code: CODE, identity: 'example', finishedAt: Date.now() }))
    void h.page.resumeWaitingSignIn()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.fields['proof-identity-input'].value).toBe('example')
  })

  it('does not pick up an older waiting sign-in on the load that brought a sign-in back', async () => {
    // Well formed, so the page can read it.
    const older = 'd'.repeat(32)
    const h = returnHarness({ ...back(), stored: { [PENDING_PREFIX + older]: waitingEntry({ nonce: older, code: 'D'.repeat(43), identity: 'example', finishedAt: Date.now() }) } })
    await h.page.handleOAuthCallbackMessage()
    await h.page.resumeWaitingSignIn()
    expect(h.statuses).toEqual([NOT_STARTED])
    expect(h.fields['proof-identity-input'].value).toBe('')
  })

  it.each(['browser', 'embedded'])('connects the %s signer the sign-in started with again', async (signer) => {
    const h = returnHarness({ ...back(), pending: startedEntry({ signer }) })
    await h.page.handleOAuthCallbackMessage()
    expect(h.activated.map(a => a.source)).toEqual([signer])
  })

  it.each(['keycast', 'bunker', 'nostrconnect'])('leaves a %s signer to reconnect its own way', async (signer) => {
    const h = returnHarness({ ...back(), pending: startedEntry({ signer }) })
    await h.page.handleOAuthCallbackMessage()
    expect(h.activated).toEqual([])
    expect(h.statuses[h.statuses.length - 1]).toEqual(['publish-status', SIGNED_IN, 'ok'])
  })

  it('does not connect a signer again when one is already connected', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry({ signer: 'browser' }), env: { activeSigner: {} } })
    await h.page.handleOAuthCallbackMessage()
    expect(h.activated).toEqual([])
  })

  it('does not connect the extension again when it is no longer there', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry({ signer: 'browser' }), env: { isBrowserSignerAvailable: () => false } })
    await h.page.handleOAuthCallbackMessage()
    expect(h.activated).toEqual([])
  })

  it('still says which account signed in when the extension refuses to connect', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry({ signer: 'browser' }), env: { activateSigner: async () => { throw new Error('User rejected') } } })
    await h.page.handleOAuthCallbackMessage()
    expect(h.statuses[h.statuses.length - 1]).toEqual(['publish-status', SIGNED_IN, 'ok'])
    expect(h.fields['proof-identity-input'].value).toBe('jack')
  })
})

describe('starting a sign-in from the page', () => {
  it('hashes a sign-in the way the verifier and the app do (shared test vector)', async () => {
    const start = (await loadSignInStart())(startHarness().env)
    const check = await start.startCheckFor('S'.repeat(43))
    expect(check).toBe('G2CN_J8Es1JmsWz0QXd2Kc-4p-lCo8GCsR-tVw6vre4')
    expect(await start.confirmBindingFor('C'.repeat(43), check)).toBe('y_rdmZDwlKYUcthysDgPyoiPWBwzgSafjaPHJ4JE1ZY')
  })

  it('posts the start with a start check, keeps the secret, and opens the provider page', async () => {
    const h = startHarness()
    await (await loadSignInStart())(h.env).startOAuthVerification()
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]).toMatchObject({ url: `${API}/auth/twitter/start`, method: 'POST' })
    const body = h.posts[0].body
    expect(body.pubkey).toBe(PUBKEY)
    expect(String(body.return_url)).toMatch(new RegExp(`^${API}/\\?signin=[0-9a-f]{32}#verify-here$`))
    expect(String(body.start_check)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const saved = JSON.parse([...h.store.values()][0])
    expect(saved.startSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(saved.startCheck).toBe(body.start_check)
    expect(saved.signer).toBe('keycast')
    expect(h.departures.map(d => d.url)).toEqual(['https://twitter.com/i/oauth2/authorize?state=s'])
    // The secret stays in this browser: only its hash goes to the verifier.
    expect(Object.keys(body).sort()).toEqual(['pubkey', 'return_url', 'start_check'])
    expect(JSON.stringify(h.posts)).not.toContain(saved.startSecret)
    expect(JSON.stringify(h.departures)).not.toContain(saved.startSecret)
  })

  it('sends and remembers the Bluesky handle the person entered', async () => {
    const h = startHarness()
    const fields = { 'oauth-platform-select': { value: 'bluesky' }, 'oauth-bluesky-handle-input': { value: ' @Example.BSKY.social ' } }
    h.env.document = { getElementById: (id: string) => (fields as Record<string, { value: string }>)[id] ?? { value: '' } }
    await (await loadSignInStart())(h.env).startOAuthVerification()
    expect(h.posts[0].url).toBe(`${API}/auth/bluesky/start`)
    expect(h.posts[0].body.handle).toBe('example.bsky.social')
    expect(Object.keys(h.posts[0].body).sort()).toEqual(['handle', 'pubkey', 'return_url', 'start_check'])
    expect(JSON.parse([...h.store.values()][0])).toMatchObject({ platform: 'bluesky', handle: 'example.bsky.social' })
  })

  it('returns to the verifier host it started on', async () => {
    const h = startHarness()
    ;(h.env.window as { location: { origin: string } }).location.origin = 'https://verifyer.divine.video'
    await (await loadSignInStart())(h.env).startOAuthVerification()
    expect(String(h.posts[0].body.return_url)).toMatch(/^https:\/\/verifyer\.divine\.video\/\?signin=/)
  })

  it('does not start without a connected signer', async () => {
    const h = startHarness()
    h.env.activeSigner = null
    await (await loadSignInStart())(h.env).startOAuthVerification()
    expect(h.posts).toHaveLength(0)
    expect(h.store.size).toBe(0)
    expect(h.statuses[h.statuses.length - 1]).toEqual(['oauth-status', 'Sign in first (Verify Here, Step 1). You confirm the link with your Divine login or Nostr signer when you come back.', 'error'])
  })

  it('does not start with a signer that cannot sign', async () => {
    const h = startHarness()
    h.env.activeSigner = { getPublicKey: async () => PUBKEY }
    await (await loadSignInStart())(h.env).startOAuthVerification()
    expect(h.posts).toHaveLength(0)
    expect(h.store.size).toBe(0)
    expect(h.statuses[h.statuses.length - 1]).toEqual(['oauth-status', 'Sign in first (Verify Here, Step 1). You confirm the link with your Divine login or Nostr signer when you come back.', 'error'])
  })

  it.each([
    ['an npub', 'npub1' + 'q'.repeat(58)],
    ['too short', 'ab'.repeat(31)],
    ['not hex', 'zz'.repeat(32)],
  ])('does not start when the signer gives a key that is %s', async (_label, key) => {
    const h = startHarness()
    h.env.activeSigner = { getPublicKey: async () => key, signEvent: async () => ({}) }
    await (await loadSignInStart())(h.env).startOAuthVerification()
    expect(h.posts).toHaveLength(0)
    expect(h.store.size).toBe(0)
    expect(h.statuses[h.statuses.length - 1]).toEqual(['oauth-status', 'Signer returned an invalid pubkey.', 'error'])
  })

  it('starts with the key in lowercase when the signer gives it in capitals', async () => {
    const h = startHarness()
    h.env.activeSigner = { getPublicKey: async () => PUBKEY.toUpperCase(), signEvent: async () => ({}) }
    await (await loadSignInStart())(h.env).startOAuthVerification()
    expect(h.posts[0].body.pubkey).toBe(PUBKEY)
  })

  it.each([
    ['javascript:alert(1)'],
    ['http://twitter.com/x'],
    ['/relative'],
  ])('does not open a provider address that is not https: %s', async (url) => {
    const h = startHarness()
    h.env.fetch = async () => new Response(JSON.stringify({ url }), { status: 200 })
    await (await loadSignInStart())(h.env).startOAuthVerification()
    expect(h.departures).toHaveLength(0)
    expect(h.statuses[h.statuses.length - 1]).toEqual(['oauth-status', 'Could not start sign-in.', 'error'])
  })

  it('forgets the pending sign-in, secret included, when the start fails', async () => {
    const h = startHarness()
    h.env.fetch = async () => new Response(JSON.stringify({ error: 'Too many requests. Try again shortly.' }), { status: 429 })
    await (await loadSignInStart())(h.env).startOAuthVerification()
    expect(h.departures).toHaveLength(0)
    expect([...h.store.keys()].filter(k => k.startsWith(PENDING_PREFIX))).toEqual([])
    expect(h.statuses[h.statuses.length - 1]).toEqual(['oauth-status', 'Too many requests. Try again shortly.', 'error'])
  })

  it('says it could not start the sign-in when the verifier cannot be reached', async () => {
    const h = startHarness()
    h.env.fetch = async () => { throw new TypeError('Failed to fetch') }
    await (await loadSignInStart())(h.env).startOAuthVerification()
    expect(h.departures).toHaveLength(0)
    expect(h.store.size).toBe(0)
    expect(h.statuses[h.statuses.length - 1]).toEqual(['oauth-status', 'Could not start sign-in.', 'error'])
    expect(h.buttons[h.buttons.length - 1]).toEqual(['oauth-start-btn', false])
  })

  it('no longer remembers the account box between visits', async () => {
    const h = startHarness()
    ;(await loadSignInStart())(h.env).setAccountInputValue(PUBKEY)
    expect([...h.store.keys()]).not.toContain('verifyer_account_input')
  })

  it('still fills the account box from the app\'s ?pubkey= address', async () => {
    const html = await pageHtml()
    const source = scriptBetween(html, 'function extractHexFromText(text)', 'async function connectBrowserSigner()')
    const accountBox = { value: '' }
    const env: Record<string, unknown> = {
      window: { location: { search: `?pubkey=${PUBKEY}`, pathname: '/', hash: '' }, history: { replaceState: () => {} } },
      document: { getElementById: (id: string) => (id === 'verify-pubkey-input' ? accountBox : null) },
      setStatus: () => {},
      updateSignerSummary: () => {},
      npubToHex: () => { throw new Error('not an npub') },
    }
    const deps = Object.keys(env)
    const page = new Function(...deps, `let signerPubkeyHex = null; let activeSignerSource = null;\n${source}\nreturn { applyLoginQueryHint, signer: () => signerPubkeyHex };`)(...deps.map(d => env[d]))
    page.applyLoginQueryHint()
    expect(accountBox.value).toBe(PUBKEY)
    expect(page.signer()).toBe(PUBKEY)
  })
})

// Runs the page's real getActivePubkey with a stand-in account box, the
// signed-in key, and a fetch that records any lookup.
async function loadActivePubkey(box: string, signedIn: string | null) {
  const source = scriptBetween(await pageHtml(), 'async function getActivePubkey()', 'function setButtonLoading(buttonId, isLoading, loadingText)')
  const fetched: string[] = []
  const env: Record<string, unknown> = {
    document: { getElementById: (id: string) => (id === 'verify-pubkey-input' ? { value: box } : null) },
    fetch: async (url: string) => { fetched.push(url); throw new Error('no lookups') },
  }
  const deps = Object.keys(env)
  const page = new Function(...deps, `let signerPubkeyHex = ${JSON.stringify(signedIn)};\n${source}\nreturn { getActivePubkey };`)(...deps.map(d => env[d]))
  return { getActivePubkey: page.getActivePubkey as () => Promise<string>, fetched }
}

describe('the account the page acts for', () => {
  it('is the key in the account box, when it matches the signed-in key', async () => {
    const page = await loadActivePubkey(PUBKEY, PUBKEY)
    await expect(page.getActivePubkey()).resolves.toBe(PUBKEY)
  })

  it('is the key from the app\'s ?pubkey= address, with no signer yet', async () => {
    const page = await loadActivePubkey(PUBKEY, null)
    await expect(page.getActivePubkey()).resolves.toBe(PUBKEY)
  })

  it.each([
    ['an npub', 'npub1' + 'q'.repeat(58)],
    ['a Divine address', 'example@divine.video'],
    ['a profile link around a key', `https://example.com/p/${'cd'.repeat(32)}`],
    ['a key in capitals', 'CD'.repeat(32)],
  ])('is the signed-in key when the box holds %s', async (_label, box) => {
    const page = await loadActivePubkey(box, PUBKEY)
    await expect(page.getActivePubkey()).resolves.toBe(PUBKEY)
    expect(page.fetched).toEqual([])
  })

  it('asks the person to sign in when the box holds something other than a key and nobody is signed in', async () => {
    const page = await loadActivePubkey('example@divine.video', null)
    await expect(page.getActivePubkey()).rejects.toThrow('Sign in first (Verify Here, Step 1).')
    expect(page.fetched).toEqual([])
  })

  it('refuses a box key that is not the signed-in key', async () => {
    const page = await loadActivePubkey('cd'.repeat(32), PUBKEY)
    await expect(page.getActivePubkey()).rejects.toThrow('The account in Step 1 does not match the account you signed in with.')
  })
})

describe('landing after a returning sign-in', () => {
  it('lands on Publish after a successful sign-in, with a note right above it', async () => {
    const h = returnHarness({ ...back(), pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    // The top message and the note beside Publish both say which account signed in.
    expect(h.statuses.slice(-2)).toEqual([['verify-global-status', SIGNED_IN, 'ok'], ['publish-status', SIGNED_IN, 'ok']])
    expect(h.scrolledTo).toEqual(['publish-kind0-btn'])
  })

  it('brings the message into view when it cannot confirm the sign-in', async () => {
    const h = returnHarness({ search: `?signin=${NONCE}&oauth_verified=true&platform=twitter&identity=jack`, pending: startedEntry() })
    await h.page.handleOAuthCallbackMessage()
    expect(h.scrolledWith).toEqual([UNCONFIRMED[1]])
  })

  it('brings the message into view when the page did not start the sign-in', async () => {
    const h = returnHarness(back())
    await h.page.handleOAuthCallbackMessage()
    expect(h.scrolledWith).toEqual([NOT_STARTED_HERE])
  })

  // 'interactive' means the page's content is ready but its fonts and images
  // are still loading, so the browser hasn't made its own jump yet either.
  it.each(['loading', 'interactive'] as const)('waits for the page to finish loading (now %s) before bringing the message into view', async (readyState) => {
    vi.useFakeTimers()
    try {
      // A cancelled sign-in is answered straight away, before the page has finished loading.
      const h = returnHarness({ search: `?signin=${NONCE}&oauth_error=${encodeURIComponent('cancelled or declined at Twitter')}&oauth_error_code=cancelled`, pending: startedEntry(), readyState })
      await h.page.handleOAuthCallbackMessage()
      expect(h.statuses).toEqual([['verify-global-status', 'Sign-in was not completed: cancelled or declined at Twitter', 'error']])
      expect(h.scrolledTo).toEqual([])
      h.finishLoading()
      // One more turn after load, so the browser's own jump comes first.
      expect(h.scrolledTo).toEqual([])
      await vi.advanceTimersByTimeAsync(0)
      expect(h.scrolledTo).toEqual(['verify-global-status'])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['loading', 'interactive'] as const)('waits for the page to finish loading (now %s) before landing on Publish', async (readyState) => {
    vi.useFakeTimers()
    try {
      const h = returnHarness({ ...back(), pending: startedEntry(), readyState })
      await h.page.handleOAuthCallbackMessage()
      expect(h.scrolledTo).toEqual([])
      h.finishLoading()
      expect(h.scrolledTo).toEqual([])
      await vi.advanceTimersByTimeAsync(0)
      expect(h.scrolledTo).toEqual(['publish-kind0-btn'])
    } finally {
      vi.useRealTimers()
    }
  })

  describe('the note beside Publish', () => {
    async function signedIn() {
      const h = returnHarness({ ...back(), pending: startedEntry() })
      await h.page.handleOAuthCallbackMessage()
      expect(h.fields['publish-status']).toMatchObject({ textContent: SIGNED_IN, hidden: false })
      return h
    }
    const setStatus = (h: { env: Record<string, unknown> }) => h.env.setStatus as (id: string, msg: string, type: string) => void

    it.each([
      ['platform', 'proof-platform-select', 'github', 'change'],
      ['account name', 'proof-identity-input', 'someone-else', 'input'],
      ['proof', 'proof-proof-input', 'https://bsky.app/profile/jack/post/abc', 'input'],
    ])('goes away once the %s no longer matches what was filled in', async (_label, id, value, event) => {
      const h = await signedIn()
      h.fields[id].value = value
      h.fire(id, event)
      expect(h.fields['publish-status'].hidden).toBe(true)
    })

    it('stays when an edit event leaves the form unchanged, such as typing the same letter over a selected one', async () => {
      const h = await signedIn()
      h.fields['proof-identity-input'].value = 'jack'
      h.fire('proof-identity-input', 'input')
      expect(h.fields['publish-status'].hidden).toBe(false)
    })

    it('goes away when Publish is clicked', async () => {
      const h = await signedIn()
      h.fire('publish-kind0-btn', 'click')
      expect(h.fields['publish-status'].hidden).toBe(true)
    })

    it('leaves a newer message in that spot alone, such as Publish reporting progress', async () => {
      const h = await signedIn()
      setStatus(h)('publish-status', 'Checking signer and profile...', 'loading')
      h.fields['proof-identity-input'].value = 'someone-else'
      h.fire('proof-identity-input', 'input')
      h.fire('publish-kind0-btn', 'click')
      expect(h.fields['publish-status']).toMatchObject({ textContent: 'Checking signer and profile...', hidden: false })
    })

    it('stops watching once it has gone', async () => {
      const h = await signedIn()
      h.fire('publish-kind0-btn', 'click')
      for (const id of ['proof-identity-input', 'proof-proof-input', 'publish-kind0-btn']) {
        expect(Object.values(h.fields[id].listeners).flat()).toEqual([])
      }
      // What stays is the one watch on the platform picker for clearing the
      // sign-in's account and "oauth" (below), which outlives the note.
      expect(h.fields['proof-platform-select'].listeners.change).toHaveLength(1)
      expect(h.fields['proof-platform-select'].listeners.input ?? []).toEqual([])
    })
  })

  // A sign-in fills the post form (platform, account, proof "oauth") so
  // Publish works. Those belong to the signed-in platform only: once another
  // platform is picked they would publish a claim that can't be checked.
  describe('what the sign-in filled in', () => {
    async function signedIn() {
      const h = returnHarness({ ...back(), pending: startedEntry() })
      await h.page.handleOAuthCallbackMessage()
      expect([h.fields['proof-platform-select'].value, h.fields['proof-identity-input'].value, h.fields['proof-proof-input'].value]).toEqual(['twitter', 'jack', 'oauth'])
      return h
    }
    const pick = (h: Awaited<ReturnType<typeof signedIn>>, platform: string) => {
      h.fields['proof-platform-select'].value = platform
      h.fire('proof-platform-select', 'change')
    }

    it('is cleared when another platform is picked', async () => {
      const h = await signedIn()
      pick(h, 'github')
      expect(h.fields['proof-identity-input'].value).toBe('')
      expect(h.fields['proof-proof-input'].value).toBe('')
    })

    it('is cleared even after Publish was pressed for the sign-in', async () => {
      const h = await signedIn()
      h.fire('publish-kind0-btn', 'click')
      pick(h, 'github')
      expect(h.fields['proof-identity-input'].value).toBe('')
      expect(h.fields['proof-proof-input'].value).toBe('')
    })

    it('keeps an account the person typed, and clears only the sign-in\'s "oauth"', async () => {
      const h = await signedIn()
      h.fields['proof-identity-input'].value = 'octocat'
      pick(h, 'github')
      expect(h.fields['proof-identity-input'].value).toBe('octocat')
      expect(h.fields['proof-proof-input'].value).toBe('')
    })

    it('keeps a post link the person pasted, and clears only the sign-in\'s account', async () => {
      const h = await signedIn()
      h.fields['proof-proof-input'].value = 'https://gist.github.com/octocat/abc123'
      pick(h, 'github')
      expect(h.fields['proof-identity-input'].value).toBe('')
      expect(h.fields['proof-proof-input'].value).toBe('https://gist.github.com/octocat/abc123')
    })

    it('stays while the signed-in platform is still picked', async () => {
      const h = await signedIn()
      pick(h, 'twitter')
      expect([h.fields['proof-identity-input'].value, h.fields['proof-proof-input'].value]).toEqual(['jack', 'oauth'])
    })

    it('stops watching once there is nothing of the sign-in left to clear', async () => {
      const h = await signedIn()
      pick(h, 'github')
      expect(h.fields['proof-platform-select'].listeners.change ?? []).toEqual([])
    })
  })
})
