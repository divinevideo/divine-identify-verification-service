import { describe, expect, it } from 'vitest'
import worker from './index'

// Runs the landing page's real Publish (publishIdentityTagToNostr) with the
// real pending sign-in helpers and hashing, against stand-ins for the
// verifier, the signer, the relays and the browser, so the tests exercise the
// shipped script rather than a copy of it (#113).

const API = 'https://verifier.divine.video'
const PUBKEY = 'ab'.repeat(32)
const OTHER_PUBKEY = 'cd'.repeat(32)
const NONCE = '0123456789abcdef'.repeat(2)
const PENDING_KEY = 'verifier_pending_sign_in:' + NONCE
// The shared test vector's one-time code, start secret, start check and binding.
const CODE = 'C'.repeat(43)
const START_SECRET = 'S'.repeat(43)
const START_CHECK = 'G2CN_J8Es1JmsWz0QXd2Kc-4p-lCo8GCsR-tVw6vre4'
const BINDING = 'y_rdmZDwlKYUcthysDgPyoiPWBwzgSafjaPHJ4JE1ZY'
const LINKED = { status: 200, body: { linked: true, platform: 'twitter', identity: 'example' } }
const NOT_CONFIRMED = 'This sign-in couldn\'t be confirmed. Sign in again.'
const ACCOUNT_MISMATCH = 'The account in Step 1 does not match the account you signed in with.'

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

const DEPS = ['document', 'fetch', 'API', 'PROFILE_RELAYS', 'setTimeout', 'Date', 'localStorage', 'crypto', 'btoa',
  'publishEventToRelay', 'readLinkedAccounts', 'LINKED_ACCOUNTS_UNREAD', 'activeSigner', 'getActivePubkey', 'signerPubkeyHex',
  'setStatus', 'clearStatus', 'setButtonLoading', 'setAccountInputValue', 'updateSignerSummary', 'currentProofContext']

type Answer = { status: number, body: unknown } | 'unreachable'
type SignedEvent = { id: string, pubkey: string, kind: number, created_at: number, tags: string[][], content: string, sig: string }
type ConfirmBody = { code: string, start_secret: string, event: SignedEvent }

async function publishHarness(opts: { confirmAnswers: Answer[], deadlinePassed?: boolean, noWaitingSignIn?: boolean, pendingPubkey?: string }) {
  const html = await pageHtml()
  const source = [
    scriptBetween(html, 'function bytesToBase64Url(bytes)', 'async function createKeycastPkce()'),
    scriptBetween(html, 'async function publishIdentityTagToNostr()', '// A sign-in this page started'),
    scriptBetween(html, 'const PENDING_SIGN_IN_KEY', 'function showStatus(msg, type)'),
  ].join('\n')

  let now = 1_760_000_000_000
  let jumped = false
  const store = new Map<string, string>()
  const statuses: Array<[string, string, string]> = []
  const published: SignedEvent[] = []
  const confirmBodies: ConfirmBody[] = []
  const requests: string[] = []
  let signCount = 0
  let answered = 0
  let waits = 0

  if (!opts.noWaitingSignIn) {
    store.set(PENDING_KEY, JSON.stringify({
      platform: 'twitter', pubkey: opts.pendingPubkey ?? PUBKEY, nonce: NONCE, startedAt: now, finishedAt: now,
      startSecret: START_SECRET, startCheck: START_CHECK, code: CODE, identity: 'example', signer: 'keycast',
    }))
  }

  const env: Record<string, unknown> = {
    API,
    PROFILE_RELAYS: ['wss://relay.divine.video'],
    document: { getElementById: () => null },
    // Runs at once. The page waits a second between tries for about ten
    // seconds, so many more waits mean it would never give up.
    setTimeout: (fn: () => void) => {
      if (++waits > 20) throw new Error('kept trying without giving up')
      fn()
      return 0
    },
    Date: { now: () => now },
    localStorage: {
      get length() { return store.size },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    },
    crypto,
    btoa,
    fetch: async (url: string, init: RequestInit) => {
      requests.push(url)
      if (url !== API + '/auth/confirm') throw new Error('unexpected request: ' + url)
      confirmBodies.push(JSON.parse(String(init.body)))
      if (opts.deadlinePassed && !jumped) { jumped = true; now += 11_000 }
      const answer = opts.confirmAnswers[Math.min(answered++, opts.confirmAnswers.length - 1)]
      if (answer === 'unreachable') throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify(answer.body), { status: answer.status })
    },
    publishEventToRelay: async (_relay: string, signed: SignedEvent) => {
      published.push(signed)
      return { ok: true }
    },
    readLinkedAccounts: async () => ({ read: true, event: null }),
    LINKED_ACCOUNTS_UNREAD: 'unread',
    activeSigner: {
      getPublicKey: async () => PUBKEY,
      signEvent: async (unsigned: Omit<SignedEvent, 'id' | 'sig'>) => {
        signCount++
        return { ...unsigned, created_at: 1700000000 + signCount, id: String(signCount).padStart(64, '0'), sig: 'aa'.repeat(64) }
      },
    },
    getActivePubkey: async () => PUBKEY,
    signerPubkeyHex: null,
    setStatus: (id: string, msg: string, type: string) => { statuses.push([id, msg, type]) },
    clearStatus: () => {},
    setButtonLoading: () => {},
    setAccountInputValue: () => {},
    updateSignerSummary: () => {},
    currentProofContext: () => ({ platform: 'twitter', identity: 'example', proof: 'oauth' }),
  }
  const page = new Function(...DEPS, `${source}\nreturn { publishIdentityTagToNostr };`)(...DEPS.map(d => env[d]))
  return {
    page,
    store,
    statuses,
    published,
    confirmBodies,
    requests,
    get signCount() { return signCount },
    lastStatus: () => statuses[statuses.length - 1],
    resetDeadline: () => { if (jumped) now -= 11_000 },
  }
}

describe('publishing a link that is waiting for confirmation', () => {
  it('adds the bound value to the claim, confirms, then publishes the same event', async () => {
    const h = await publishHarness({ confirmAnswers: [LINKED] })
    await h.page.publishIdentityTagToNostr()
    const sent = h.confirmBodies[0]
    expect(sent.code).toBe(CODE)
    expect(sent.start_secret).toBe(START_SECRET)
    expect(sent.event.tags).toContainEqual(['i', 'twitter:example', 'oauth', BINDING])
    expect(h.published).toEqual([sent.event])
    expect(h.store.has(PENDING_KEY)).toBe(false)
  })

  it('says it is confirming the link before it publishes', async () => {
    const h = await publishHarness({ confirmAnswers: [LINKED] })
    await h.page.publishIdentityTagToNostr()
    const messages = h.statuses.map(([, msg]) => msg)
    expect(messages).toContain('Confirming the link...')
    expect(messages.indexOf('Confirming the link...')).toBeLessThan(messages.indexOf('Publishing identity event to relays...'))
    expect(h.lastStatus()[2]).toBe('ok')
  })

  it('sends the code and start secret only in the confirmation request, and never shows them', async () => {
    const h = await publishHarness({ confirmAnswers: [{ status: 409, body: { code: 'signin_used' } }] })
    await h.page.publishIdentityTagToNostr()
    expect(h.requests).toEqual([API + '/auth/confirm'])
    for (const [, msg] of h.statuses) {
      expect(msg).not.toContain(CODE)
      expect(msg).not.toContain(START_SECRET)
    }
  })

  it('does not publish when the verifier refuses, says why, and forgets the sign-in', async () => {
    const h = await publishHarness({ confirmAnswers: [{ status: 409, body: { code: 'signin_used' } }] })
    await h.page.publishIdentityTagToNostr()
    expect(h.published).toHaveLength(0)
    expect(h.lastStatus()).toEqual(['publish-status', 'This sign-in was already used. Sign in again.', 'error'])
    expect(h.store.has(PENDING_KEY)).toBe(false)
  })

  it.each([
    [404, 'signin_not_found', NOT_CONFIRMED],
    [409, 'signin_used', 'This sign-in was already used. Sign in again.'],
    [401, 'signin_wrong_account', 'Sign in with the Divine account that started this sign-in.'],
    [401, 'signin_not_yours', 'This sign-in was started somewhere else, so it wasn\'t linked.'],
    [401, 'signin_claim_mismatch', 'This confirmation doesn\'t match the sign-in. Sign in again.'],
    [400, 'invalid_event', NOT_CONFIRMED],
  ])('says why when the verifier answers %s %s, and publishes nothing', async (status, code, message) => {
    const h = await publishHarness({ confirmAnswers: [{ status, body: { code } }], deadlinePassed: true })
    await h.page.publishIdentityTagToNostr()
    expect(h.published).toHaveLength(0)
    expect(h.lastStatus()).toEqual(['publish-status', message, 'error'])
  })

  it('publishes the next link as an ordinary one once the verifier has refused the sign-in', async () => {
    const h = await publishHarness({ confirmAnswers: [{ status: 409, body: { code: 'signin_used' } }] })
    await h.page.publishIdentityTagToNostr()
    await h.page.publishIdentityTagToNostr()
    expect(h.confirmBodies).toHaveLength(1)
    expect(h.published).toHaveLength(1)
    expect(h.published[0].tags).toContainEqual(['i', 'twitter:example', 'oauth'])
  })

  it('keeps the sign-in when the verifier could not be reached, so Publish can try again', async () => {
    const h = await publishHarness({ confirmAnswers: [{ status: 503, body: {} }], deadlinePassed: true })
    await h.page.publishIdentityTagToNostr()
    expect(h.published).toHaveLength(0)
    expect(h.store.has(PENDING_KEY)).toBe(true)
  })

  it('keeps the sign-in when the verifier has still not seen it after ten seconds', async () => {
    const h = await publishHarness({ confirmAnswers: [{ status: 404, body: { code: 'signin_not_found' } }], deadlinePassed: true })
    await h.page.publishIdentityTagToNostr()
    expect(h.published).toHaveLength(0)
    expect(h.store.has(PENDING_KEY)).toBe(true)
  })

  it('tries again while the verifier has not seen the sign-in yet, with the same event', async () => {
    const h = await publishHarness({ confirmAnswers: [
      { status: 404, body: { code: 'signin_not_found' } },
      LINKED,
    ] })
    await h.page.publishIdentityTagToNostr()
    expect(h.confirmBodies).toHaveLength(2)
    expect(h.confirmBodies[1].event.id).toBe(h.confirmBodies[0].event.id)
    expect(h.published).toHaveLength(1)
  })

  it('tries again when the verifier fails for a moment, with the same event', async () => {
    const h = await publishHarness({ confirmAnswers: [{ status: 503, body: {} }, LINKED] })
    await h.page.publishIdentityTagToNostr()
    expect(h.confirmBodies).toHaveLength(2)
    expect(h.confirmBodies[1].event.id).toBe(h.confirmBodies[0].event.id)
    expect(h.published).toHaveLength(1)
  })

  it('tries again when the confirmation request fails to send, with the same event', async () => {
    const h = await publishHarness({ confirmAnswers: ['unreachable', LINKED] })
    await h.page.publishIdentityTagToNostr()
    expect(h.confirmBodies).toHaveLength(2)
    expect(h.confirmBodies[1].event.id).toBe(h.confirmBodies[0].event.id)
    expect(h.published).toHaveLength(1)
  })

  it('does not publish when the verifier answers without saying the link was made', async () => {
    const h = await publishHarness({ confirmAnswers: [{ status: 200, body: {} }] })
    await h.page.publishIdentityTagToNostr()
    expect(h.published).toHaveLength(0)
    expect(h.lastStatus()[2]).toBe('error')
  })

  it('pressing Publish again after the verifier could not be reached sends the very same signed event', async () => {
    const h = await publishHarness({ confirmAnswers: [
      { status: 503, body: {} },
      LINKED,
    ], deadlinePassed: true })
    await h.page.publishIdentityTagToNostr()
    expect(h.published).toHaveLength(0)
    h.resetDeadline()
    await h.page.publishIdentityTagToNostr()
    expect(h.signCount).toBe(1)
    expect(h.confirmBodies[h.confirmBodies.length - 1].event.id).toBe(h.confirmBodies[0].event.id)
    expect(h.published).toHaveLength(1)
  })

  it('publishes a link with no waiting sign-in as before, without confirming', async () => {
    const h = await publishHarness({ confirmAnswers: [], noWaitingSignIn: true })
    await h.page.publishIdentityTagToNostr()
    expect(h.confirmBodies).toHaveLength(0)
    expect(h.published).toHaveLength(1)
    expect(h.published[0].tags).toContainEqual(['i', 'twitter:example', 'oauth'])
  })

  it('does not confirm or publish when the signer holds a different account than the one that started the sign-in', async () => {
    const h = await publishHarness({ confirmAnswers: [LINKED], pendingPubkey: OTHER_PUBKEY })
    await h.page.publishIdentityTagToNostr()
    expect(h.confirmBodies).toHaveLength(0)
    expect(h.published).toHaveLength(0)
    expect(h.lastStatus()).toEqual(['publish-status', ACCOUNT_MISMATCH, 'error'])
    expect(h.store.has(PENDING_KEY)).toBe(true)
  })
})
