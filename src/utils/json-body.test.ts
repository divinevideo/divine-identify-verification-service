import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { readJsonBody } from './json-body'

const app = new Hono()
app.post('/', async (c) => {
  const read = await readJsonBody(c, 32)
  return read.ok ? c.json({ got: read.body }) : read.response
})

const post = (body: string, type = 'application/json') =>
  app.request('/', { method: 'POST', headers: { 'Content-Type': type }, body })

describe('reading a JSON body', () => {
  it('reads JSON sent as application/json, with or without a charset', async () => {
    expect(await (await post('{"a":1}')).json()).toEqual({ got: { a: 1 } })
    expect((await post('{"a":1}', 'application/json; charset=utf-8')).status).toBe(200)
  })

  it('refuses other content types with 415', async () => {
    expect((await post('{"a":1}', 'text/plain')).status).toBe(415)
    expect((await post('a=1', 'application/x-www-form-urlencoded')).status).toBe(415)
    expect((await post('{"a":1}', 'application/jsonp')).status).toBe(415)
  })

  it('refuses a body over the limit with 413', async () => {
    expect((await post(JSON.stringify({ a: 'x'.repeat(40) }))).status).toBe(413)
  })

  it('refuses a body declared over the limit with 413 before reading it', async () => {
    const res = await app.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '33' }, body: '{}' })
    expect(res.status).toBe(413)
  })

  it('refuses a body with no declared length as soon as it passes the limit, without reading the rest', async () => {
    let pulled = 0
    const chunk = new TextEncoder().encode('x'.repeat(10))
    // Pulled only when read, so `pulled` counts the chunks the reader asked for.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        if (pulled > 20) controller.close()
        else controller.enqueue(chunk)
      },
    }, { highWaterMark: 0 })
    const res = await app.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half' } as RequestInit)
    expect(res.status).toBe(413)
    expect(pulled * chunk.length).toBeLessThanOrEqual(32 + chunk.length)
  })

  it('refuses a declared length that is not a number with 400', async () => {
    const res = await app.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 'abc' }, body: '{}' })
    expect(res.status).toBe(400)
  })

  it('reads a body made of several chunks, even one that splits a character', async () => {
    const bytes = new TextEncoder().encode('{"a":"\u00e9"}')
    // \u00e9 is two bytes in UTF-8; the first chunk ends between them.
    const parts = [bytes.slice(0, 7), bytes.slice(7)]
    const body = new ReadableStream<Uint8Array>({
      start(controller) { for (const part of parts) controller.enqueue(part); controller.close() },
    })
    const res = await app.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half' } as RequestInit)
    expect(await res.json()).toEqual({ got: { a: '\u00e9' } })
  })

  it('refuses a body that is not JSON with 400', async () => {
    expect((await post('{nope')).status).toBe(400)
  })
})
