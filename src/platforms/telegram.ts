import type { PlatformVerifier } from './base'

export class TelegramVerifier implements PlatformVerifier {
  readonly name = 'telegram'
  readonly label = 'Telegram'

  async verify(identity: string, proof: string, npub: string): Promise<{ verified: boolean; error?: string }> {
    // Telegram proof format: "channel/messageId"
    // Encode each path segment individually to preserve slashes
    const safePath = proof.split('/').map(s => encodeURIComponent(s)).join('/')
    const url = `https://t.me/${safePath}?embed=1`

    const response = await fetch(url, {
      headers: { 'User-Agent': 'divine-identity-verification-service' },
    })

    if (response.status === 404) {
      return { verified: false, error: 'Telegram message not found' }
    }
    if (!response.ok) {
      return { verified: false, error: `Telegram embed error: ${response.status}` }
    }

    const html = await response.text()

    // Verify the message author matches the claimed identity (mandatory)
    const authorMatch = html.match(/tgme_widget_message_author.*?href="https?:\/\/t\.me\/([^"?]+)"/s)
    if (!authorMatch) {
      return { verified: false, error: 'Unable to determine message author from Telegram embed' }
    }
    if (authorMatch[1].toLowerCase() !== identity.toLowerCase()) {
      return { verified: false, error: 'Message author does not match claimed identity' }
    }

    // Check the embed HTML for the npub
    if (html.includes(npub)) {
      return { verified: true }
    }

    return { verified: false, error: 'npub not found in Telegram message' }
  }
}
