// ABOUTME: Reads a small JSON request body: JSON content type only, a size
// ABOUTME: cap, and a parse that answers 400 rather than throwing.
import type { Context } from 'hono'

export async function readJsonBody(c: Context, limit: number): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  // JSON only: a plain form post can't reach these routes without a CORS preflight.
  if (!/^application\/json\s*(;|$)/i.test(c.req.header('content-type') ?? '')) {
    return { ok: false, response: c.json({ error: 'Content-Type must be application/json' }, 415) }
  }
  if (Number(c.req.header('content-length') ?? '0') > limit) {
    return { ok: false, response: c.json({ error: 'Request body too large' }, 413) }
  }
  const text = await c.req.text()
  if (new TextEncoder().encode(text).length > limit) {
    return { ok: false, response: c.json({ error: 'Request body too large' }, 413) }
  }
  try {
    return { ok: true, body: JSON.parse(text) }
  } catch {
    return { ok: false, response: c.json({ error: 'Invalid JSON body' }, 400) }
  }
}
