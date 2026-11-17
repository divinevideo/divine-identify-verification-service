// ABOUTME: One-time operator script (#90): re-puts confirmed Bluesky sign-in records without their 30-day
// ABOUTME: expiry and marked `kept`, so they last until unlinked. Dry run by default; prints counts only.
// TODO(#90): delete once it has run in production.
import { pathToFileURL } from 'node:url'
import { ACCOUNT } from './production-release.mjs'

export const CACHE_KV_ID = '24ad07be8c144e47aa04bd968495d678'
export const PREFIX = 'oauth_verified:bluesky:'

// Mirrors keepsUntilUnlinked (src/oauth/signin-lifetime.ts) on a parsed stored value.
// Requiring a non-empty string account_id is deliberately stricter than its `!!account_id`, because stored values are raw JSON.
// A retired record is skipped: its 30-day expiry was set on purpose, because its
// account was gone for the long term (retireSignIn, src/oauth/signin-records.ts).
export function isKeptRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && value.platform === 'bluesky' && value.confirmed === true
    && typeof value.account_id === 'string' && value.account_id !== ''
    && value.retired !== true
}

// Key names hold handles, DIDs and pubkeys, and URLs hold the key names, so no
// message below includes either. Errors carry a fixed message or a status only.
export async function keepBlueskyLinks({
  token, write = false, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)),
  paceMs = 300, account = ACCOUNT, namespace = CACHE_KV_ID,
}) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}`
  let calls = 0
  const api = async (path, init = {}, { allow404 = false, pace = true } = {}) => {
    if (calls++ > 0 && pace) await sleep(paceMs)
    let response
    try {
      response = await fetchImpl(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } })
    } catch {
      throw new Error('Cloudflare API request failed')
    }
    if (response.status === 429) throw new Error('Cloudflare API rate limit reached; run the script again to continue')
    if (allow404 && response.status === 404) return null
    if (!response.ok) throw new Error(`Cloudflare API answered ${response.status}`)
    return response
  }
  // A body parse error can quote part of the body, so it never reaches a message.
  const unreadable = async fn => {
    try { return await fn() } catch { throw new Error('Cloudflare API answered with an unreadable body') }
  }
  const read = async name => {
    const response = await api(`/values/${encodeURIComponent(name)}`, {}, { allow404: true })
    if (response === null) return null
    return unreadable(() => response.text())
  }

  const counts = { listed: 0, expiring: 0, eligible: 0, kept: 0, changed: 0, skipped: 0 }
  let cursor = ''
  do {
    const listing = await api(`/keys?prefix=${encodeURIComponent(PREFIX)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    const page = await unreadable(() => listing.json())
    for (const { name, expiration } of page.result ?? []) {
      counts.listed++
      if (!expiration) continue // already stored with no expiry
      counts.expiring++
      const text = await read(name)
      let parsed
      try { parsed = text === null ? undefined : JSON.parse(text) } catch { parsed = undefined }
      if (parsed === undefined) { counts.skipped++; continue }
      if (!isKeptRecord(parsed)) continue
      counts.eligible++
      if (!write) continue
      // Re-read just before writing: a sign-in saved or unlinked in the
      // meantime must not be overwritten with the older value.
      if (await read(name) !== text) { counts.changed++; continue }
      // Same value plus `kept: true`, as storeOAuthVerification writes new records.
      // No expiration or expiration_ttl in the query, so the key stops expiring.
      await api(`/values/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: JSON.stringify({ ...parsed, kept: true }),
      }, { pace: false }) // no pause after the re-read: the shorter the gap, the less an unlink can be undone
      counts.kept++
    }
    cursor = page.result_info?.cursor ?? ''
  } while (cursor)
  return counts
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) {
    console.error('Set CLOUDFLARE_API_TOKEN (Workers KV Storage edit) to run this script.')
    process.exit(1)
  }
  const at = args.indexOf('--pace-ms')
  const paceMs = at >= 0 ? Number(args[at + 1]) : 300
  if (!Number.isFinite(paceMs) || paceMs < 0) {
    console.error('--pace-ms needs a number of milliseconds.')
    process.exit(1)
  }
  keepBlueskyLinks({ token, write: args.includes('--write'), paceMs })
    .then(counts => console.log(JSON.stringify(counts)))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
