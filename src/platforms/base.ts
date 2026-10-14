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
 * How long one platform request may take, from sending it to reading the last
 * of the answer. Workers put no limit of their own on a request that has
 * started, so a platform that accepts it and never answers would hold the
 * check for as long as the person stays connected.
 */
export const PLATFORM_REQUEST_TIMEOUT_MS = 5000

/**
 * How long one claim's whole check may take. The limit on one request doesn't
 * bound a check: Bluesky and Mastodon ask up to four things in a row, so a
 * platform that answers each just inside its limit could hold a claim, and the
 * batch it is in, for four times as long. Claims in a batch are checked side by
 * side, so this is also the longest a batch waits on its slowest claim.
 *
 * Divine's app and website stop waiting after 10 seconds and then keep no answer
 * at all, for any claim in the call (divine-mobile `verifier_client.dart`,
 * divine-web `src/config/api.ts`). So this stays under that, leaving about 2
 * seconds for the storage reads and writes around a check and for the
 * connection. App builds already installed keep that 10 seconds.
 */
export const PLATFORM_CHECK_TIME_BUDGET_MS = 8_000

/** The most of one answer a check reads. A real answer is far smaller; this bounds what a platform can make us hold. */
export const MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * fetch() for a platform check. A network failure, or an answer that takes
 * longer than PLATFORM_REQUEST_TIMEOUT_MS, means the platform couldn't be
 * asked, so it becomes a PlatformUnavailableError rather than a verdict.
 * Redirects fetchPublic follows share the one limit. The limit also covers
 * reading the answer, which is why bodies are read with readText or readJson.
 * Pass fetchPublic as `fetcher` when the host came from user input.
 */
export async function fetchFromPlatform(
  label: string,
  url: string,
  init?: Omit<RequestInit, 'signal'>,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(PLATFORM_REQUEST_TIMEOUT_MS) })
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
    void discardBody(response)
    throw new PlatformUnavailableError(`${label} answered ${response.status}`)
  }
}

/**
 * Waits for `work` for at most `ms`. Past that it gives up with a
 * PlatformUnavailableError, so the caller reports "couldn't check right now"
 * instead of waiting on. The work isn't cancelled; each request in it still
 * stops at its own limit.
 */
export async function withinTimeBudget<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PlatformUnavailableError(`${label} didn't finish within ${ms / 1000} seconds`)), ms)
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Closes an answer nobody will read, so it isn't left open while the check goes on to its next request. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {}
}

/**
 * The text of an answer, at most MAX_RESPONSE_BYTES of it; `truncated` says the
 * rest was left unread (and closed). An answer that stops arriving, or that
 * fails partway, is the platform not answering: it throws a
 * PlatformUnavailableError instead of ending up as a verdict about the proof.
 */
export async function readText(response: Response, label: string): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) return { text: '', truncated: false }

  const decoder = new TextDecoder()
  let text = ''
  let seen = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return { text: text + decoder.decode(), truncated: false }
      const room = MAX_RESPONSE_BYTES - seen
      if (value.byteLength > room) {
        text += decoder.decode(value.subarray(0, room))
        await reader.cancel()
        return { text, truncated: true }
      }
      seen += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
  } catch (err) {
    throw new PlatformUnavailableError(`${label} stopped answering (${err instanceof Error ? err.name : 'unknown'})`)
  }
}

/**
 * An answer parsed as JSON, or undefined when it isn't JSON or is over the
 * cap. Like readText, an answer that stops arriving throws a
 * PlatformUnavailableError, so callers must not wrap this in a try/catch that
 * turns every failure into "not valid JSON".
 */
export async function readJson<T>(response: Response, label: string): Promise<T | undefined> {
  const { text, truncated } = await readText(response, label)
  if (truncated) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
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
     * The account as claimed, named on the server that holds it, when that
     * server differs from the one in the identity given (a Mastodon server
     * whose handles use another domain from its website). Only set on success.
     */
    canonicalIdentity?: string
  }>
}
