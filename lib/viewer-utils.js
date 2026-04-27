'use strict';

// LobsterLink viewer pure helpers.
// Classic-script-compatible: defined at script scope so viewer.html ->
// viewer.js picks them up as globals, and exported via CommonJS for Vitest.

function diffMobileKeyboardText(previousText, nextText) {
  const prevLen = previousText.length;
  const nextLen = nextText.length;
  let prefix = 0;
  const maxPrefix = Math.min(prevLen, nextLen);
  while (prefix < maxPrefix && previousText.charCodeAt(prefix) === nextText.charCodeAt(prefix)) {
    prefix++;
  }
  let suffix = 0;
  const maxSuffix = Math.min(prevLen - prefix, nextLen - prefix);
  while (
    suffix < maxSuffix &&
    previousText.charCodeAt(prevLen - 1 - suffix) === nextText.charCodeAt(nextLen - 1 - suffix)
  ) {
    suffix++;
  }
  const removedText = previousText.slice(prefix, prevLen - suffix);
  const insertedText = nextText.slice(prefix, nextLen - suffix);
  return { removedText, insertedText };
}

function parseViewerArgs(search, hash) {
  const queryText = String(search || '').replace(/^\?/, '');
  const hashText = String(hash || '').replace(/^#\??/, '');
  const queryParams = new URLSearchParams(queryText);
  const hashParams = new URLSearchParams(hashText);
  const params = new URLSearchParams(queryParams);

  hashParams.forEach((value, key) => {
    params.set(key, value);
  });

  return {
    hostPeerId: params.get('host') || '',
    debugEnabled: params.get('debug') === 'true'
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { diffMobileKeyboardText, parseViewerArgs };
}
