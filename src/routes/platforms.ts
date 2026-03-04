import { Hono } from 'hono'
import type { Bindings } from '../types'
import { getPlatformInfo } from '../platforms/registry'

const platforms = new Hono<{ Bindings: Bindings }>()

platforms.get('/', (c) => {
  return c.json({ platforms: getPlatformInfo() })
})

export default platforms
