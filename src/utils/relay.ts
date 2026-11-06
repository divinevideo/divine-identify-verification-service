// ABOUTME: Reads events from a Nostr relay over a WebSocket opened through global fetch.
// ABOUTME: One REQ, collect until EOSE, then close; any failure before EOSE rejects.

export const RELAY_TIMEOUT_MS = 4000
// A person's signed lists are a handful of events; more than this is a relay misbehaving.
export const MAX_RELAY_EVENTS = 50

export type RelayFilter = Record<string, unknown>

/**
 * Asks one relay for the events matching `filters` and resolves with them at
 * EOSE. Rejects on CLOSED, a close or error before EOSE, an upgrade that did
 * not produce a socket, or the timeout. Never throws synchronously.
 *
 * The socket is opened with fetch and an Upgrade header, which is how Workers
 * make outbound WebSockets, so every request stays on global fetch.
 */
export function queryRelay(
  relayUrl: string,
  filters: RelayFilter[],
  timeoutMs: number = RELAY_TIMEOUT_MS,
): Promise<unknown[]> {
  return new Promise<unknown[]>((resolve, reject) => {
    const subId = crypto.randomUUID()
    const events: unknown[] = []
    const abort = new AbortController()
    let socket: WebSocket | null = null
    let settled = false

    // One clock covers the upgrade and the read, so a relay that never answers
    // the upgrade can't hold the request past the timeout.
    const timer = setTimeout(() => fail(`Relay timed out after ${timeoutMs}ms`), timeoutMs)

    const settle = (done: () => void) => {
      settled = true
      clearTimeout(timer)
      abort.abort()
      try { socket?.close() } catch { /* already closed */ }
      done()
    }
    function fail(message: string) {
      if (!settled) settle(() => reject(new Error(message)))
    }
    // CLOSE goes before the socket closes; a failure to send it doesn't change the answer.
    const finish = () => {
      if (settled) return
      try { socket?.send(JSON.stringify(['CLOSE', subId])) } catch { /* answer is in hand */ }
      settle(() => resolve(events))
    }

    let upgrade: Promise<Response>
    try {
      upgrade = fetch(relayUrl.replace(/^wss:/, 'https:'), {
        headers: { Upgrade: 'websocket' },
        signal: abort.signal,
      })
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'Relay request failed')
    }

    upgrade.then((response) => {
      if (settled) {
        // The answer is already given, but a socket that arrives late is still open.
        try {
          const late = response.webSocket
          if (late) {
            late.accept()
            late.close()
          }
        } catch { /* nothing more to free */ }
        return
      }
      const ws = response.status === 101 ? response.webSocket : null
      if (!ws) return fail(`Relay did not upgrade to a WebSocket (status ${response.status})`)
      socket = ws

      ws.addEventListener('message', (event) => {
        if (settled || typeof event.data !== 'string') return
        let frame: unknown
        try { frame = JSON.parse(event.data) } catch { return }
        if (!Array.isArray(frame) || frame[1] !== subId) return

        if (frame[0] === 'EVENT') {
          events.push(frame[2])
          // Past the cap the relay is misbehaving; take what we have rather than wait for EOSE.
          if (events.length >= MAX_RELAY_EVENTS) finish()
        } else if (frame[0] === 'EOSE') {
          finish()
        } else if (frame[0] === 'CLOSED') {
          fail(`Relay closed the subscription: ${String(frame[2] ?? '')}`)
        }
      })
      ws.addEventListener('close', () => fail('Relay closed the connection before EOSE'))
      ws.addEventListener('error', () => fail('Relay connection error'))

      try {
        ws.accept()
        ws.send(JSON.stringify(['REQ', subId, ...filters]))
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Relay send failed')
      }
    }, (err) => fail(err instanceof Error ? err.message : 'Relay request failed'))
  })
}
