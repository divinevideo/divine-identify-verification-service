import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_startWorker } from 'wrangler'
import { NOSTR_TOOLS_MODULE_PATH } from '../src/generated/vendor.ts'

// The landing page loads its nostr-tools code from public/vendor/nostr-tools.mjs,
// built by scripts/build-browser-vendor.mjs and committed. These tests run the
// committed file itself, the check CI runs on it, and the worker serving it.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MODULE_FILE = join(ROOT, 'public/vendor/nostr-tools.mjs')
const SCRIPT = join(ROOT, 'scripts/build-browser-vendor.mjs')

const SECRET_KEY = new Uint8Array(32).fill(7)
const PUBKEY = bytesToHex(schnorr.getPublicKey(SECRET_KEY))

// A new object on every call: verifyEvent remembers on the event object that it
// passed, so a changed copy of an already checked event would skip the check.
function signedEvent(overrides = {}) {
  const unsigned = { kind: 10011, created_at: 1_700_000_000, tags: [['i', 'github:octocat', 'abc123']], content: '', pubkey: PUBKEY }
  const id = createHash('sha256')
    .update(JSON.stringify([0, unsigned.pubkey, unsigned.created_at, unsigned.kind, unsigned.tags, unsigned.content]))
    .digest('hex')
  const sig = bytesToHex(schnorr.sign(Buffer.from(id, 'hex'), SECRET_KEY))
  return { ...unsigned, id, sig, ...overrides }
}

describe('the built nostr-tools module', () => {
  let tools
  beforeAll(async () => {
    tools = await import(pathToFileURL(MODULE_FILE).href)
  })

  it('exports only what the page uses', () => {
    expect(Object.keys(tools).sort()).toEqual(['nip46', 'pool', 'pure'])
    expect(Object.keys(tools.nip46).sort()).toEqual(['BunkerSigner', 'createNostrConnectURI', 'parseBunkerInput'])
    expect(Object.keys(tools.pool)).toEqual(['SimplePool'])
    expect(Object.keys(tools.pure).sort()).toEqual(['generateSecretKey', 'getPublicKey', 'verifyEvent'])
    expect(typeof tools.nip46.BunkerSigner.fromBunker).toBe('function')
    expect(typeof tools.nip46.BunkerSigner.fromURI).toBe('function')
  })

  it('accepts a correctly signed event and rejects a changed or wrongly signed one', () => {
    const { verifyEvent } = tools.pure
    expect(verifyEvent(signedEvent())).toBe(true)
    expect(verifyEvent(signedEvent({ content: 'changed' }))).toBe(false)
    expect(verifyEvent(signedEvent({ sig: 'aa'.repeat(64) }))).toBe(false)
  })

  it('derives the public key the same way the worker\'s signature library does', () => {
    expect(tools.pure.getPublicKey(SECRET_KEY)).toBe(PUBKEY)
  })

  it('makes a Nostr Connect address the page can show', () => {
    const uri = tools.nip46.createNostrConnectURI({
      clientPubkey: PUBKEY,
      relays: ['wss://relay.example'],
      secret: 'shh',
      perms: ['get_public_key', 'sign_event'],
      name: 'Divine Verification',
      url: 'https://verifier.divine.video',
    })
    expect(uri.startsWith(`nostrconnect://${PUBKEY}?`)).toBe(true)
    expect(new URL(uri).searchParams.get('secret')).toBe('shh')
  })

  it('is loaded from an address that changes whenever the file does', async () => {
    const hash = createHash('sha256').update(await readFile(MODULE_FILE)).digest('hex')
    expect(NOSTR_TOOLS_MODULE_PATH).toBe(`/vendor/nostr-tools.mjs?v=${hash.slice(0, 12)}`)
  })
})

describe('checking the committed build', () => {
  const run = promisify(execFile)
  let copy

  // A copy of the committed files, so a test can change one without touching the repo.
  beforeAll(async () => {
    copy = await mkdtemp(join(tmpdir(), 'vendor-check-'))
    await cp(join(ROOT, 'public'), join(copy, 'public'), { recursive: true })
    await cp(join(ROOT, 'src/generated'), join(copy, 'src/generated'), { recursive: true })
  })
  afterAll(async () => {
    await rm(copy, { recursive: true, force: true })
  })

  it('passes when the committed files match a fresh build', async () => {
    await expect(run(process.execPath, [SCRIPT, '--check'], { cwd: ROOT })).resolves.toBeDefined()
  })

  it('fails when the committed module differs from a fresh build', async () => {
    const file = join(copy, 'public/vendor/nostr-tools.mjs')
    const original = await readFile(file, 'utf8')
    await writeFile(file, `${original} `)
    try {
      await expect(run(process.execPath, [SCRIPT, '--check', '--root', copy])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('public/vendor/nostr-tools.mjs'),
      })
    } finally {
      await writeFile(file, original)
    }
    await expect(run(process.execPath, [SCRIPT, '--check', '--root', copy])).resolves.toBeDefined()
  })

  it('fails when the committed address differs from a fresh build', async () => {
    const file = join(copy, 'src/generated/vendor.ts')
    const original = await readFile(file, 'utf8')
    await writeFile(file, original.replace(/\?v=[0-9a-f]{12}/, '?v=000000000000'))
    try {
      await expect(run(process.execPath, [SCRIPT, '--check', '--root', copy])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('src/generated/vendor.ts'),
      })
    } finally {
      await writeFile(file, original)
    }
  })
})

describe('files the worker serves as they are', () => {
  it('are only the ones listed here', async () => {
    const dir = join(ROOT, 'public')
    const entries = await readdir(dir, { recursive: true, withFileTypes: true })
    const files = entries
      // Symlinks count: the worker serves them too.
      .filter(entry => !entry.isDirectory())
      .map(entry => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
      .sort()
    expect(files, 'A file in public/ is served ahead of the worker\'s routes: public/index.html would replace the landing page. Add one only on purpose, then add it here.')
      .toEqual(['_headers', 'vendor/nostr-tools.mjs'])
  })
})

describe('serving the module', () => {
  let worker
  beforeAll(async () => {
    worker = await unstable_startWorker({
      config: join(ROOT, 'wrangler.toml'),
      dev: { server: { port: 0 }, inspector: false, logLevel: 'none' },
    })
    await worker.ready
  }, 30_000)
  afterAll(async () => {
    await worker?.dispose()
  })

  it('serves the committed file as JavaScript, cached for good, at the page\'s address and at a retry address', async () => {
    const committed = await readFile(MODULE_FILE, 'utf8')
    for (const address of [NOSTR_TOOLS_MODULE_PATH, `${NOSTR_TOOLS_MODULE_PATH}&retry=1`]) {
      const res = await worker.fetch(`http://localhost${address}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/^text\/javascript\b/)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(await res.text()).toBe(committed)
    }
  })

  it('has every nostr-tools function the landing page calls', async () => {
    const html = await (await worker.fetch('http://localhost/', { headers: { accept: 'text/html' } })).text()
    const tools = await import(pathToFileURL(MODULE_FILE).href)
    const called = [...new Set([...html.matchAll(/\.(nip46|pure)\.(\w+)/g)].map(m => m[0].slice(1)))]
    expect(called.length).toBeGreaterThan(0)
    for (const name of called) {
      const [group, fn] = name.split('.')
      expect(tools[group]?.[fn], name).toBeDefined()
    }
  })

  it('still answers the landing page from the worker', async () => {
    const res = await worker.fetch('http://localhost/', { headers: { accept: 'text/html' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(NOSTR_TOOLS_MODULE_PATH)
  })
})
