import { isSafeUrl } from './validation'

const MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

// What fetch does on its own when a redirect changes the origin.
function withoutCredentials(init: RequestInit): RequestInit {
  if (!init.headers) return init
  const headers = new Headers(init.headers)
  for (const name of CREDENTIAL_HEADERS) headers.delete(name)
  return { ...init, headers }
}

/**
 * fetch for a host that came from user input or remote data. A redirect is
 * followed only to an https URL on a public host (isSafeUrl), so a public
 * server can't send the request on to a name the host check would refuse.
 *
 * A redirect that is not followed is returned as the response it is, with
 * ok false: a refused target, no Location, more than MAX_REDIRECTS hops, or
 * any redirect on a request with a body (a 307 or 308 would send the body to
 * the new URL). Callers handle it as the failed request it is.
 *
 * Other headers are sent again on each hop; Authorization, Cookie and
 * Proxy-Authorization are dropped when a redirect changes the origin, as fetch
 * does when it follows redirects itself.
 */
export async function fetchPublic(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const mayFollow = (method === 'GET' || method === 'HEAD') && init.body == null

  let request = init
  for (let hops = 0; ; hops++) {
    const response = await fetch(url, { ...request, redirect: 'manual' })
    if (!mayFollow || hops >= MAX_REDIRECTS || !REDIRECT_STATUSES.has(response.status)) return response

    const location = response.headers.get('Location')
    if (!location) return response
    let next: string
    try {
      next = new URL(location, url).toString()
    } catch {
      return response
    }
    if (!isSafeUrl(next)) return response

    // Only the Location matters; close the body so it isn't left open.
    try {
      await response.body?.cancel()
    } catch {}
    if (new URL(next).origin !== new URL(url).origin) request = withoutCredentials(request)
    url = next
  }
}
