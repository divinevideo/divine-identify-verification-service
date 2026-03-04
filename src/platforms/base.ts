export interface PlatformVerifier {
  readonly name: string
  readonly label: string
  verify(identity: string, proof: string, npub: string): Promise<{ verified: boolean; error?: string }>
}
