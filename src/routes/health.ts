import { Hono } from 'hono'
import type { Bindings } from '../types'
import { signInConfirmationMode } from '../oauth/confirm'
import { signInLinksOff } from '../oauth/signin-switch'
import { confirmationGate } from '../oauth/confirmation-gate'

const health = new Hono<{ Bindings: Bindings }>()

health.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'divine-identity-verification-service',
    version: '1.0.0',
    timestamp: Math.floor(Date.now() / 1000),
    // The sign-in confirmation mode in effect, so a deploy can be checked.
    signin_confirmation: signInConfirmationMode(c.env),
    // Which platforms' links are switched off, so a change to the secret can be checked.
    signin_links_off: signInLinksOff(c.env),
    // The Confirmation gate mode in effect, so a deploy can be checked. Testers are never listed.
    confirmation_gate: confirmationGate(c.env),
  })
})

export default health
