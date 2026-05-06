import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  ALLOWED_PARENT_HOSTS,
  ALLOWED_PARENT_SUFFIXES,
  EMBED_BRIDGE_SCRIPT,
} from './embed-bridge'

// Minimal fake window/document/parent that the bridge IIFE expects to find.
// We evaluate the bridge source string inside a freshly-built sandbox per test
// so we don't pollute Node's globals.
type Listener = (event: { origin: string; data: unknown }) => void

interface FakeWindow {
  parent: FakeWindow | unknown
  addEventListener: (type: string, listener: Listener) => void
  // Not all of NIP-07 is asserted, but the shim sets these on success.
  nostr?: {
    getPublicKey: () => Promise<string>
    signEvent: (event: unknown) => Promise<unknown>
    getRelays: () => Promise<unknown>
  }
  __divineEmbedded?: boolean
  __divineParentOrigin?: string
  // Captured by the bridge for postMessage.
  postedMessages: Array<{ message: unknown; targetOrigin: string }>
  messageListener?: Listener
}

interface SandboxOptions {
  framed: boolean
  referrer: string
}

function buildSandbox(opts: SandboxOptions): {
  window: FakeWindow
  evalBridge: () => void
} {
  const win: FakeWindow = {
    // When framed: parent is a different object; when not framed: parent === window.
    parent: undefined,
    postedMessages: [],
    addEventListener(type, listener) {
      if (type === 'message') win.messageListener = listener
    },
  }
  win.parent = opts.framed
    ? {
        postMessage: (message: unknown, targetOrigin: string) => {
          win.postedMessages.push({ message, targetOrigin })
        },
      }
    : win

  const fakeDocument = { referrer: opts.referrer }

  // Use the real URL constructor inside the bridge — Node provides it.
  const sandbox = {
    window: win,
    document: fakeDocument,
    URL,
    Map,
    Promise,
    Error,
    setTimeout,
    Object,
  }

  const evalBridge = () => {
    const fn = new Function(
      ...Object.keys(sandbox),
      EMBED_BRIDGE_SCRIPT,
    )
    fn(...Object.values(sandbox))
  }

  return { window: win, evalBridge }
}

describe('embed bridge', () => {
  describe('shim installation', () => {
    it('does NOT install when window.parent === window (top-level page)', () => {
      const { window, evalBridge } = buildSandbox({
        framed: false,
        referrer: 'https://divine.video/profile',
      })
      evalBridge()
      expect(window.nostr).toBeUndefined()
      expect(window.__divineEmbedded).toBeUndefined()
    })

    it('does NOT install when referrer is empty', () => {
      const { window, evalBridge } = buildSandbox({
        framed: true,
        referrer: '',
      })
      evalBridge()
      expect(window.nostr).toBeUndefined()
    })

    it('does NOT install when referrer is an unknown origin', () => {
      const { window, evalBridge } = buildSandbox({
        framed: true,
        referrer: 'https://evil.example.com/',
      })
      evalBridge()
      expect(window.nostr).toBeUndefined()
    })

    it('does NOT install when referrer is malformed', () => {
      const { window, evalBridge } = buildSandbox({
        framed: true,
        referrer: 'not-a-url',
      })
      evalBridge()
      expect(window.nostr).toBeUndefined()
    })

    it('installs when referrer is divine.video', () => {
      const { window, evalBridge } = buildSandbox({
        framed: true,
        referrer: 'https://divine.video/edit-profile',
      })
      evalBridge()
      expect(window.nostr).toBeDefined()
      expect(window.__divineEmbedded).toBe(true)
      expect(window.__divineParentOrigin).toBe('https://divine.video')
    })

    it('installs for *.divine.video subdomain referrer', () => {
      const { window, evalBridge } = buildSandbox({
        framed: true,
        referrer: 'https://staging.divine.video/edit-profile',
      })
      evalBridge()
      expect(window.nostr).toBeDefined()
      expect(window.__divineParentOrigin).toBe('https://staging.divine.video')
    })

    it('installs for Cloudflare Pages preview referrer (*.pages.dev)', () => {
      const { window, evalBridge } = buildSandbox({
        framed: true,
        referrer: 'https://abcd1234.divine-mobile.pages.dev/edit-profile',
      })
      evalBridge()
      expect(window.nostr).toBeDefined()
      expect(window.__divineParentOrigin).toBe(
        'https://abcd1234.divine-mobile.pages.dev',
      )
    })

    it('installs for localhost referrer (dev)', () => {
      const { window, evalBridge } = buildSandbox({
        framed: true,
        referrer: 'http://localhost:5173/edit-profile',
      })
      evalBridge()
      expect(window.nostr).toBeDefined()
      expect(window.__divineParentOrigin).toBe('http://localhost:5173')
    })
  })

  describe('postMessage protocol', () => {
    function setup() {
      const sandbox = buildSandbox({
        framed: true,
        referrer: 'https://divine.video/edit-profile',
      })
      sandbox.evalBridge()
      return sandbox
    }

    it('signEvent posts a divine:nostr.request to the parent and resolves on response', async () => {
      const { window } = setup()
      const unsignedEvent = { kind: 0, content: '{}', tags: [], created_at: 0, pubkey: 'a'.repeat(64) }
      const signed = { ...unsignedEvent, id: 'x'.repeat(64), sig: 's'.repeat(128) }

      const promise = window.nostr!.signEvent(unsignedEvent)

      expect(window.postedMessages).toHaveLength(1)
      const posted = window.postedMessages[0]
      expect(posted.targetOrigin).toBe('https://divine.video')
      expect(posted.message).toMatchObject({
        type: 'divine:nostr.request',
        method: 'signEvent',
        params: { event: unsignedEvent },
      })
      const requestId = (posted.message as { id: number }).id
      expect(typeof requestId).toBe('number')

      // Simulate the parent replying with the signed event.
      window.messageListener!({
        origin: 'https://divine.video',
        data: { type: 'divine:nostr.response', id: requestId, result: signed },
      })

      await expect(promise).resolves.toEqual(signed)
    })

    it('rejects when the parent replies with an error', async () => {
      const { window } = setup()
      const promise = window.nostr!.signEvent({ kind: 0 })

      const id = (window.postedMessages[0].message as { id: number }).id
      window.messageListener!({
        origin: 'https://divine.video',
        data: { type: 'divine:nostr.response', id, error: 'user rejected' },
      })

      await expect(promise).rejects.toThrow('user rejected')
    })

    it('ignores responses from other origins', async () => {
      vi.useFakeTimers()
      try {
        const { window } = setup()
        const promise = window.nostr!.signEvent({ kind: 0 })
        const id = (window.postedMessages[0].message as { id: number }).id

        // Reply from an unexpected origin — must be ignored.
        window.messageListener!({
          origin: 'https://evil.example.com',
          data: { type: 'divine:nostr.response', id, result: { sneaky: true } },
        })

        // The promise should still be unresolved; advance to the timeout.
        vi.advanceTimersByTime(60_001)
        await expect(promise).rejects.toThrow(
          'divine.video parent did not respond',
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it('ignores responses with mismatched correlation id', async () => {
      vi.useFakeTimers()
      try {
        const { window } = setup()
        const promise = window.nostr!.signEvent({ kind: 0 })
        const id = (window.postedMessages[0].message as { id: number }).id

        // Reply with a different id — must be ignored.
        window.messageListener!({
          origin: 'https://divine.video',
          data: {
            type: 'divine:nostr.response',
            id: id + 999,
            result: { stale: true },
          },
        })

        vi.advanceTimersByTime(60_001)
        await expect(promise).rejects.toThrow(
          'divine.video parent did not respond',
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it('getPublicKey posts a getPublicKey request', async () => {
      const { window } = setup()
      const promise = window.nostr!.getPublicKey()
      const posted = window.postedMessages[0].message as {
        method: string
        id: number
      }
      expect(posted.method).toBe('getPublicKey')
      window.messageListener!({
        origin: 'https://divine.video',
        data: {
          type: 'divine:nostr.response',
          id: posted.id,
          result: 'b'.repeat(64),
        },
      })
      await expect(promise).resolves.toBe('b'.repeat(64))
    })

    it('uses unique request ids across concurrent calls', async () => {
      const { window } = setup()
      const p1 = window.nostr!.getPublicKey()
      const p2 = window.nostr!.signEvent({ kind: 0 })
      const id1 = (window.postedMessages[0].message as { id: number }).id
      const id2 = (window.postedMessages[1].message as { id: number }).id
      expect(id1).not.toBe(id2)

      // Resolve them out of order — both must complete correctly.
      window.messageListener!({
        origin: 'https://divine.video',
        data: { type: 'divine:nostr.response', id: id2, result: { signed: true } },
      })
      window.messageListener!({
        origin: 'https://divine.video',
        data: { type: 'divine:nostr.response', id: id1, result: 'pubkey' },
      })
      await expect(p1).resolves.toBe('pubkey')
      await expect(p2).resolves.toEqual({ signed: true })
    })
  })

  describe('configuration', () => {
    it('exports a non-empty allowlist of parent hosts', () => {
      expect(ALLOWED_PARENT_HOSTS).toContain('divine.video')
      expect(ALLOWED_PARENT_HOSTS.length).toBeGreaterThan(0)
    })

    it('exports the divine.video and pages.dev suffixes', () => {
      expect(ALLOWED_PARENT_SUFFIXES).toContain('.divine.video')
      expect(ALLOWED_PARENT_SUFFIXES).toContain('.pages.dev')
    })
  })
})
