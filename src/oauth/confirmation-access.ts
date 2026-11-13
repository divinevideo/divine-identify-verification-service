// ABOUTME: Asks the Divine Confirmation access service whether a pubkey has access, with a short KV cache.
// ABOUTME: The service's answer is untrusted: anything but a clear boolean is "unavailable", never "yes".
import type { Bindings } from '../types'
import { discardBody, readJson } from '../platforms/base'
import { isConfirmationTester } from './confirmation-gate'

export type ConfirmationAccess = 'yes' | 'no' | 'unavailable'

export const CONFIRMATION_ACCESS_YES_TTL_SECONDS = 300
export const CONFIRMATION_ACCESS_NO_TTL_SECONDS = 60
export const CONFIRMATION_ACCESS_TIMEOUT_MS = 3000

export function confirmationAccessKey(pubkey: string): string {
  return `confirmation_access:${pubkey}`
}

/** The only place the access service's response is parsed. Only a JSON object with a boolean isActive is an answer. */
export function readAccessAnswer(body: unknown): 'yes' | 'no' | null {
  // TODO(#159): match the final access contract once divine-supporters defines the Confirmation product.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const isActive = (body as { isActive?: unknown }).isActive
  if (isActive === true) return 'yes'
  if (isActive === false) return 'no'
  return null
}

// One fixed-reason line per unavailable answer. The reason never carries the
// pubkey, the access URL or the token.
function unavailable(reason: string): ConfirmationAccess {
  console.warn(`Confirmation access check unavailable: ${reason}`)
  return 'unavailable'
}

// Secrets set from the CLI often carry a trailing newline; query strings,
// fragments or credentials would deform `${base}/${pubkey}` or put secrets in a URL.
function configuredAccessUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed.includes('?') || trimmed.includes('#')) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
    return null
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

function configuredAccessToken(raw: string | undefined): string | null {
  const trimmed = raw?.trim()
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return null
  return trimmed
}

/** Whether this pubkey has Divine Confirmation access. Cached yes 300 s and no 60 s; unavailable is never cached. */
export async function confirmationAccess(env: Bindings, pubkey: string): Promise<ConfirmationAccess> {
  // The service accepts only lowercase hex, so anything else has no access.
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return 'no'
  if (isConfirmationTester(env, pubkey)) return 'yes'

  const base = configuredAccessUrl(env.CONFIRMATION_ACCESS_URL)
  const token = configuredAccessToken(env.CONFIRMATION_ACCESS_TOKEN)
  if (!base || !token) return unavailable('not configured')

  const key = confirmationAccessKey(pubkey)
  try {
    const cached = await env.CACHE_KV.get(key)
    if (cached === 'yes' || cached === 'no') return cached
  } catch {
    // A failed cache read is a miss: ask the service.
  }

  let res: Response
  try {
    res = await fetch(`${base}/${pubkey}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      // Never follow a redirect: the bearer token must not leave the configured host.
      redirect: 'manual',
      signal: AbortSignal.timeout(CONFIRMATION_ACCESS_TIMEOUT_MS),
    })
  } catch (err) {
    return unavailable(err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network error')
  }
  if (res.status !== 200) {
    await discardBody(res)
    return unavailable(`status ${res.status}`)
  }

  // readJson caps the body; an oversized or unparseable body is undefined, and
  // a body that stops arriving throws. Either way: no answer, never "yes".
  let body: unknown
  try {
    body = await readJson<unknown>(res, 'confirmation access service')
  } catch {
    return unavailable('body unreadable')
  }
  const answer = readAccessAnswer(body)
  if (!answer) return unavailable('unexpected answer')

  try {
    await env.CACHE_KV.put(key, answer, {
      expirationTtl: answer === 'yes' ? CONFIRMATION_ACCESS_YES_TTL_SECONDS : CONFIRMATION_ACCESS_NO_TTL_SECONDS,
    })
  } catch {
    // The fresh answer stands; only the cache write failed. The error is not logged: it may echo the key.
    console.warn('Confirmation access cache write failed')
  }
  return answer
}
