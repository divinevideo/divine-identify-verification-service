import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const WORKER = 'divine-identity-verification-service'
export const ACCOUNT = 'c84e7a9bf7ed99cb41b8e73566568c75'
export const HEALTH = 'https://verifier.divine.video/health'
const REPOSITORY = 'divinevideo/divine-identify-verification-service'
const KV = {
  CACHE_KV: '24ad07be8c144e47aa04bd968495d678',
  RATE_LIMIT_KV: '5f1378af5d954c16a34c3100a60baee9',
}

class ReleaseError extends Error {}

function requireThat(condition, message) {
  if (!condition) throw new ReleaseError(message)
}

export function validateContext(env) {
  requireThat(env.GITHUB_REPOSITORY === REPOSITORY, 'Unexpected release repository')
  requireThat(env.GITHUB_REF === 'refs/heads/main', 'Production releases require main')
  requireThat(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'Unsupported release event')
  requireThat(/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? ''), 'Missing source SHA')
  requireThat(env.CLOUDFLARE_ACCOUNT_ID === ACCOUNT, 'Production account does not match the verified account')
  requireThat(env.CLOUDFLARE_API_TOKEN && env.GH_TOKEN, 'Missing CI deployment credentials')
}

export function activeVersion(deployments) {
  const latest = deployments[0]
  requireThat(latest?.versions?.length === 1 && latest.versions[0].percentage === 100,
    'Expected one active version at 100%; do not overwrite a gradual rollout')
  return latest.versions[0].version_id
}

export function validateBindings(version) {
  const bindings = version.resources?.bindings ?? []
  for (const [name, id] of Object.entries(KV)) {
    requireThat(bindings.some(binding => binding.name === name && binding.type === 'kv_namespace' && binding.namespace_id === id),
      `Production ${name} does not match the repository configuration`)
  }
}

export function readWranglerResult(text, type) {
  const matches = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(entry => entry.type === type && entry.version === 1 && entry.worker_name === WORKER)
  requireThat(matches.length === 1, `Expected one Wrangler ${type} result`)
  return matches[0]
}

export async function release({ env = process.env, fetchImpl = fetch, run = spawnSync,
  read = readFileSync, write = writeFileSync, append = appendFileSync } = {}) {
  const result = { source_sha: env.GITHUB_SHA, environment: 'production', worker: WORKER,
    run_id: env.GITHUB_RUN_ID, run_attempt: env.GITHUB_RUN_ATTEMPT, result: 'failed',
    started_at: new Date().toISOString() }
  const save = () => write('production-release.json', `${JSON.stringify(result, null, 2)}\n`)
  // Never serialize environment variables, response bodies, bindings, or tokens.
  async function request(url, token) {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000), redirect: 'error' })
    requireThat(response.ok, `Release metadata request failed (HTTP ${response.status})`)
    return response.json()
  }
  async function cloudflare(path) {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/${path}`, env.CLOUDFLARE_API_TOKEN)
    requireThat(response.success === true, 'Cloudflare metadata request failed')
    return response.result
  }
  async function assertCurrentMain() {
    const main = await request(`https://api.github.com/repos/${REPOSITORY}/git/ref/heads/main`, env.GH_TOKEN)
    requireThat(main.object?.sha === env.GITHUB_SHA, 'Checked commit is no longer main; replay the latest main instead')
  }
  const script = `workers/scripts/${WORKER}`
  function wrangler(args, output) {
    write(output, '')
    const child = run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
      env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_OUTPUT_FILE_PATH: output },
      stdio: 'inherit',
    })
    requireThat(!child.error && child.status === 0, 'Wrangler release command failed')
  }
  try {
    validateContext(env)
    await assertCurrentMain()
    const previous = activeVersion(await cloudflare(`${script}/deployments`).then(value => value.deployments))
    result.previous_version = previous
    validateBindings(await cloudflare(`${script}/versions/${previous}`))
    const domains = await cloudflare(`workers/domains?hostname=${new URL(HEALTH).hostname}`)
    requireThat(domains.some(domain => domain.hostname === new URL(HEALTH).hostname && domain.service === WORKER && domain.enabled === true),
      'Production health hostname is not attached to the verified Worker')
    wrangler(['versions', 'upload', '--tag', env.GITHUB_SHA, '--message', `main ${env.GITHUB_SHA}`], 'wrangler-upload.ndjson')
    const uploaded = readWranglerResult(read('wrangler-upload.ndjson', 'utf8'), 'version-upload')
    requireThat(/^[0-9a-f-]{36}$/.test(uploaded.version_id ?? ''), 'Wrangler returned no version ID')
    result.provider_version = uploaded.version_id
    save()
    // Uploading is not activation. Recheck after the build/upload, while holding
    // the production job lock, and refuse to overwrite a concurrent operator.
    await assertCurrentMain()
    requireThat(activeVersion((await cloudflare(`${script}/deployments`)).deployments) === previous,
      'Production changed during upload; an operator must reconcile the release')
    wrangler(['versions', 'deploy', `${uploaded.version_id}@100%`, '--yes', '--message', `main ${env.GITHUB_SHA}`], 'wrangler-deploy.ndjson')
    const deployed = readWranglerResult(read('wrangler-deploy.ndjson', 'utf8'), 'version-deploy')
    result.deployment_id = deployed.deployment_id
    save()
    requireThat(activeVersion((await cloudflare(`${script}/deployments`)).deployments) === uploaded.version_id,
      'Uploaded version is not the active production version')
    const version = await cloudflare(`${script}/versions/${uploaded.version_id}`)
    requireThat(version.annotations?.['workers/tag'] === env.GITHUB_SHA, 'Active version source tag does not match checked SHA')
    const health = await fetchImpl(HEALTH, { signal: AbortSignal.timeout(30_000), redirect: 'error', cache: 'no-store' })
    requireThat(health.ok, `Production health failed (HTTP ${health.status})`)
    const body = await health.json()
    requireThat(body.status === 'ok' && body.service === WORKER, 'Production health returned an unexpected service')
    result.result = 'success'
  } catch (error) {
    // Fixed messages only: fetch/JSON exceptions can contain URLs or bodies.
    result.failure = error instanceof ReleaseError ? error.message : 'Release metadata or health request failed'
    throw new ReleaseError(result.failure)
  } finally {
    result.finished_at = new Date().toISOString()
    save()
    if (env.GITHUB_STEP_SUMMARY) append(env.GITHUB_STEP_SUMMARY,
      `## Production release\n\nSource: \`${result.source_sha}\`\n\nVersion: \`${result.provider_version ?? 'not uploaded'}\`\n\nResult: **${result.result}**\n`)
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  release().catch(error => { console.error(error.message); process.exitCode = 1 })
}
