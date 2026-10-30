import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT, HEALTH, WORKER, activeVersion, readWranglerResult, release, validateContext } from './production-release.mjs'

const sha = 'a'.repeat(40)
const previous = '11111111-1111-1111-1111-111111111111'
const uploaded = '22222222-2222-2222-2222-222222222222'
const env = {
  GITHUB_REPOSITORY: 'divinevideo/divine-identify-verification-service',
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sha,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'test-only', GH_TOKEN: 'test-only',
}
const bindings = [
  { name: 'CACHE_KV', type: 'kv_namespace', namespace_id: '24ad07be8c144e47aa04bd968495d678' },
  { name: 'RATE_LIMIT_KV', type: 'kv_namespace', namespace_id: '5f1378af5d954c16a34c3100a60baee9' },
]
const deployment = id => ({ deployments: [{ versions: [{ version_id: id, percentage: 100 }] }] })

function harness(overrides = {}) {
  let active = previous
  const files = new Map()
  const run = vi.fn((_node, args, options) => {
    const type = args[2] === 'upload' ? 'version-upload' : 'version-deploy'
    if (type === 'version-deploy') active = uploaded
    files.set(options.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({
      type, version: 1, worker_name: WORKER, version_id: uploaded, deployment_id: 'deployment-id',
    }))
    return { status: 0 }
  })
  const fetchImpl = vi.fn(async url => {
    let result
    if (url.startsWith('https://api.github.com/')) return { ok: true, json: async () => ({ object: { sha } }) }
    if (url === HEALTH) return { ok: true, json: async () => ({ status: 'ok', service: WORKER }) }
    if (url.endsWith('/deployments')) result = deployment(active)
    else if (url.endsWith(`/versions/${previous}`)) result = { resources: { bindings } }
    else if (url.endsWith(`/versions/${uploaded}`)) result = { annotations: { 'workers/tag': sha } }
    else if (url.includes('/workers/domains?')) result = [{ hostname: new URL(HEALTH).hostname, service: WORKER, enabled: true }]
    else throw new Error('Unexpected mocked endpoint')
    return { ok: true, json: async () => ({ success: true, result }) }
  })
  return { env, run, fetchImpl, read: path => files.get(path), write: (path, text) => files.set(path, text),
    append: vi.fn(), files, ...overrides }
}

describe('production release guard', () => {
  it.each([
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REF: 'refs/pull/1/merge' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_REPOSITORY: 'example/fork' }, { CLOUDFLARE_ACCOUNT_ID: 'different-account' },
    { GITHUB_SHA: 'main' }, { CLOUDFLARE_API_TOKEN: '' },
  ])('rejects an unsafe context before making requests: %j', async changes => {
    const h = harness({ env: { ...env, ...changes } })
    await expect(release(h)).rejects.toThrow()
    expect(h.run).not.toHaveBeenCalled()
    expect(h.fetchImpl).not.toHaveBeenCalled()
    expect(JSON.parse(h.files.get('production-release.json')).result).toBe('failed')
  })

  it('allows main-only manual replay of the checked SHA', () => {
    expect(() => validateContext({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' })).not.toThrow()
  })

  it('uploads and activates only that version, verifies source and health, and saves metadata', async () => {
    const h = harness()
    const result = await release(h)
    expect(result).toMatchObject({ source_sha: sha, provider_version: uploaded, previous_version: previous,
      environment: 'production', result: 'success', deployment_id: 'deployment-id' })
    expect(h.run.mock.calls[0][1]).toEqual(['node_modules/wrangler/bin/wrangler.js', 'versions', 'upload', '--tag', sha, '--message', `main ${sha}`])
    expect(h.run.mock.calls[1][1]).toEqual(['node_modules/wrangler/bin/wrangler.js', 'versions', 'deploy', `${uploaded}@100%`, '--yes', '--message', `main ${sha}`])
    expect(h.fetchImpl.mock.calls.at(-1)[0]).toBe(HEALTH)
    expect(h.fetchImpl.mock.calls.at(-1)[1].headers).toBeUndefined()
    expect(h.files.get('production-release.json')).not.toContain('test-only')
  })

  it.each(['before upload', 'before activation'])('rejects stale main %s', async when => {
    const h = harness()
    const original = h.fetchImpl.getMockImplementation()
    let mainReads = 0
    h.fetchImpl.mockImplementation(async (url, options) => {
      if (url.startsWith('https://api.github.com/') && ++mainReads >= (when === 'before upload' ? 1 : 2)) {
        return { ok: true, json: async () => ({ object: { sha: 'b'.repeat(40) } }) }
      }
      return original(url, options)
    })
    await expect(release(h)).rejects.toThrow('no longer main')
    expect(h.run).toHaveBeenCalledTimes(when === 'before upload' ? 0 : 1)
  })

  it.each(['bindings', 'domain', 'concurrent operator', 'source tag', 'health', 'active version'])('fails closed on %s mismatch', async failure => {
    const h = harness()
    const original = h.fetchImpl.getMockImplementation()
    let reads = 0
    h.fetchImpl.mockImplementation(async (url, options) => {
      const response = result => ({ ok: true, json: async () => ({ success: true, result }) })
      if (failure === 'bindings' && url.endsWith(`/versions/${previous}`)) return response({ resources: { bindings: [] } })
      if (failure === 'domain' && url.includes('/workers/domains?')) return response([])
      if (url.endsWith('/deployments')) {
        reads++
        if (failure === 'concurrent operator' && reads === 2) return response(deployment('other-version'))
        if (failure === 'active version' && reads === 3) return response(deployment(previous))
      }
      if (failure === 'source tag' && url.endsWith(`/versions/${uploaded}`)) return response({ annotations: {} })
      if (failure === 'health' && url === HEALTH) return { ok: false, status: 503 }
      return original(url, options)
    })
    await expect(release(h)).rejects.toThrow()
    expect(JSON.parse(h.files.get('production-release.json')).result).toBe('failed')
    expect(h.run.mock.calls.length).toBeLessThanOrEqual(2) // No automatic rollback.
    if (['bindings', 'domain'].includes(failure)) expect(h.run).not.toHaveBeenCalled()
    if (failure === 'concurrent operator') expect(h.run).toHaveBeenCalledTimes(1)
  })

  it.each([
    { hostname: 'other.example.com' }, { service: 'another-worker' },
    { enabled: false }, { enabled: undefined },
  ])('refuses upload when the existing domain is unsafe: %j', async changes => {
    const h = harness()
    const original = h.fetchImpl.getMockImplementation()
    h.fetchImpl.mockImplementation(async (url, options) => {
      const response = await original(url, options)
      if (!url.includes('/workers/domains?')) return response
      const body = await response.json()
      return { ...response, json: async () => ({ ...body,
        result: body.result.map(domain => ({ ...domain, ...changes })),
      }) }
    })

    await expect(release(h)).rejects.toThrow('Production health hostname is not attached to the verified Worker')
    expect(h.run).not.toHaveBeenCalled()
    expect(JSON.parse(h.files.get('production-release.json'))).toMatchObject({ result: 'failed' })
  })

  it.each([
    ['CACHE_KV', { namespace_id: '00000000000000000000000000000000' }],
    ['RATE_LIMIT_KV', { namespace_id: '00000000000000000000000000000000' }],
    ['CACHE_KV', { type: 'plain_text' }],
    ['RATE_LIMIT_KV', { type: 'plain_text' }],
  ])('refuses upload when %s has a mismatched binding: %j', async (name, changes) => {
    const h = harness()
    const original = h.fetchImpl.getMockImplementation()
    h.fetchImpl.mockImplementation(async (url, options) => {
      if (!url.endsWith(`/versions/${previous}`)) return original(url, options)
      return { ok: true, json: async () => ({ success: true, result: { resources: {
        bindings: bindings.map(binding => binding.name === name ? { ...binding, ...changes } : binding),
      } } }) }
    })

    await expect(release(h)).rejects.toThrow(`Production ${name} does not match the repository configuration`)
    expect(h.run).not.toHaveBeenCalled()
    expect(JSON.parse(h.files.get('production-release.json'))).toMatchObject({ result: 'failed' })
  })

  it('retains failure and does not activate when Wrangler upload fails', async () => {
    const h = harness({ run: vi.fn(() => ({ status: 1 })) })
    await expect(release(h)).rejects.toThrow('Wrangler release command failed')
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('does not leak response bodies through errors or stored results', async () => {
    const h = harness({ fetchImpl: vi.fn(async () => { throw new Error('private response content') }) })
    await expect(release(h)).rejects.toThrow('Release metadata or health request failed')
    expect(h.files.get('production-release.json')).not.toContain('private response content')
  })

  it('refuses gradual deployments and ambiguous Wrangler output', () => {
    expect(() => activeVersion([{ versions: [{ version_id: previous, percentage: 50 }, { version_id: uploaded, percentage: 50 }] }])).toThrow()
    expect(() => readWranglerResult('', 'version-upload')).toThrow()
  })
})

describe('release workflow boundaries', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  it('keeps repo checks and production environment gating', () => {
    for (const command of ['npm ci', 'npm run check:vendor', 'npm run typecheck', 'npm run test:once']) expect(workflow).toContain(command)
    expect(workflow).toContain('needs: [test, release-ready]')
    expect(workflow).toContain("github.ref == 'refs/heads/main'")
    expect(workflow).toContain('PRODUCTION_CD_ENABLED')
    expect(workflow).toContain('required_reviewers')
    expect(workflow).toContain('actions: read')
    expect(workflow).toContain('name: production')
    expect(workflow).toContain('group: production-worker')
    expect(workflow).not.toContain('cancel-in-progress: true')
    expect(workflow).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}")
    expect(workflow).not.toContain('pull_request_target')
  })
})
