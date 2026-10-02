import { describe, expect, it } from 'vitest'
import worker from './index'

const API = 'https://verifier.divine.video'

// Runs the page's real "Verify this link" handler against stand-ins for the
// browser, so the test exercises the shipped script rather than a copy of it.
async function loadVerifySingleHere() {
  const html = await (await worker.fetch(new Request(`${API}/`), {} as never)).text()
  const start = html.indexOf('async function verifySingleHere()')
  const end = html.indexOf('function publishEventToRelay(', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const deps = ['document', 'fetch', 'API', 'getActivePubkey', 'setAccountInputValue', 'normalizeProofInputs', 'setStatus', 'clearStatus', 'setButtonLoading']
  return (env: Record<string, unknown>) =>
    new Function(...deps, `${html.slice(start, end)}\nreturn verifySingleHere;`)(...deps.map(d => env[d]))
}

function harness(response: Record<string, unknown>, proof: string, editDuringRequest?: string) {
  const statuses: string[] = []
  const fields: Record<string, { value?: string, style?: Record<string, string>, textContent?: string }> = {
    'proof-result': { style: {} },
    'proof-platform-select': { value: 'tiktok' },
    'proof-identity-input': { value: 'testuser' },
    'proof-proof-input': { value: proof },
  }
  const env: Record<string, unknown> = {
    API,
    document: { getElementById: (id: string) => fields[id] },
    fetch: async () => {
      if (editDuringRequest !== undefined) fields['proof-proof-input'].value = editDuringRequest
      return { ok: true, json: async () => response }
    },
    getActivePubkey: async () => 'a'.repeat(64),
    setAccountInputValue: () => {},
    normalizeProofInputs: (_platform: string, identity: string, p: string) => ({ identity, proof: p }),
    setStatus: (_id: string, msg: string) => { statuses.push(msg) },
    clearStatus: () => {},
    setButtonLoading: () => {},
  }
  return { env, fields, statuses }
}

describe('Verify this link', () => {
  it('fills in the post number the verifier reports, so Publish uses it', async () => {
    const load = await loadVerifySingleHere()
    const h = harness({ verified: true, canonical_proof: '7123456789012345678' }, 'https://vm.tiktok.com/ZMabc123/')
    await load(h.env)()
    expect(h.fields['proof-proof-input'].value).toBe('7123456789012345678')
  })

  it('says it will publish the post number', async () => {
    const load = await loadVerifySingleHere()
    const h = harness({ verified: true, canonical_proof: '7123456789012345678' }, 'https://vm.tiktok.com/ZMabc123/')
    await load(h.env)()
    expect(h.statuses[h.statuses.length - 1]).toBe('Success. This account is verified. Publishing will use the post number.')
  })

  it('does not overwrite a proof the person changed while the check ran', async () => {
    const load = await loadVerifySingleHere()
    const h = harness({ verified: true, canonical_proof: '7123456789012345678' }, 'https://vm.tiktok.com/ZMabc123/', 'https://vm.tiktok.com/ZMother9/')
    await load(h.env)()
    expect(h.fields['proof-proof-input'].value).toBe('https://vm.tiktok.com/ZMother9/')
  })

  it('leaves the proof alone when verification fails', async () => {
    const load = await loadVerifySingleHere()
    const h = harness({ verified: false, error: 'npub not found in video caption', canonical_proof: '7123456789012345678' }, 'https://vm.tiktok.com/ZMabc123/')
    await load(h.env)()
    expect(h.fields['proof-proof-input'].value).toBe('https://vm.tiktok.com/ZMabc123/')
  })

  it('leaves the proof alone when the verifier reports nothing to replace it with', async () => {
    const load = await loadVerifySingleHere()
    const h = harness({ verified: true }, '7123456789012345678')
    await load(h.env)()
    expect(h.fields['proof-proof-input'].value).toBe('7123456789012345678')
  })

  it('ignores a replacement that is not text', async () => {
    const load = await loadVerifySingleHere()
    const h = harness({ verified: true, canonical_proof: 7123456789012345 }, 'https://vm.tiktok.com/ZMabc123/')
    await load(h.env)()
    expect(h.fields['proof-proof-input'].value).toBe('https://vm.tiktok.com/ZMabc123/')
  })
})
