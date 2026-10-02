import { describe, it, expect } from 'vitest'
import { verifyEventSignature } from './nostr-event'

// Known test vector: signed by nostr-tools 2.25.2 (finalizeEvent) with a
// synthetic key, not by this repo's code, and its id re-derived with Python's
// json/hashlib. The route tests sign ASCII-only events with their own copy of
// the serialization verifyEventSignature uses, so they cannot show that it
// matches what real signers produce. The content and the `t` tag cover JSON
// escapes and multi-byte UTF-8.
const event = {
  kind: 27235,
  created_at: 1790000000,
  tags: [
    ['u', 'https://verifier.divine.video/auth/oauth/revoke'],
    ['method', 'POST'],
    ['t', 'café 🙂'],
  ],
  content: 'line one\nshe said "hi" \\ tab\there é ü 🙂',
  pubkey: '4224c977a4248a2ce54b93f77b476e3d15bfd7e9302d395ab7661cad9e40c6df',
  id: 'a68c0a09e2f36ea7507ddedd464b46da0844aae816364108fa209e29bd5ad1d9',
  sig: 'a45643bbc7ceeef77a56189bca839b98d6cd7c5a1c1e0c367760d5bbc8be27dafb4b970119c1de54db4aa8948cbfe26dea8c485230fececa2c276c36869bc3f7',
}

describe('verifyEventSignature', () => {
  it('accepts an event signed by an independent Nostr implementation', async () => {
    expect(await verifyEventSignature(event)).toEqual({ ok: true })
  })

  it('rejects the event once its content no longer matches its id', async () => {
    expect(await verifyEventSignature({ ...event, content: 'line one' })).toEqual({ ok: false, reason: 'id' })
  })

  it('rejects the event once its signature is altered', async () => {
    const sig = event.sig.slice(0, -1) + (event.sig.endsWith('0') ? '1' : '0')
    expect(await verifyEventSignature({ ...event, sig })).toEqual({ ok: false, reason: 'signature' })
  })

  it('rejects an uppercase id as a format error rather than normalizing it', async () => {
    expect(await verifyEventSignature({ ...event, id: event.id.toUpperCase() })).toEqual({ ok: false, reason: 'format' })
  })
})
