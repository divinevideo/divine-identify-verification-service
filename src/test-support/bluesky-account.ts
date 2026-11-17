// ABOUTME: A fetch-mock helper for Bluesky account-status checks: answers the PLC directory lookup
// ABOUTME: and the PDS getRepoStatus request for one DID, and returns null for any other URL.

type AccountAnswerOptions = {
  /** The PDS the DID document names. */
  pds?: string
  /** What getRepoStatus says about the account. Defaults to active. */
  active?: boolean
  /** The account's `status`, sent only when given. */
  status?: string
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

/** The answer for `url` if it is one of the two requests a status check makes for `did`, otherwise null. */
export function blueskyAccountAnswer(url: string, did: string, opts: AccountAnswerOptions = {}): Response | null {
  const pds = opts.pds ?? 'https://pds.account.test'
  if (url === `https://plc.directory/${did}`) {
    return json({ id: did, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }] })
  }
  if (url === `${pds}/xrpc/com.atproto.sync.getRepoStatus?did=${encodeURIComponent(did)}`) {
    return json({ did, active: opts.active ?? true, ...(opts.status === undefined ? {} : { status: opts.status }) })
  }
  return null
}
