import { bech32 } from '@scure/base'

function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): Uint8Array | null {
  let acc = 0
  let bits = 0
  const result: number[] = []
  const maxv = (1 << toBits) - 1

  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      return null
    }
    acc = (acc << fromBits) | value
    bits += fromBits
    while (bits >= toBits) {
      bits -= toBits
      result.push((acc >> bits) & maxv)
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((acc << (toBits - bits)) & maxv)
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    return null
  }

  return new Uint8Array(result)
}

export function hexToNpub(hex: string): string {
  const pairs = hex.match(/.{2}/g)
  if (!pairs || pairs.length !== 32) throw new Error('Invalid hex pubkey: must be 64 hex characters')
  const bytes = new Uint8Array(pairs.map(b => parseInt(b, 16)))
  const words = bech32.toWords(bytes)
  return bech32.encode('npub', words, 1000)
}

export function npubToHex(npub: string): string | null {
  try {
    const decoded = bech32.decode(npub as `${string}1${string}`, 1000)
    if (decoded.prefix !== 'npub') return null
    const bytes = convertBits(decoded.words, 5, 8, false)
    if (!bytes || bytes.length !== 32) return null
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}
