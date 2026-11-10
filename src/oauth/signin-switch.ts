// ABOUTME: The operator switch that withdraws a platform's sign-in links (SIGNIN_LINKS_OFF).
// ABOUTME: Reads the Worker secret into the list of platforms whose links are off.
import type { Bindings, OAuthPlatform } from '../types'

// The fixed order the effective list is reported in.
const SIGNIN_PLATFORMS: readonly OAuthPlatform[] = ['twitter', 'bluesky', 'youtube', 'tiktok']

/** Listed platforms, in the order twitter, bluesky, youtube, tiktok, without repeats. */
export function signInLinksOff(env: Bindings): OAuthPlatform[] {
  const listed = new Set<string>()
  for (const raw of (env.SIGNIN_LINKS_OFF ?? '').split(/[\s,]+/)) {
    const entry = raw.toLowerCase()
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
  return SIGNIN_PLATFORMS.filter((platform) => listed.has(platform))
}

/** Whether this platform's sign-in links are switched off. False for any non-sign-in platform. */
export function signInLinksAreOff(env: Bindings, platform: string): boolean {
  return (signInLinksOff(env) as string[]).includes(platform)
}
