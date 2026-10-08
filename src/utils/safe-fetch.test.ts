import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchPublic } from './safe-fetch'

function redirect(location: string | null, status = 302): Response {
  return new Response(null, { status, headers: location === null ? {} : { Location: location } })
}

function okJson(): Response {
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('fetchPublic', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('returns a response that is not a redirect after one request', async () => {
    const final = okJson()
    fetchMock.mockResolvedValueOnce(final)

    const response = await fetchPublic('https://example.com/a', { headers: { Accept: 'application/json' } })

    expect(response).toBe(final)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/a', {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
    })
  })

  it('follows a redirect to another public host and sends the same headers there', async () => {
    const final = okJson()
    fetchMock
      .mockResolvedValueOnce(redirect('https://moved.example.org/b'))
      .mockResolvedValueOnce(final)

    const response = await fetchPublic('https://example.com/a', { headers: { Accept: 'application/json' } })

    expect(response).toBe(final)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('https://moved.example.org/b')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: 'manual' })
    expect(Object.fromEntries(new Headers(fetchMock.mock.calls[1][1].headers))).toEqual({ accept: 'application/json' })
  })

  it('drops credentials when a redirect changes the origin', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('https://moved.example.org/b'))
      .mockResolvedValueOnce(okJson())

    await fetchPublic('https://example.com/a', {
      headers: { Accept: 'application/json', Authorization: 'Bearer t', Cookie: 'a=b', 'Proxy-Authorization': 'Basic x' },
    })

    expect(Object.fromEntries(new Headers(fetchMock.mock.calls[0][1].headers))).toMatchObject({ authorization: 'Bearer t', cookie: 'a=b' })
    expect(Object.fromEntries(new Headers(fetchMock.mock.calls[1][1].headers))).toEqual({ accept: 'application/json' })
  })

  it('drops credentials from a Headers object too', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('https://moved.example.org/b'))
      .mockResolvedValueOnce(okJson())

    await fetchPublic('https://example.com/a', { headers: new Headers({ Authorization: 'Bearer t', Accept: 'application/json' }) })

    expect(Object.fromEntries(new Headers(fetchMock.mock.calls[1][1].headers))).toEqual({ accept: 'application/json' })
  })

  it('keeps credentials when a redirect stays on the same origin', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('/elsewhere'))
      .mockResolvedValueOnce(okJson())

    await fetchPublic('https://example.com/a', { headers: { Authorization: 'Bearer t' } })

    expect(Object.fromEntries(new Headers(fetchMock.mock.calls[1][1].headers))).toEqual({ authorization: 'Bearer t' })
  })

  it('reads a relative Location against the URL that redirected', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('/elsewhere?x=1'))
      .mockResolvedValueOnce(okJson())

    await fetchPublic('https://example.com/a')

    expect(fetchMock.mock.calls[1][0]).toBe('https://example.com/elsewhere?x=1')
  })

  it.each([
    ['plain http', 'http://example.org/'],
    ['localhost', 'https://localhost/'],
    ['an IPv4 address', 'https://127.0.0.1/'],
    ['an internal name', 'https://db.internal/'],
  ])('does not follow a redirect to %s', async (_label, target) => {
    const redirected = redirect(target)
    fetchMock.mockResolvedValueOnce(redirected)

    const response = await fetchPublic('https://example.com/a')

    expect(response).toBe(redirected)
    expect(response.ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('checks every hop, not only the first', async () => {
    const toPrivate = redirect('https://localhost/')
    fetchMock
      .mockResolvedValueOnce(redirect('https://moved.example.org/b'))
      .mockResolvedValueOnce(toPrivate)

    const response = await fetchPublic('https://example.com/a')

    expect(response).toBe(toPrivate)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops after three redirects', async () => {
    for (let i = 0; i < 10; i++) fetchMock.mockResolvedValueOnce(redirect('https://example.com/again'))
    fetchMock.mockResolvedValue(okJson())

    const response = await fetchPublic('https://example.com/a')

    expect(response.status).toBe(302)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('returns a redirect that has no Location', async () => {
    const redirected = redirect(null)
    fetchMock.mockResolvedValueOnce(redirected)

    const response = await fetchPublic('https://example.com/a')

    expect(response).toBe(redirected)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([301, 302, 303, 307, 308])('follows a %i redirect', async status => {
    fetchMock
      .mockResolvedValueOnce(redirect('https://moved.example.org/b', status))
      .mockResolvedValueOnce(okJson())

    const response = await fetchPublic('https://example.com/a')

    expect(response.status).toBe(200)
  })

  it('never follows a redirect on a request with a body', async () => {
    const redirected = redirect('https://moved.example.org/b', 307)
    fetchMock.mockResolvedValueOnce(redirected)

    const response = await fetchPublic('https://example.com/token', {
      method: 'POST',
      body: new URLSearchParams({ code: 'abc' }),
    })

    expect(response).toBe(redirected)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never follows a redirect on a POST without a body', async () => {
    const redirected = redirect('https://moved.example.org/b', 307)
    fetchMock.mockResolvedValueOnce(redirected)

    const response = await fetchPublic('https://example.com/a', { method: 'POST' })

    expect(response).toBe(redirected)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('closes the body of a redirect it follows', async () => {
    let cancelled = false
    const body = new ReadableStream({ cancel() { cancelled = true } })
    fetchMock
      .mockResolvedValueOnce(new Response(body, { status: 302, headers: { Location: 'https://moved.example.org/b' } }))
      .mockResolvedValueOnce(okJson())

    await fetchPublic('https://example.com/a')

    expect(cancelled).toBe(true)
  })
})
