import type { Context } from 'hono'
import { ALLOWED_PARENT_HOSTS, ALLOWED_PARENT_SUFFIXES } from './embed-bridge'

// Content-Security-Policy for the worker's HTML pages. A page runs only its
// own inline script, marked with a nonce made for that one response, and
// same-origin files (the nostr-tools module), plus Cloudflare's Web Analytics
// beacon, which Cloudflare adds to the page in production. Cloudflare
// features that add their own script to the page, such as Rocket Loader or
// Zaraz, may not run under this policy: re-check it before turning one on.
//
// The policy covers scripts, plugins, <base>, forms and framing only.
// Connections stay open: the page reaches any relay or NIP-05 domain a
// person names, so a connect-src list would have to allow every https: and
// wss: host anyway. Styles, fonts and images are left as they are.

const CLOUDFLARE_WEB_ANALYTICS = 'https://static.cloudflareinsights.com'

// Only the hosts the embed bridge answers may frame a page, and both come
// from the same list so they can't drift apart. Framing needs https, except
// on localhost: the bridge matches localhost on any scheme and port, for local
// development of the Divine web app.
function parentSource(host: string): string[] {
  return host === 'localhost' ? [`http://${host}:*`, `https://${host}:*`] : [`https://${host}`]
}

const FRAME_ANCESTORS = [
  "'self'",
  ...ALLOWED_PARENT_HOSTS.flatMap(parentSource),
  ...ALLOWED_PARENT_SUFFIXES.map(suffix => `https://*${suffix}`),
].join(' ')

// 16 random bytes (128 bits), base64.
function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Sets the page policy and returns the nonce the page's inline <script> tags must
 * carry. Call it once per HTML response. The response is never stored, so a
 * nonce is never served twice.
 */
export function setPagePolicy(c: Context): string {
  const nonce = newNonce()
  c.header('Content-Security-Policy', [
    `script-src 'nonce-${nonce}' 'self' ${CLOUDFLARE_WEB_ANALYTICS}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${FRAME_ANCESTORS}`,
  ].join('; '))
  c.header('Cache-Control', 'private, no-store')
  return nonce
}
