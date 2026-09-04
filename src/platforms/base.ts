import type { VerificationMethod, VerificationProvenance } from '../identity-link'

export interface PlatformVerifier {
  readonly name: string
  readonly label: string
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
     */
    code?: string
    method?: VerificationMethod
    provenance?: VerificationProvenance
  }>
}
