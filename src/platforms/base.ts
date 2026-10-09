import type { VerificationMethod, VerificationProvenance } from '../identity-link'
import type { VerificationCode } from '../types'

/** Codes a verifier may return. `temporarily_unavailable` is set only by the service. */
export type VerdictCode = Exclude<VerificationCode, 'temporarily_unavailable'>

/** The platform didn't answer the question, so there's no verdict on the proof. */
export class PlatformUnavailableError extends Error {
  name = 'PlatformUnavailableError'
}

/**
 * Whether a status means the platform didn't answer: it timed out, asked us to
 * slow down, or failed on its side (any 5xx, including Cloudflare's 520 to 530
 * for an origin that's down). 501 and 505 are the exceptions: "this server
 * doesn't do that" is permanent, so trying again won't help. 401 and 403 are
 * left to each platform, since for some they're a real answer.
 */
export function isUnanswered(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status !== 501 && status !== 505)
}

/**
 * fetch() for a platform check. A network failure means the platform couldn't
 * be asked, so it becomes a PlatformUnavailableError rather than a verdict.
 * Pass fetchPublic as `fetcher` when the host came from user input.
 */
export async function fetchFromPlatform(
  label: string,
  url: string,
  init?: RequestInit,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  try {
    return await fetcher(url, init)
  } catch (err) {
    // Only the error's name: its message could carry the request URL, and some
    // platforms (YouTube) take an API key in the query string.
    throw new PlatformUnavailableError(`${label} couldn't be reached (${err instanceof Error ? err.name : 'unknown'})`)
  }
}

/**
 * Throws when the platform didn't answer. The verify service reports that as
 * "couldn't be checked right now", remembered briefly, so an outage is never
 * cached as though the proof had been rejected.
 */
export function throwIfUnanswered(response: Response, label: string): void {
  if (isUnanswered(response.status)) {
    throw new PlatformUnavailableError(`${label} answered ${response.status}`)
  }
}

export interface PlatformVerifier {
  readonly name: string
  readonly label: string
  /**
   * Returns a verdict on the proof. When the platform didn't answer or couldn't
   * be reached, there is no verdict: throw instead (use fetchFromPlatform and
   * throwIfUnanswered), and the service reports "couldn't be checked right now".
   */
  verify(
    identity: string,
    proof: string,
    npub: string
  ): Promise<{
    verified: boolean
    error?: string
    /**
     * Stable machine-readable rejection reason, for clients that need to say
     * something localized. `error` stays free-form English for triage.
     *
     * Optional so platforms can adopt it one at a time, and so a client that
     * does not recognise a value can fall back to its own generic copy.
     * `temporarily_unavailable` isn't a verdict, so only the service sets it,
     * when a verifier throws.
     */
    code?: VerdictCode
    method?: VerificationMethod
    provenance?: VerificationProvenance
    /**
     * The proof to publish, when verification resolved the given one to a
     * simpler stable form (for example a TikTok share link to its post
     * number). Only set on success, and only when it differs from the input.
     */
    canonicalProof?: string
    /**
     * The account as found on the server that holds it, when that differs from
     * the identity given (a Mastodon server whose handles use another domain
     * from its website). Only set on success.
     */
    canonicalIdentity?: string
  }>
}
