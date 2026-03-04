import { Hono } from 'hono'
import type { Bindings } from '../types'

const health = new Hono<{ Bindings: Bindings }>()

health.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'divine-identity-verification-service',
    version: '1.0.0',
    timestamp: Math.floor(Date.now() / 1000),
  })
})

export default health
