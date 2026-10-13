// ABOUTME: Reads a small JSON request body: JSON content type only, a size
// ABOUTME: cap, and a parse that answers 400 rather than throwing.
import type { Context } from 'hono'

export async function readJsonBody(c: Context, limit: number): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  // JSON only: a cross-site page can't send this as a plain form; it needs a
  // CORS request, which carries no cookies here.
  if (!/^application\/json\s*(;|$)/i.test(c.req.header('content-type') ?? '')) {
    return { ok: false, response: c.json({ error: 'Content-Type must be application/json' }, 415) }
  }
  const tooLarge = () => ({ ok: false as const, response: c.json({ error: 'Request body too large' }, 413) })
  const declared = c.req.header('content-length')
  if (declared !== undefined && !/^\d+$/.test(declared)) {
    return { ok: false, response: c.json({ error: 'Invalid Content-Length' }, 400) }
  }
  if (Number(declared ?? '0') > limit) return tooLarge()

  // Counted as it arrives: a body sent without a declared length is cut off
  // as soon as it passes the limit, rather than read in full first.
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = c.req.raw.body?.getReader()
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        return tooLarge()
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { ok: false, response: c.json({ error: 'Invalid JSON body' }, 400) }
  }
}
