// Embedded-mode bridge installed when verifyer.divine.video is loaded inside
// an iframe of a trusted Divine origin (divine.video, *.divine.video, *.pages.dev,
// or localhost during dev). Routes window.nostr (NIP-07) calls to the parent
// frame over postMessage so the embedded verifyer flow uses the user's existing
// Divine session — no second login.
//
// The host (divine-mobile Flutter web) listens for messages of shape:
//   { type: 'divine:nostr.request', id, method, params }
// and replies with:
//   { type: 'divine:nostr.response', id, result }   on success
//   { type: 'divine:nostr.response', id, error }    on failure

export const ALLOWED_PARENT_HOSTS: readonly string[] = [
  'divine.video',
  'app.divine.video',
  'localhost',
];

export const ALLOWED_PARENT_SUFFIXES: readonly string[] = [
  '.divine.video',
  '.pages.dev',
];

// JavaScript source for the embed bridge IIFE. Inlined into the verifyer
// landing page <script> block so it runs before any signer detection logic.
export const EMBED_BRIDGE_SCRIPT = `
(function installDivineEmbedBridge() {
  if (typeof window === 'undefined' || window.parent === window) return;
  var ALLOWED_HOSTS = ${JSON.stringify(ALLOWED_PARENT_HOSTS)};
  var ALLOWED_SUFFIXES = ${JSON.stringify(ALLOWED_PARENT_SUFFIXES)};
  var parentOrigin = null;
  try {
    if (document.referrer) {
      var u = new URL(document.referrer);
      var host = u.hostname;
      if (ALLOWED_HOSTS.indexOf(host) !== -1 ||
          ALLOWED_SUFFIXES.some(function (s) { return host.endsWith(s); })) {
        parentOrigin = u.origin;
      }
    }
  } catch (e) {
    return;
  }
  if (!parentOrigin) return;
  window.__divineEmbedded = true;
  window.__divineParentOrigin = parentOrigin;
  var nextRequestId = 0;
  var pending = new Map();
  window.addEventListener('message', function (event) {
    if (event.origin !== parentOrigin) return;
    var data = event.data;
    if (!data || data.type !== 'divine:nostr.response') return;
    var entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(String(data.error)));
    else entry.resolve(data.result);
  });
  function sendRequest(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++nextRequestId;
      pending.set(id, { resolve: resolve, reject: reject });
      window.parent.postMessage(
        { type: 'divine:nostr.request', id: id, method: method, params: params || {} },
        parentOrigin
      );
      setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('divine.video parent did not respond'));
        }
      }, 60000);
    });
  }
  Object.defineProperty(window, 'nostr', {
    value: {
      getPublicKey: function () { return sendRequest('getPublicKey'); },
      signEvent: function (event) { return sendRequest('signEvent', { event: event }); },
      getRelays: function () { return sendRequest('getRelays'); },
    },
    configurable: true,
    writable: true,
  });
})();
`;
