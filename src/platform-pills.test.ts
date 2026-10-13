import { describe, expect, it } from 'vitest'
import worker from './index'

// Runs the page's real platform-pill code (the click handler and the line that
// wires it to every pill) against stand-ins for the browser, so the test
// exercises the shipped script rather than a copy of it.
async function loadPillScript() {
  const html = await (await worker.fetch(new Request('https://verifier.divine.video/'), {} as never)).text()
  const start = html.indexOf('function pickPlatformFromPill(')
  const end = html.indexOf('// Verify Here wiring', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const deps = ['document', 'updateOAuthInputs', 'updateProofInputs', 'setTimeout']
  return (env: Record<string, unknown>) =>
    new Function(...deps, html.slice(start, end))(...deps.map(d => env[d]))
}

type Pill = { dataset: { platform: string }, getAttribute: (name: string) => string | null, addEventListener: (type: string, fn: () => void) => void, click: () => void }

function harness() {
  const updated: string[] = []
  // Work queued for after the click, when the browser has followed the link.
  const later: Array<() => void> = []
  const focused: Array<[string, unknown]> = []
  const field = (id: string) => ({ value: '', focus: (opts: unknown) => { focused.push([id, opts]) } })
  const fields: Record<string, { value: string, focus: (opts: unknown) => void }> = Object.fromEntries(
    ['oauth-platform-select', 'oauth-bluesky-handle-input', 'oauth-start-btn', 'proof-platform-select', 'proof-identity-input'].map(id => [id, field(id)]),
  )
  const pill = (platform: string, target: string): Pill => {
    const listeners: Array<() => void> = []
    return {
      dataset: { platform },
      getAttribute: (name: string) => (name === 'href' ? '#' + target : null),
      addEventListener: (type: string, fn: () => void) => { if (type === 'click') listeners.push(fn) },
      click: () => listeners.forEach(fn => fn()),
    }
  }
  const pills = [pill('github', 'link-with-post'), pill('bluesky', 'quick-connect'), pill('twitter', 'quick-connect')]
  const env = {
    document: {
      getElementById: (id: string) => fields[id] ?? null,
      querySelectorAll: (selector: string) => (selector === '.platform-pill' ? pills : []),
    },
    updateOAuthInputs: () => { updated.push('oauth:' + fields['oauth-platform-select'].value) },
    updateProofInputs: () => { updated.push('proof:' + fields['proof-platform-select'].value) },
    setTimeout: (fn: () => void) => { later.push(fn) },
  }
  const followLink = () => later.splice(0).forEach(fn => fn())
  return { env, fields, pills, updated, focused, followLink }
}

describe('platform pills', () => {
  it('picks the platform in the post form and gets that form ready to fill in', async () => {
    const h = harness()
    ;(await loadPillScript())(h.env)
    h.pills[0].click()
    h.followLink()
    expect(h.fields['proof-platform-select'].value).toBe('github')
    expect(h.fields['oauth-platform-select'].value).toBe('')
    expect(h.updated).toEqual(['proof:github'])
    expect(h.focused).toEqual([['proof-identity-input', { preventScroll: true }]])
  })

  it('picks Bluesky in Quick Connect and goes to the handle field', async () => {
    const h = harness()
    ;(await loadPillScript())(h.env)
    h.pills[1].click()
    h.followLink()
    expect(h.fields['oauth-platform-select'].value).toBe('bluesky')
    expect(h.fields['proof-platform-select'].value).toBe('')
    expect(h.updated).toEqual(['oauth:bluesky'])
    expect(h.focused).toEqual([['oauth-bluesky-handle-input', { preventScroll: true }]])
  })

  it('goes to the sign-in button for a Quick Connect platform that needs no handle', async () => {
    const h = harness()
    ;(await loadPillScript())(h.env)
    h.pills[2].click()
    h.followLink()
    expect(h.fields['oauth-platform-select'].value).toBe('twitter')
    expect(h.updated).toEqual(['oauth:twitter'])
    expect(h.focused).toEqual([['oauth-start-btn', { preventScroll: true }]])
  })

  // The browser's jump to the card runs after the click handler and takes
  // focus away, so focusing during the click would be undone.
  it('waits for the jump to the card before focusing the first field', async () => {
    const h = harness()
    ;(await loadPillScript())(h.env)
    h.pills[0].click()
    expect(h.fields['proof-platform-select'].value).toBe('github')
    expect(h.focused).toEqual([])
    h.followLink()
    expect(h.focused).toEqual([['proof-identity-input', { preventScroll: true }]])
  })
})
