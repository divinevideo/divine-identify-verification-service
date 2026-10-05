import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index'

const API = 'https://verifier.divine.video'
const PUBKEY = 'ab'.repeat(32)
const PENDING_PREFIX = 'verifier_pending_sign_in:'
const NONCE = '0123456789abcdef'.repeat(2)
const PENDING_KEY = PENDING_PREFIX + NONCE
const CONFIRMING: [string, string, string] = ['verify-global-status', 'Confirming your sign-in...', 'loading']
const UNCONFIRMED: [string, string, string] = ['verify-global-status', 'This page could not confirm a sign-in. Start the sign-in again from this page.', 'error']
const SAVE_REFUSED: [string, string, string] = ['oauth-status', 'This browser would not let the page save your sign-in, so it could not confirm it when you come back. Allow this site to store data and try again.', 'error']

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
// helpers through handleOAuthCallbackMessage) against stand-ins for the
// browser, so the test exercises the shipped script rather than a copy of it.
async function loadReturnHandler() {
  const source = scriptBetween(await pageHtml(), 'const PENDING_SIGN_IN_KEY', 'function showStatus(msg, type)')
  const deps = ['window', 'localStorage', 'fetch', 'API', 'setStatus', 'clearStatus', 'document', 'updateProofInputs']
  return (env: Record<string, unknown>) =>
    new Function(...deps, `${source}\nreturn { handleOAuthCallbackMessage, rememberPendingSignIn, newSignInNonce };`)(...deps.map(d => env[d]))
}

// Runs the page's real sign-in start (startOAuthVerification, with the
// setAccountInputValue and pending sign-in helpers it calls) against
// stand-ins for the browser and the rest of the page.
async function loadSignInStart() {
  const html = await pageHtml()
  const source = [
    scriptBetween(html, 'function setAccountInputValue(value)', 'function inferLoginQueryPubkey(params)'),
    scriptBetween(html, 'async function startOAuthVerification()', 'async function verifySingleHere()'),
    scriptBetween(html, 'const PENDING_SIGN_IN_KEY', 'function showStatus(msg, type)'),
  ].join('\n')
  const deps = ['window', 'localStorage', 'fetch', 'API', 'setStatus', 'clearStatus', 'setButtonLoading', 'getActivePubkey', 'document']
  return (env: Record<string, unknown>) =>
    new Function(...deps, `${source}\nreturn { startOAuthVerification };`)(...deps.map(d => env[d]))
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
    fetch: async () => { throw new Error('starting a sign-in must not call the verifier') },
    setStatus: (id: string, msg: string, type: string) => { statuses.push([id, msg, type]) },
    clearStatus: () => {},
    setButtonLoading: (id: string, loading: boolean) => { buttons.push([id, loading]) },
    getActivePubkey: async () => PUBKEY,
    document: { getElementById: (id: string) => fields[id] ?? null },
  }
  return { env, store, statuses, buttons, departures }
}

// Runs the page's start-up code, from remembering the account box through the
// Divine login checks, with the page functions it calls replaced by recorders.
async function loadStartup() {
  const source = scriptBetween(await pageHtml(), "document.getElementById('verify-pubkey-input').addEventListener('blur'", '// Lookup tool Enter key')
  const pageFunctions = ['updateOAuthInputs', 'updateProofInputs', 'handleOAuthCallbackMessage', 'forgetExpiredSignIns', 'updateSignerSummary', 'maybeHandleKeycastCallback', 'applyLoginQueryHint', 'restoreKeycastSession']
  return (opts: { blockStorage?: boolean } = {}) => {
    const calls: string[] = []
    const store = new Map<string, string>()
    const accountListeners: Record<string, () => void> = {}
    const accountBox = { value: '', addEventListener: (type: string, listener: () => void) => { accountListeners[type] = listener } }
    const windowListeners: Record<string, (event: { persisted: boolean }) => void> = {}
    const buttons: Array<[string, boolean]> = []
    const cleared: string[] = []
    const env: Record<string, unknown> = {
      window: { addEventListener: (type: string, listener: (event: { persisted: boolean }) => void) => { windowListeners[type] = listener } },
      localStorage: opts.blockStorage ? blockedStorage() : {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v) },
      },
      document: { getElementById: (id: string) => (id === 'verify-pubkey-input' ? accountBox : null) },
      setButtonLoading: (id: string, loading: boolean) => { buttons.push([id, loading]) },
      clearStatus: (id: string) => { cleared.push(id) },
      ...Object.fromEntries(pageFunctions.map(name => [name, async () => { calls.push(name); return false }])),
    }
    const deps = ['window', 'localStorage', 'document', 'setButtonLoading', 'clearStatus', ...pageFunctions]
    new Function(...deps, source)(...deps.map(d => env[d]))
    return { calls, accountBox, accountListeners, windowListeners, buttons, cleared }
  }
}

// One scripted answer to a confirmation request: a network failure, or a
// response with a status and either a JSON body or a body that isn't JSON.
type StatusAnswer = 'network error' | { status: number, json?: unknown, notJson?: boolean }

function harness(opts: { search: string, pending?: unknown, statusResponse?: unknown, statusFails?: boolean, statusOk?: boolean, answers?: StatusAnswer[], stored?: Record<string, string>, store?: Map<string, string>, readyState?: 'loading' | 'interactive' }) {
  const store = opts.store ?? new Map<string, string>(Object.entries(opts.stored ?? {}))
  if (opts.pending !== undefined) store.set(PENDING_KEY, JSON.stringify(opts.pending))
  const statuses: Array<[string, string, string]> = []
  const fetched: string[] = []
  // Every address the page rewrote itself to.
  const replaced: string[] = []
  // The proof platform each time the page updated the proof form's labels.
  const labelUpdates: string[] = []
  // Which elements the page scrolled into view, in order, and the sign-in
  // message showing each time it brought that message into view.
  const scrolledTo: string[] = []
  const scrolledWith: string[] = []
  // A stand-in element: a value, optional extras, and event listeners a test can fire.
  type Field = { value: string, textContent?: string, hidden?: boolean, open?: boolean, scrollIntoView?: () => void, listeners: Record<string, Array<() => void>>, addEventListener: (type: string, fn: () => void) => void, removeEventListener: (type: string, fn: () => void) => void }
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
    'proof-status': field(),
    'advanced-proof': field({ open: false }),
    'publish-kind0-btn': field({ scrollIntoView: () => { scrolledTo.push('publish-kind0-btn') } }),
    'verify-global-status': field({ scrollIntoView: () => { scrolledTo.push('verify-global-status'); scrolledWith.push(statuses[statuses.length - 1]?.[1] ?? '') } }),
  }
  const answers = opts.answers ? [...opts.answers] : null
  const location = { search: opts.search, pathname: '/', hash: '#verify-here' }
  // The page's load listeners, so a test can finish loading the page.
  const loadListeners: Array<() => void> = []
  const doc = { readyState: opts.readyState ?? 'complete', getElementById: (id: string) => fields[id] ?? null }
  const finishLoading = () => { doc.readyState = 'complete'; loadListeners.splice(0).forEach(fn => fn()) }
  const env: Record<string, unknown> = {
    API,
    window: { location, addEventListener: (type: string, fn: () => void) => { if (type === 'load') loadListeners.push(fn) }, history: { replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); location.search = url.includes('?') ? url.slice(url.indexOf('?'), url.indexOf('#') > -1 ? url.indexOf('#') : undefined) : '' } } },
    localStorage: {
      get length() { return store.size },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    },
    fetch: async (url: string) => {
      fetched.push(url)
      if (answers) {
        const answer = answers.shift() ?? 'network error'
        if (answer === 'network error') throw new Error('network down')
        return {
          ok: answer.status >= 200 && answer.status < 300,
          status: answer.status,
          json: async () => { if (answer.notJson) throw new SyntaxError('not JSON'); return answer.json },
        }
      }
      if (opts.statusFails) throw new Error('network down')
      const ok = opts.statusOk ?? true
      // A refused request (4xx), which is final: no second try.
      return { ok, status: ok ? 200 : 400, json: async () => opts.statusResponse }
    },
    setStatus: (id: string, msg: string, type: string) => {
      statuses.push([id, msg, type])
      if (fields[id]) { fields[id].textContent = msg; fields[id].hidden = false }
    },
    clearStatus: (id: string) => { if (fields[id]) fields[id].hidden = true },
    document: doc,
    updateProofInputs: () => { labelUpdates.push(fields['proof-platform-select'].value) },
  }
  // Runs a field's listeners, the way the browser would for a person's edit or click.
  const fire = (id: string, type: string) => { [...(fields[id].listeners[type] ?? [])].forEach(fn => fn()) }
  return { env, statuses, fetched, fields, store, location, replaced, labelUpdates, scrolledTo, scrolledWith, finishLoading, fire }
}

const freshPending = (platform = 'twitter') => ({ platform, pubkey: PUBKEY, nonce: NONCE, startedAt: Date.now() })
const returned = (extra = '') => `?signin=${NONCE}&oauth_verified=true&platform=twitter&identity=jack${extra}`

describe('sign-in return on the verifier page', () => {
  it('confirms a sign-in the page started before showing success and filling the Publish form', async () => {
    const load = await loadReturnHandler()
    const h = harness({
      search: returned(),
      pending: freshPending(),
      statusResponse: { verified: true, identity: 'jack', platform: 'twitter' },
    })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toEqual([`${API}/auth/twitter/status?pubkey=${PUBKEY}&identity=jack`])
    expect(h.statuses).toEqual([CONFIRMING, ['verify-global-status', 'Success. Your twitter account is now linked: jack. You can now publish this to your Nostr profile below.', 'ok'], ['proof-status', 'Your twitter account jack is linked. Publish to add it to your Nostr profile.', 'ok']])
    expect(h.fields['proof-platform-select'].value).toBe('twitter')
    expect(h.fields['proof-identity-input'].value).toBe('jack')
    expect(h.fields['proof-proof-input'].value).toBe('oauth')
    expect(h.store.has(PENDING_KEY)).toBe(false)
    expect(h.location.search).toBe('')
  })

  it('does not show success when the page did not start a sign-in', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned() })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toEqual([])
    expect(h.statuses).toEqual([UNCONFIRMED])
    expect(h.fields['proof-identity-input'].value).toBe('')
  })

  it('does not show success when the verifier does not confirm the link', async () => {
    const load = await loadReturnHandler()
    const h = harness({
      search: returned(),
      pending: freshPending(),
      statusResponse: { verified: false },
    })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([CONFIRMING, UNCONFIRMED])
    expect(h.fields['proof-identity-input'].value).toBe('')
  })

  it('does not show success when the confirmation request fails', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending(), statusFails: true })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([CONFIRMING, UNCONFIRMED])
    expect(h.fields['proof-identity-input'].value).toBe('')
  })

  it('does not show success for a different platform than the one the page started', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending('bluesky') })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toEqual([])
    expect(h.statuses).toEqual([UNCONFIRMED])
  })

  it('does not show success for a sign-in started more than 11 minutes ago', async () => {
    const load = await loadReturnHandler()
    const h = harness({
      search: returned(),
      pending: { ...freshPending(), startedAt: Date.now() - 12 * 60 * 1000 },
    })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toEqual([])
    expect(h.statuses).toEqual([UNCONFIRMED])
  })

  // The page starts its clock at the click; the verifier's 10 minutes start a
  // little later and it enforces them itself, so the page allows a minute more.
  it('still asks the verifier about a sign-in started 10 and a half minutes ago', async () => {
    const load = await loadReturnHandler()
    const h = harness({
      search: returned(),
      pending: { ...freshPending(), startedAt: Date.now() - 10.5 * 60 * 1000 },
      statusResponse: { verified: true, identity: 'jack' },
    })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toHaveLength(1)
    expect(h.statuses[h.statuses.length - 1][2]).toBe('ok')
  })

  it('still confirms a sign-in started 9 minutes ago', async () => {
    const load = await loadReturnHandler()
    const h = harness({
      search: returned(),
      pending: { ...freshPending(), startedAt: Date.now() - 9 * 60 * 1000 },
      statusResponse: { verified: true, identity: 'jack' },
    })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.statuses[h.statuses.length - 1][2]).toBe('ok')
  })

  it('uses up the pending sign-in so the same return works only once', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending(), statusResponse: { verified: true, identity: 'jack' } })
    const handler = load(h.env)
    await handler.handleOAuthCallbackMessage()
    expect(h.store.has(PENDING_KEY)).toBe(false)
    h.location.search = returned()
    h.statuses.length = 0
    await handler.handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([UNCONFIRMED])
  })

  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['not lowercase hex', 'N'.repeat(32)],
  ])('ignores a one-time code that is %s, even if something is stored under it', async (_label, code) => {
    const load = await loadReturnHandler()
    const h = harness({
      search: `?signin=${code}&oauth_verified=true&platform=twitter&identity=jack`,
      stored: { [PENDING_PREFIX + code]: JSON.stringify({ ...freshPending(), nonce: code }) },
      statusResponse: { verified: true, identity: 'jack' },
    })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toEqual([])
    expect(h.statuses).toEqual([UNCONFIRMED])
  })

  it('needs the verifier to answer exactly verified: true', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending(), statusResponse: { verified: 'yes', identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([CONFIRMING, UNCONFIRMED])
  })

  it('only handles sign-in platforms the verifier supports', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: `?signin=${NONCE}&oauth_verified=true&platform=mastodon&identity=jack`, pending: freshPending('mastodon'), statusResponse: { verified: true, identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toEqual([])
    expect(h.statuses).toEqual([UNCONFIRMED])
  })

  it('does not show success when the return names no account', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: `?signin=${NONCE}&oauth_verified=true&platform=twitter&identity=`, pending: freshPending(), statusResponse: { verified: true, identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toEqual([])
    expect(h.statuses).toEqual([UNCONFIRMED])
  })

  it.each([
    ['Verification failed', 'Sign-in was not completed: the account could not be verified.'],
    ['cancelled or declined at Twitter', 'Sign-in was not completed: cancelled or declined at Twitter'],
    ['cancelled or declined at Bluesky', 'Sign-in was not completed: cancelled or declined at Bluesky'],
    ['could not be completed at TikTok', 'Sign-in was not completed: could not be completed at TikTok'],
    ['cancelled or declined at YouTube', 'Sign-in was not completed: cancelled or declined at YouTube'],
    ['cancelled or declined at Somewhere', 'Sign-in was not completed.'],
    ['cancelled or declined at Twitter and some more text', 'Sign-in was not completed.'],
    ['some text then cancelled or declined at Twitter', 'Sign-in was not completed.'],
    ['anything else at all', 'Sign-in was not completed.'],
  ])('shows a known message for oauth_error=%s', async (reason, expected) => {
    const load = await loadReturnHandler()
    const h = harness({ search: `?oauth_error=${encodeURIComponent(reason)}` })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([['verify-global-status', expected, 'error']])
    expect(h.location.search).toBe('')
  })

  it('uses up the pending sign-in when the return reports an error', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: `?signin=${NONCE}&oauth_error=${encodeURIComponent('Verification failed')}`, pending: freshPending() })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.store.has(PENDING_KEY)).toBe(false)
  })

  it('gives up on a confirmation that takes more than 10 seconds', async () => {
    vi.useFakeTimers()
    try {
      const load = await loadReturnHandler()
      const h = harness({ search: returned(), pending: freshPending() })
      let aborted = false
      h.env.fetch = (_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
      })
      const done = load(h.env).handleOAuthCallbackMessage()
      await vi.advanceTimersByTimeAsync(9_999)
      expect(aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await done
      expect(aborted).toBe(true)
      expect(h.statuses).toEqual([CONFIRMING, UNCONFIRMED])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports whether the pending sign-in could be saved', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: '' })
    expect(load(h.env).rememberPendingSignIn('bluesky', PUBKEY, NONCE)).toBe(true)
    const full = harness({ search: '' })
    ;(full.env.localStorage as { setItem: () => void }).setItem = () => { throw new Error('QuotaExceededError') }
    expect(load(full.env).rememberPendingSignIn('bluesky', PUBKEY, NONCE)).toBe(false)
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
    const load = await loadReturnHandler()
    const h = harness({ search: '' })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.statuses).toEqual([])
    expect(h.fetched).toEqual([])
  })

  it('checks for a returning sign-in when the page loads', async () => {
    const startup = await loadStartup()
    const { calls } = startup()
    expect(calls.filter(name => name === 'handleOAuthCallbackMessage')).toHaveLength(1)
  })

  it('clears out expired pending sign-ins when the page loads', async () => {
    const startup = await loadStartup()
    const { calls } = startup()
    expect(calls.filter(name => name === 'forgetExpiredSignIns')).toHaveLength(1)
  })

  it('still checks for a returning sign-in when the browser blocks storage', async () => {
    const startup = await loadStartup()
    const { calls } = startup({ blockStorage: true })
    expect(calls.filter(name => name === 'handleOAuthCallbackMessage')).toHaveLength(1)
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

  it('does not throw when the account box loses focus and the browser blocks storage', async () => {
    const startup = await loadStartup()
    const { accountBox, accountListeners } = startup({ blockStorage: true })
    accountBox.value = 'npub1example'
    expect(() => accountListeners.blur()).not.toThrow()
  })

  it('remembers the platform and account when a sign-in starts', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: '' })
    load(h.env).rememberPendingSignIn('bluesky', PUBKEY, NONCE)
    const saved = JSON.parse(h.store.get(PENDING_PREFIX + NONCE) as string)
    expect(saved).toMatchObject({ platform: 'bluesky', pubkey: PUBKEY, nonce: NONCE })
    expect(typeof saved.startedAt).toBe('number')
  })

  it('saves the pending sign-in before leaving for the provider', async () => {
    const load = await loadSignInStart()
    const h = startHarness()
    await load(h.env).startOAuthVerification()
    expect(h.departures).toHaveLength(1)
    const start = new URL(h.departures[0].url)
    expect(start.origin + start.pathname).toBe(`${API}/auth/twitter/start`)
    expect(start.searchParams.get('pubkey')).toBe(PUBKEY)
    // The same one-time code goes into the return address the provider sends the person back to.
    const back = new URL(start.searchParams.get('return_url') as string)
    expect(back.origin + back.pathname + back.hash).toBe(`${API}/#verify-here`)
    const code = back.searchParams.get('signin') as string
    expect(code).toMatch(/^[0-9a-f]{32}$/)
    expect(h.departures[0].saved).toContain(PENDING_PREFIX + code)
    expect(JSON.parse(h.store.get(PENDING_PREFIX + code) as string)).toMatchObject({ platform: 'twitter', pubkey: PUBKEY, nonce: code })
  })

  it('confirms a sign-in it started once the provider sends the person back', async () => {
    const start = await loadSignInStart()
    const startTab = startHarness()
    await start(startTab.env).startOAuthVerification()
    const back = new URL(new URL(startTab.departures[0].url).searchParams.get('return_url') as string)
    // The verifier's callback adds the result to the return address.
    const load = await loadReturnHandler()
    const h = harness({ search: `${back.search}&oauth_verified=true&platform=twitter&identity=jack`, store: startTab.store, statusResponse: { verified: true, identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toEqual([`${API}/auth/twitter/status?pubkey=${PUBKEY}&identity=jack`])
    expect(h.statuses[h.statuses.length - 1][2]).toBe('ok')
    expect(h.fields['proof-identity-input'].value).toBe('jack')
  })

  it('makes a fresh 32-character one-time code for each sign-in', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: '' })
    const handler = load(h.env)
    const codes = Array.from({ length: 50 }, () => handler.newSignInNonce())
    for (const code of codes) expect(code).toMatch(/^[0-9a-f]{32}$/)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it.each([
    ['missing', ''],
    // Well formed, so it gets past the format check and is looked up.
    ['different', 'f'.repeat(32)],
  ])('does not show success when the one-time code in the return address is %s', async (_label, code) => {
    const load = await loadReturnHandler()
    const search = `?signin=${code}&oauth_verified=true&platform=twitter&identity=jack`
    const h = harness({ search, pending: freshPending(), statusResponse: { verified: true, identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toEqual([])
    expect(h.statuses).toEqual([UNCONFIRMED])
    expect(h.fields['proof-identity-input'].value).toBe('')
  })

  it('checks the account the sign-in started with, not one named in the return address', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(`&pubkey=${'cd'.repeat(32)}`), pending: freshPending(), statusResponse: { verified: true, identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toEqual([`${API}/auth/twitter/status?pubkey=${PUBKEY}&identity=jack`])
  })

  it('fills Publish with the account name the verifier recorded', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: `?signin=${NONCE}&oauth_verified=true&platform=twitter&identity=JACK`, pending: freshPending(), statusResponse: { verified: true, identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fields['proof-identity-input'].value).toBe('jack')
  })

  it('updates the Publish form labels for the platform it fills in', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending(), statusResponse: { verified: true, identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.labelUpdates).toEqual(['twitter'])
  })

  it('does not show success when the confirmation request is refused, even if the answer claims the link', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending(), statusOk: false, statusResponse: { verified: true, identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toHaveLength(1)
    expect(h.statuses).toEqual([CONFIRMING, UNCONFIRMED])
  })

  it.each([
    ['account', { pubkey: 42 }],
    ['start time', { startedAt: 'now' }],
    ['one-time code', { nonce: 7 }],
    ['platform', { platform: 42 }],
  ])('ignores a pending sign-in with a malformed %s', async (_label, broken) => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: { ...freshPending(), ...broken }, statusResponse: { verified: true, identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toEqual([])
    expect(h.statuses).toEqual([UNCONFIRMED])
  })

  it('finds a sign-in started in another tab of the same browser', async () => {
    const load = await loadReturnHandler()
    // Each tab runs its own copy of the page script; only localStorage is shared.
    const startTab = harness({ search: '' })
    expect(load(startTab.env).rememberPendingSignIn('twitter', PUBKEY, NONCE)).toBe(true)
    const returnTab = harness({ search: returned(), store: startTab.store, statusResponse: { verified: true, identity: 'jack' } })
    await load(returnTab.env).handleOAuthCallbackMessage()
    expect(returnTab.statuses[returnTab.statuses.length - 1][2]).toBe('ok')
    expect(startTab.store.has(PENDING_KEY)).toBe(false)
  })

  it('uses only the sign-in whose one-time code came back', async () => {
    const load = await loadReturnHandler()
    const otherKey = PENDING_PREFIX + 'o'.repeat(32)
    const other = JSON.stringify({ ...freshPending(), nonce: 'o'.repeat(32) })
    const h = harness({ search: returned(), pending: freshPending(), stored: { [otherKey]: other }, statusResponse: { verified: true, identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.store.has(PENDING_KEY)).toBe(false)
    expect(h.store.get(otherKey)).toBe(other)
  })

  it('clears out expired pending sign-ins when a new one starts', async () => {
    const load = await loadReturnHandler()
    const expiredKey = PENDING_PREFIX + 'e'.repeat(32)
    const freshKey = PENDING_PREFIX + 'f'.repeat(32)
    const h = harness({
      search: '',
      stored: {
        [expiredKey]: JSON.stringify({ ...freshPending(), startedAt: Date.now() - 12 * 60 * 1000 }),
        [freshKey]: JSON.stringify(freshPending()),
        [PENDING_PREFIX + 'b'.repeat(32)]: 'not json',
        [PENDING_PREFIX + 'c'.repeat(32)]: JSON.stringify({ ...freshPending(), startedAt: 'now' }),
        'some_other_setting': 'kept',
      },
    })
    load(h.env).rememberPendingSignIn('bluesky', PUBKEY, NONCE)
    expect(h.store.has(expiredKey)).toBe(false)
    expect(h.store.has(PENDING_PREFIX + 'b'.repeat(32))).toBe(false)
    expect(h.store.has(PENDING_PREFIX + 'c'.repeat(32))).toBe(false)
    expect(h.store.has(freshKey)).toBe(true)
    expect(h.store.get('some_other_setting')).toBe('kept')
    expect(h.store.has(PENDING_KEY)).toBe(true)
  })

  it('removes the one-time code from the address after handling the return', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending(), statusResponse: { verified: true, identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.location.search).toBe('')
  })

  it('keeps other parameters and the section anchor when it cleans the address', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned('&ref=home'), pending: freshPending(), statusResponse: { verified: true, identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.replaced).toEqual(['/?ref=home#verify-here'])
  })
})

describe('confirming a returning sign-in', () => {
  const linked: StatusAnswer = { status: 200, json: { verified: true, identity: 'jack' } }

  it.each([
    ['a network error', 'network error' as StatusAnswer],
    ['a server error', { status: 503, json: { error: 'unavailable' } } as StatusAnswer],
    ['an answer that is not JSON', { status: 200, notJson: true } as StatusAnswer],
  ])('asks again after %s', async (_label, first) => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending(), answers: [first, linked] })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toHaveLength(2)
    expect(h.statuses[h.statuses.length - 1][2]).toBe('ok')
  })

  it('stops after three tries', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending(), answers: ['network error', 'network error', 'network error', linked] })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toHaveLength(3)
    expect(h.statuses).toEqual([CONFIRMING, UNCONFIRMED])
  })

  it.each([
    ['the verifier says the account is not linked', { status: 200, json: { verified: false } } as StatusAnswer],
    ['the request is refused', { status: 400, json: { error: 'Invalid identity' } } as StatusAnswer],
  ])('does not ask again when %s', async (_label, first) => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending(), answers: [first, linked] })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toHaveLength(1)
    expect(h.statuses).toEqual([CONFIRMING, UNCONFIRMED])
  })

  it('keeps every try inside the same 10 seconds', async () => {
    vi.useFakeTimers()
    try {
      const load = await loadReturnHandler()
      const h = harness({ search: returned(), pending: freshPending() })
      let tries = 0
      // Each try fails after 4 seconds, so a third try would end past the limit.
      h.env.fetch = (_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        tries++
        const t = setTimeout(() => reject(new Error('network down')), 4000)
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
      })
      let settled = false
      const done = load(h.env).handleOAuthCallbackMessage().then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(settled).toBe(true)
      await done
      expect(tries).toBe(3)
      expect(h.statuses).toEqual([CONFIRMING, UNCONFIRMED])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lands on Publish after a successful sign-in, with a note right above it', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending(), answers: [linked] })
    await load(h.env).handleOAuthCallbackMessage()
    // The top message reports the sign-in; the note beside Publish says what Publish will do.
    expect(h.statuses.slice(-2)).toEqual([['verify-global-status', 'Success. Your twitter account is now linked: jack. You can now publish this to your Nostr profile below.', 'ok'], ['proof-status', 'Your twitter account jack is linked. Publish to add it to your Nostr profile.', 'ok']])
    // Confirming is brought into view, then the page lands on Publish.
    expect(h.scrolledWith).toEqual([CONFIRMING[1]])
    expect(h.scrolledTo).toEqual(['verify-global-status', 'publish-kind0-btn'])
    expect(h.fields['advanced-proof'].open).toBe(true)
  })

  it('brings the message into view when it cannot confirm the sign-in', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending(), answers: [{ status: 200, json: { verified: false } }] })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.scrolledWith).toEqual([CONFIRMING[1], UNCONFIRMED[1]])
  })

  it('brings the message into view when the page did not start the sign-in', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned() })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.scrolledWith).toEqual([UNCONFIRMED[1]])
  })

  it.each([
    ['platform', 'proof-platform-select', 'github'],
    ['account name', 'proof-identity-input', 'octocat'],
    ['post link', 'proof-proof-input', 'https://gist.github.com/octocat/abc123'],
  ])('leaves the Publish form alone if its %s was changed while the sign-in was being confirmed', async (_label, field, typed) => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending() })
    h.env.fetch = async () => {
      h.fields[field].value = typed
      return { ok: true, status: 200, json: async () => ({ verified: true, identity: 'jack' }) }
    }
    await load(h.env).handleOAuthCallbackMessage()
    // The whole form is as the person left it: their change, and nothing filled in around it.
    const form = ['proof-platform-select', 'proof-identity-input', 'proof-proof-input']
    expect(Object.fromEntries(form.map(id => [id, h.fields[id].value]))).toEqual({ ...Object.fromEntries(form.map(id => [id, ''])), [field]: typed })
    expect(h.labelUpdates).toEqual([])
    expect(h.statuses[h.statuses.length - 1]).toEqual(['verify-global-status', 'Success. Your twitter account is now linked: jack. The Publish form below was left as you changed it.', 'ok'])
    // Nothing was filled in to publish, so there's no note beside Publish
    // and the page stays on the message.
    expect(h.statuses.filter(([id]) => id === 'proof-status')).toEqual([])
    for (const id of ['proof-platform-select', 'proof-identity-input', 'proof-proof-input', 'publish-kind0-btn']) {
      expect(Object.values(h.fields[id].listeners).flat()).toEqual([])
    }
    expect(h.scrolledWith).toEqual([CONFIRMING[1], 'Success. Your twitter account is now linked: jack. The Publish form below was left as you changed it.'])
    expect(h.scrolledTo).not.toContain('publish-kind0-btn')
  })

  it('stops at 10 seconds even while waiting to try again', async () => {
    vi.useFakeTimers()
    try {
      const load = await loadReturnHandler()
      const h = harness({ search: returned(), pending: freshPending() })
      let tries = 0
      // The first try fails just before the limit, so the wait before the next one crosses it.
      h.env.fetch = (_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        tries++
        const t = setTimeout(() => reject(new Error('network down')), 9_900)
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
      })
      let settled = false
      const done = load(h.env).handleOAuthCallbackMessage().then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(settled).toBe(true)
      await done
      expect(tries).toBe(1)
      expect(h.statuses).toEqual([CONFIRMING, UNCONFIRMED])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops at 10 seconds even while reading an answer', async () => {
    vi.useFakeTimers()
    try {
      const load = await loadReturnHandler()
      const h = harness({ search: returned(), pending: freshPending() })
      let tries = 0
      h.env.fetch = async (_url: string, init?: { signal?: AbortSignal }) => {
        tries++
        return {
          ok: true,
          status: 200,
          // The body never finishes arriving; the limit cuts it off.
          json: () => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))) }),
        }
      }
      let settled = false
      const done = load(h.env).handleOAuthCallbackMessage().then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(settled).toBe(true)
      await done
      expect(tries).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // 'interactive' means the page's content is ready but its fonts and images
  // are still loading, so the browser hasn't made its own jump yet either.
  it.each(['loading', 'interactive'] as const)('waits for the page to finish loading (now %s) before bringing the message into view', async (readyState) => {
    vi.useFakeTimers()
    try {
      const load = await loadReturnHandler()
      // A cancelled sign-in is answered straight away, before the page has finished loading.
      const h = harness({ search: `?oauth_error=${encodeURIComponent('cancelled or declined at Twitter')}`, readyState })
      await load(h.env).handleOAuthCallbackMessage()
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
      const load = await loadReturnHandler()
      const h = harness({ search: returned(), pending: freshPending(), answers: [{ status: 200, json: { verified: true, identity: 'jack' } }], readyState })
      await load(h.env).handleOAuthCallbackMessage()
      expect(h.scrolledTo).toEqual([])
      h.finishLoading()
      expect(h.scrolledTo).toEqual([])
      await vi.advanceTimersByTimeAsync(0)
      expect(h.scrolledTo).toEqual(['verify-global-status', 'publish-kind0-btn'])
    } finally {
      vi.useRealTimers()
    }
  })

  describe('the note beside Publish', () => {
    const READY = 'Your twitter account jack is linked. Publish to add it to your Nostr profile.'
    async function signedIn() {
      const load = await loadReturnHandler()
      const h = harness({ search: returned(), pending: freshPending(), answers: [{ status: 200, json: { verified: true, identity: 'jack' } }] })
      await load(h.env).handleOAuthCallbackMessage()
      expect(h.fields['proof-status']).toMatchObject({ textContent: READY, hidden: false })
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
      expect(h.fields['proof-status'].hidden).toBe(true)
    })

    it('stays when an edit event leaves the form unchanged, such as typing the same letter over a selected one', async () => {
      const h = await signedIn()
      h.fields['proof-identity-input'].value = 'jack'
      h.fire('proof-identity-input', 'input')
      expect(h.fields['proof-status'].hidden).toBe(false)
    })

    it('goes away when Publish is clicked', async () => {
      const h = await signedIn()
      h.fire('publish-kind0-btn', 'click')
      expect(h.fields['proof-status'].hidden).toBe(true)
    })

    it('leaves a newer message in that spot alone, such as a "Verify this link" result', async () => {
      const h = await signedIn()
      setStatus(h)('proof-status', 'Success. This account is verified.', 'ok')
      h.fields['proof-identity-input'].value = 'someone-else'
      h.fire('proof-identity-input', 'input')
      h.fire('publish-kind0-btn', 'click')
      expect(h.fields['proof-status']).toMatchObject({ textContent: 'Success. This account is verified.', hidden: false })
    })

    it('stops watching once it has gone', async () => {
      const h = await signedIn()
      h.fire('publish-kind0-btn', 'click')
      for (const id of ['proof-platform-select', 'proof-identity-input', 'proof-proof-input', 'publish-kind0-btn']) {
        expect(Object.values(h.fields[id].listeners).flat()).toEqual([])
      }
    })
  })
})
