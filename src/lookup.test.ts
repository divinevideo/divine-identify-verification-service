import { describe, expect, it, vi } from 'vitest'
import worker from './index'
import { MAX_BATCH_SIZE } from './routes/verify'

const PUBKEY = 'ab'.repeat(32)
const API = 'https://verifier.divine.video'

// Runs the landing page's real "Look up someone" code (doLookup) against
// stand-ins for the DOM, relays and network, so the test exercises the shipped
// script rather than a copy of it.
async function loadDoLookup() {
  const res = await worker.fetch(new Request(`${API}/`), {} as never)
  const html = await res.text()
  const start = html.indexOf('async function doLookup()')
  const end = html.indexOf('function tryParseJSON(s)', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const source = html.slice(start, end)
  // The page's batch size is interpolated from the server's limit; read it back.
  const batchSize = Number(html.match(/const VERIFY_BATCH_SIZE = (\d+);/)?.[1])
  expect(batchSize).toBe(MAX_BATCH_SIZE)
  const deps = ['document', 'fetch', 'API', 'PROFILE_RELAYS', 'VERIFY_BATCH_SIZE', 'fetchIdentityEvent', 'fetchProfileLegacy',
    'showStatus', 'hideStatus', 'renderResults', 'tryParseJSON', 'npubToHex']
  return (env: Record<string, unknown>) =>
    new Function(...deps, `${source}\nreturn doLookup;`)(...deps.map(d => d === 'VERIFY_BATCH_SIZE' ? batchSize : env[d]))
}

function iTag(platform: string, identity: string, proof: string) {
  return ['i', `${platform}:${identity}`, proof]
}

function harness(opts: {
  iTags: string[][]
  nip05?: string
  relays?: string[]
  kind0OnlyOn?: string
  noKind0?: boolean
  nip05Breaks?: boolean
}) {
  const statuses: Array<[string, string]> = []
  const rendered: unknown[][] = []
  const verifyBatches: number[] = []
  const env: Record<string, unknown> = {
    API,
    PROFILE_RELAYS: opts.relays ?? ['wss://relay.example'],
    document: {
      getElementById: (id: string) => id === 'lookup-input' ? { value: PUBKEY } : { innerHTML: '' },
    },
    fetchIdentityEvent: async () => ({ kind: 10011, tags: opts.iTags, content: '' }),
    fetchProfileLegacy: async (relay: string) => (opts.noKind0 || (opts.kind0OnlyOn && relay !== opts.kind0OnlyOn))
      ? null
      : { kind: 0, tags: [], content: JSON.stringify(opts.nip05 ? { nip05: opts.nip05 } : {}) },
    showStatus: (msg: string, type: string) => { statuses.push([msg, type]) },
    hideStatus: () => {},
    renderResults: (results: unknown[]) => { rendered.push(results) },
    tryParseJSON: (s: string) => { try { return JSON.parse(s) } catch { return null } },
    npubToHex: () => PUBKEY,
    fetch: async (url: string, init?: { body?: string }) => {
      if (url.startsWith(`${API}/nip05/verify`)) {
        if (opts.nip05Breaks) return { json: async () => { throw new SyntaxError('Unexpected token <') } }
        return { json: async () => ({ verified: true, cached: false }) }
      }
      if (url === `${API}/verify`) {
        const { claims } = JSON.parse(init!.body!) as { claims: Array<{ platform: string; identity: string }> }
        verifyBatches.push(claims.length)
        // Mirror the server's batch limit.
        if (claims.length > MAX_BATCH_SIZE) return { json: async () => ({ error: `Maximum ${MAX_BATCH_SIZE} claims per request` }) }
        return { json: async () => ({ results: claims.map(c => ({ ...c, verified: true, cached: false })) }) }
      }
      throw new Error(`unexpected fetch ${url}`)
    },
  }
  return { env, statuses, rendered, verifyBatches }
}

describe('landing page "Look up someone"', () => {
  it('shows the results for a profile that has linked accounts, with its NIP-05 check', async () => {
    const doLookup = await loadDoLookup()
    const h = harness({ iTags: [iTag('github', 'octocat', 'abc123')], nip05: 'alice@divine.video' })

    await doLookup(h.env)()

    expect(h.statuses.filter(([, type]) => type === 'error')).toEqual([])
    expect(h.rendered).toHaveLength(1)
    expect(h.rendered[0]).toEqual([
      expect.objectContaining({ platform: 'nip05', identity: 'alice@divine.video', verified: true }),
      expect.objectContaining({ platform: 'github', identity: 'octocat', verified: true }),
    ])
  })

  it('checks a profile with more linked accounts than one request allows, in batches the server accepts', async () => {
    const doLookup = await loadDoLookup()
    const tags = Array.from({ length: MAX_BATCH_SIZE + 2 }, (_, i) => iTag('github', `user${i}`, `proof${i}`))
    const h = harness({ iTags: tags })

    await doLookup(h.env)()

    expect(h.statuses.filter(([, type]) => type === 'error')).toEqual([])
    expect(h.verifyBatches).toEqual([MAX_BATCH_SIZE, 2])
    expect(h.rendered[0]).toHaveLength(MAX_BATCH_SIZE + 2)
  })

  it('keeps looking for the kind 0 profile on other relays, so the NIP-05 is not dropped', async () => {
    const doLookup = await loadDoLookup()
    const h = harness({
      iTags: [iTag('github', 'octocat', 'abc123')],
      nip05: 'alice@divine.video',
      relays: ['wss://r1.example', 'wss://r2.example'],
      kind0OnlyOn: 'wss://r2.example',
    })

    await doLookup(h.env)()

    expect(h.rendered[0]).toEqual([
      expect.objectContaining({ platform: 'nip05', identity: 'alice@divine.video' }),
      expect.objectContaining({ platform: 'github', identity: 'octocat', verified: true }),
    ])
  })

  it('still shows the verified accounts when the NIP-05 check itself fails', async () => {
    const doLookup = await loadDoLookup()
    const h = harness({ iTags: [iTag('github', 'octocat', 'abc123')], nip05: 'alice@divine.video', nip05Breaks: true })

    await doLookup(h.env)()

    expect(h.statuses.filter(([, type]) => type === 'error')).toEqual([])
    expect(h.rendered[0]).toEqual([
      expect.objectContaining({ platform: 'nip05', identity: 'alice@divine.video', verified: false }),
      expect.objectContaining({ platform: 'github', identity: 'octocat', verified: true }),
    ])
  })

  it('still shows the linked accounts when no relay has a kind 0 profile', async () => {
    const doLookup = await loadDoLookup()
    const h = harness({
      iTags: [iTag('github', 'octocat', 'abc123')],
      relays: ['wss://r1.example', 'wss://r2.example'],
      noKind0: true,
    })

    await doLookup(h.env)()

    expect(h.statuses.filter(([, type]) => type === 'error')).toEqual([])
    expect(h.rendered[0]).toEqual([
      expect.objectContaining({ platform: 'github', identity: 'octocat', verified: true }),
    ])
  })
})

describe('landing page batch size', () => {
  it('comes from the server\'s MAX_BATCH_SIZE, not a copy of the number', async () => {
    vi.resetModules()
    vi.doMock('./routes/verify', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./routes/verify')>()),
      MAX_BATCH_SIZE: 3,
    }))
    try {
      const { default: freshWorker } = await import('./index')
      const html = await (await freshWorker.fetch(new Request(`${API}/`), {} as never)).text()
      expect(html).toContain('const VERIFY_BATCH_SIZE = 3;')
    } finally {
      vi.doUnmock('./routes/verify')
      vi.resetModules()
    }
  })
})
