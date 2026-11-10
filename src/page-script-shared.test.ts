import { describe, expect, it } from 'vitest'
import { bech32, hex } from '@scure/base'
import worker from './index'
import { SHARED_PAGE_SCRIPT } from './page-script-shared'

const PUBKEY = 'ab'.repeat(32)
const page = async (path: string) => (await worker.fetch(new Request(`https://verifier.divine.video${path}`), {} as never)).text()
const load = () => new Function('document', `${SHARED_PAGE_SCRIPT}\nreturn { DIVINE_RELAY, PROFILE_RELAYS, npubToHex, setStatus, clearStatus };`)({ getElementById: () => null })

describe('the helpers both pages share', () => {
  it('decode an npub to its hex public key', () => {
    expect(load().npubToHex(bech32.encode('npub', bech32.toWords(hex.decode(PUBKEY))))).toBe(PUBKEY)
  })
  it('read Divine\'s relay first', () => {
    const { DIVINE_RELAY, PROFILE_RELAYS } = load()
    expect(PROFILE_RELAYS).toEqual(['wss://relay.divine.video', 'wss://relay.damus.io', 'wss://relay.primal.net'])
    expect(DIVINE_RELAY).toBe(PROFILE_RELAYS[0])
  })
  it.each(['/'])('are on %s exactly once', async (path) => {
    const html = await page(path)
    expect(html.split(SHARED_PAGE_SCRIPT).length - 1).toBe(1)
    expect(html.split('function npubToHex(').length - 1).toBe(1)
  })
})
