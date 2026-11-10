// One copy of the page helpers that the main page and /lookup both need, so the
// status palette and npub decoding cannot drift between them. Run as a classic
// script: it declares DIVINE_RELAY, PROFILE_RELAYS, npubToHex, setStatus and
// clearStatus as globals of whichever page interpolates it.
export const SHARED_PAGE_SCRIPT = `    // Divine's own relay, where a person's linked accounts are expected to be.
    const DIVINE_RELAY = 'wss://relay.divine.video';
    const PROFILE_RELAYS = [DIVINE_RELAY, 'wss://relay.damus.io', 'wss://relay.primal.net'];

    function npubToHex(npub) {
      const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
      const data = npub.slice(5); // strip "npub1"
      const values = [];
      for (const c of data) {
        const v = CHARSET.indexOf(c);
        if (v === -1) throw new Error('Invalid npub character');
        values.push(v);
      }
      // bech32 decode: strip checksum (last 6), convert 5-bit to 8-bit
      const words = values.slice(0, values.length - 6);
      let bits = 0, value = 0;
      const result = [];
      for (const w of words) {
        value = (value << 5) | w;
        bits += 5;
        while (bits >= 8) {
          bits -= 8;
          result.push((value >> bits) & 0xff);
        }
      }
      return result.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function setStatus(elId, msg, type) {
      const el = document.getElementById(elId);
      if (!el) return;
      el.style.display = 'block';
      el.textContent = msg;
      // brand-aligned status palette: ok=green, err=pink, loading=mint
      el.style.background = type === 'error' ? 'rgba(255,127,175,0.18)' : type === 'loading' ? 'rgba(208,251,203,0.5)' : 'rgba(39,197,139,0.18)';
      el.style.color = type === 'error' ? '#7a1133' : type === 'loading' ? '#07241B' : '#0a4f37';
      el.style.borderColor = type === 'error' ? 'rgba(255,127,175,0.55)' : type === 'loading' ? 'rgba(7,36,27,0.18)' : 'rgba(39,197,139,0.45)';
    }

    function clearStatus(elId) {
      const el = document.getElementById(elId);
      if (el) el.style.display = 'none';
    }`
