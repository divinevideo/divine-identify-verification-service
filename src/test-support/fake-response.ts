// ABOUTME: Turns the plain-object answers older tests give `fetch` into real Responses, which is
// ABOUTME: what the platform checks now read: a limited stream of bytes, not a ready-made .json().

type FakeAnswer = {
  ok?: boolean
  status?: number
  headers?: HeadersInit
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}

export function fakeResponse(fake: FakeAnswer): Response {
  const status = fake.status ?? (fake.ok === false ? 400 : 200)
  // Some fakes give both, with an empty text standing in for "not used here": read the one that has something.
  const body = fake.text || fake.json ? async () => {
    const text = fake.text ? await fake.text() : ''
    return text !== '' || !fake.json ? text : JSON.stringify(await fake.json())
  } : undefined
  return new Response(body ? new ReadableStream<Uint8Array>({
    async pull(controller) {
      controller.enqueue(new TextEncoder().encode(await body()))
      controller.close()
    },
  }) : null, { status, headers: fake.headers })
}
