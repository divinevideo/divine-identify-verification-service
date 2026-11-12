// ABOUTME: The operator settings for the Divine Confirmation access gate (CONFIRMATION_GATE, CONFIRMATION_TESTERS).
// ABOUTME: Reads the Worker settings into the gate mode and the set of testers who are held to it first.
import type { Bindings } from '../types'

export type ConfirmationGateMode = 'off' | 'shadow' | 'on'

const MODES: readonly string[] = ['off', 'shadow', 'on']

// The last raw value parsed and its result, one memo per setting. These run on
// every request, so parsing and warning each time would repeat the same warning
// for a typo in the setting; a Worker isolate sees one value until it is replaced.
let gateMemo: { raw: string; result: ConfirmationGateMode } | undefined
let testersMemo: { raw: string; result: ReadonlySet<string> } | undefined

/** The gate mode. Unset is off; so is any value that is not off, shadow or on, with a warning. */
export function confirmationGate(env: Bindings): ConfirmationGateMode {
  const raw = env.CONFIRMATION_GATE
  if (raw === undefined) return 'off'
  if (gateMemo && gateMemo.raw === raw) return gateMemo.result
  const value = raw.trim().toLowerCase()
  let result: ConfirmationGateMode = 'off'
  if (MODES.includes(value)) {
    result = value as ConfirmationGateMode
  } else {
    // Off rather than on: a typo must not lock people out of sign-in. The mode
    // in effect is visible on /health.
    console.warn(`CONFIRMATION_GATE is ${JSON.stringify(raw)}, not "off", "shadow" or "on"; treating it as off`)
  }
  gateMemo = { raw, result }
  return result
}

/** The lowercase hex pubkeys listed in CONFIRMATION_TESTERS. Malformed entries are dropped. */
export function confirmationTesters(env: Bindings): ReadonlySet<string> {
  const raw = env.CONFIRMATION_TESTERS ?? ''
  if (testersMemo && testersMemo.raw === raw) return testersMemo.result
  const testers = new Set<string>()
  let ignored = 0
  for (const part of raw.split(/[\s,]+/)) {
    const entry = part.toLowerCase()
    if (!entry) continue
    if (/^[0-9a-f]{64}$/.test(entry)) testers.add(entry)
    else ignored++
  }
  if (ignored > 0) {
    // The count only: an ignored entry may be a real pubkey, and logs carry none.
    console.warn(`CONFIRMATION_TESTERS has ${ignored} entries that are not 64-character hex pubkeys (npub is not accepted); ignoring them`)
  }
  testersMemo = { raw, result: testers }
  return testers
}

/** Whether this pubkey is listed in CONFIRMATION_TESTERS. */
export function isConfirmationTester(env: Bindings, pubkey: string): boolean {
  return confirmationTesters(env).has(pubkey.toLowerCase())
}
