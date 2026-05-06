/**
 * Pure helpers for the Verified Links panel (issue #3).
 * Browser inline script in index.ts mirrors this behavior; keep in sync when changing merge rules.
 */
export type VerifiedLink = {
  platform: string
  identity: string
  proof: string
}

export function claimKeyForLink(platform: string, identity: string): string {
  return `${String(platform || '')}:${String(identity || '')}`
}

/** Replace or append by case-insensitive platform:identity key. */
export function upsertVerifiedLinkList(list: VerifiedLink[], entry: VerifiedLink): VerifiedLink[] {
  const key = claimKeyForLink(entry.platform, entry.identity).toLowerCase()
  const idx = list.findIndex(
    (l) => claimKeyForLink(l.platform, l.identity).toLowerCase() === key,
  )
  const next = list.slice()
  if (idx >= 0) {
    next[idx] = { platform: entry.platform, identity: entry.identity, proof: entry.proof }
  } else {
    next.push({ platform: entry.platform, identity: entry.identity, proof: entry.proof })
  }
  return next
}

/** Merge verified links into existing `i` tags (kind 10011 / NIP-39). */
export function mergeVerifiedLinksIntoITags(iTags: string[][], links: VerifiedLink[]): string[][] {
  let next = iTags.filter((t) => t[0] === 'i').slice()
  for (const link of links) {
    const claimKey = claimKeyForLink(link.platform, link.identity)
    next = next.filter(
      (tag) =>
        !(typeof tag[1] === 'string' && tag[1].toLowerCase() === claimKey.toLowerCase()),
    )
    next.push(['i', claimKey, link.proof])
  }
  return next
}
