import { Hono } from 'hono'
import type { Bindings } from '../types'
import { signInConfirmationMode } from '../oauth/confirm'

const health = new Hono<{ Bindings: Bindings }>()

health.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'divine-identity-verification-service',
    version: '1.0.0',
    timestamp: Math.floor(Date.now() / 1000),
    // The sign-in confirmation mode in effect, so a deploy can be checked.
    signin_confirmation: signInConfirmationMode(c.env),
  })
})

export default health
