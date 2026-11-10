// ABOUTME: The operator switch that withdraws a platform's sign-in links (SIGNIN_LINKS_OFF).
// ABOUTME: Reads the Worker secret into the list of platforms whose links are off.
import type { Bindings, OAuthPlatform } from '../types'

// The fixed order the effective list is reported in.
const SIGNIN_PLATFORMS: readonly OAuthPlatform[] = ['twitter', 'bluesky', 'youtube', 'tiktok']

// The last raw value parsed and its result. signInLinksOff runs on every
// request, so parsing and warning each time would repeat the same warning for
// a typo in the secret; a Worker isolate sees one value until it is replaced.
let memo: { raw: string; result: OAuthPlatform[] } | undefined

/** Listed platforms, in the order twitter, bluesky, youtube, tiktok, without repeats. */
export function signInLinksOff(env: Bindings): OAuthPlatform[] {
  const raw = env.SIGNIN_LINKS_OFF ?? ''
  if (memo && memo.raw === raw) return [...memo.result]
  const listed = new Set<string>()
  for (const part of raw.split(/[\s,]+/)) {
    const entry = part.toLowerCase()
    if (!entry) continue
    if ((SIGNIN_PLATFORMS as readonly string[]).includes(entry)) {
      listed.add(entry)
    } else {
      // Ignored rather than switching everything off: the effective list is
      // visible on /health, and withdrawing every platform's links over a typo
      // would take down links nobody meant to.
      console.warn(`SIGNIN_LINKS_OFF names ${JSON.stringify(entry)}, which is not a sign-in platform; ignoring it`)
    }
  }
  const result = SIGNIN_PLATFORMS.filter((platform) => listed.has(platform))
  memo = { raw, result }
  return [...result]
}

/** Whether this platform's sign-in links are switched off. False for any non-sign-in platform. */
export function signInLinksAreOff(env: Bindings, platform: string): boolean {
  return (signInLinksOff(env) as string[]).includes(platform)
}
