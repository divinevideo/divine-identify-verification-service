import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index'

const API = 'https://verifier.divine.video'
const PUBKEY = 'ab'.repeat(32)
const PENDING_PREFIX = 'verifier_pending_sign_in:'
const NONCE = '0123456789abcdef'.repeat(2)
const PENDING_KEY = PENDING_PREFIX + NONCE
const CONFIRMING: [string, string, string] = ['verify-global-status', 'Confirming your sign-in...', 'loading']
const UNCONFIRMED: [string, string, string] = ['verify-global-status', 'This page could not confirm a sign-in. Start the sign-in again from this page.', 'error']

async function pageHtml(): Promise<string> {
  const res = await worker.fetch(new Request(`${API}/`), {} as never)
  return res.text()
}

// Runs the landing page's real sign-in return code (from the pending sign-in
// helpers through handleOAuthCallbackMessage) against stand-ins for the
// browser, so the test exercises the shipped script rather than a copy of it.
async function loadReturnHandler() {
  const html = await pageHtml()
  const start = html.indexOf('const PENDING_SIGN_IN_KEY')
  const end = html.indexOf('function showStatus(msg, type)', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const source = html.slice(start, end)
  const deps = ['window', 'localStorage', 'fetch', 'API', 'setStatus', 'document']
  return (env: Record<string, unknown>) =>
    new Function(...deps, `${source}\nreturn { handleOAuthCallbackMessage, rememberPendingSignIn, newSignInNonce };`)(...deps.map(d => env[d]))
}

function harness(opts: { search: string, pending?: unknown, statusResponse?: unknown, statusFails?: boolean, statusOk?: boolean, stored?: Record<string, string>, store?: Map<string, string> }) {
  const store = opts.store ?? new Map<string, string>(Object.entries(opts.stored ?? {}))
  if (opts.pending !== undefined) store.set(PENDING_KEY, JSON.stringify(opts.pending))
  const statuses: Array<[string, string, string]> = []
  const fetched: string[] = []
  const fields: Record<string, { value: string, open?: boolean, scrollIntoView?: () => void }> = {
    'proof-platform-select': { value: '' },
    'proof-identity-input': { value: '' },
    'proof-proof-input': { value: '' },
    'advanced-proof': { value: '', open: false },
    'publish-kind0-btn': { value: '', scrollIntoView: () => {} },
  }
  const location = { search: opts.search, pathname: '/', hash: '#verify-here' }
  const env: Record<string, unknown> = {
    API,
    window: { location, history: { replaceState: (_s: unknown, _t: string, url: string) => { location.search = url.includes('?') ? url.slice(url.indexOf('?'), url.indexOf('#') > -1 ? url.indexOf('#') : undefined) : '' } } },
    localStorage: {
      get length() { return store.size },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    },
    fetch: async (url: string) => {
      fetched.push(url)
      if (opts.statusFails) throw new Error('network down')
      return { ok: opts.statusOk ?? true, json: async () => opts.statusResponse }
    },
    setStatus: (id: string, msg: string, type: string) => { statuses.push([id, msg, type]) },
    document: { getElementById: (id: string) => fields[id] ?? null },
  }
  return { env, statuses, fetched, fields, store, location }
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
    expect(h.statuses).toEqual([CONFIRMING, ['verify-global-status', 'Success. Your twitter account is now linked: jack. You can now publish this to your Nostr profile below.', 'ok']])
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

  it('does not show success for a sign-in started more than 10 minutes ago', async () => {
    const load = await loadReturnHandler()
    const h = harness({
      search: returned(),
      pending: { ...freshPending(), startedAt: Date.now() - 11 * 60 * 1000 },
    })
    await load(h.env).handleOAuthCallbackMessage()
    expect(h.fetched).toEqual([])
    expect(h.statuses).toEqual([UNCONFIRMED])
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
    const html = await pageHtml()
    const start = html.indexOf('async function startOAuthVerification()')
    const body = html.slice(start, html.indexOf('async function verifySingleHere()', start))
    const guard = body.indexOf('if (!rememberPendingSignIn(platform, pubkey, nonce)) {')
    const leave = body.indexOf("window.location.href = API + '/auth/'")
    expect(guard).toBeGreaterThan(-1)
    expect(leave).toBeGreaterThan(guard)
    // The failure path must stop the start before the page navigates away.
    const failurePath = body.slice(guard, body.indexOf('}', guard))
    expect(failurePath).toContain('throw new Error(')
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

  it('remembers the platform and account when a sign-in starts', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: '' })
    load(h.env).rememberPendingSignIn('bluesky', PUBKEY, NONCE)
    const saved = JSON.parse(h.store.get(PENDING_PREFIX + NONCE) as string)
    expect(saved).toMatchObject({ platform: 'bluesky', pubkey: PUBKEY, nonce: NONCE })
    expect(typeof saved.startedAt).toBe('number')
  })

  it('saves the pending sign-in before leaving for the provider', async () => {
    const html = await pageHtml()
    const start = html.indexOf('async function startOAuthVerification()')
    const body = html.slice(start, html.indexOf('async function verifySingleHere()', start))
    const remember = body.indexOf('rememberPendingSignIn(platform, pubkey, nonce)')
    expect(remember).toBeGreaterThan(-1)
    expect(remember).toBeLessThan(body.indexOf("window.location.href = API + '/auth/'"))
    // The same one-time code goes into the return address the provider sends the person back to.
    expect(body).toContain("return_url: window.location.origin + window.location.pathname + '?signin=' + nonce + '#verify-here',")
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

  it('does not show success when the confirmation request is answered with an error status', async () => {
    const load = await loadReturnHandler()
    const h = harness({ search: returned(), pending: freshPending(), statusOk: false, statusResponse: { verified: true, identity: 'jack' } })
    await load(h.env).handleOAuthCallbackMessage()
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
        [expiredKey]: JSON.stringify({ ...freshPending(), startedAt: Date.now() - 11 * 60 * 1000 }),
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
})
