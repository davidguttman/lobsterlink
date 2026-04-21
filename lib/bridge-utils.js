'use strict';

// LobsterLink bridge pure helpers.
// Classic-script-compatible: defines functions at script scope so the
// extension (bridge.html -> bridge.js) can pick them up as globals, and
// exports via CommonJS so Vitest can import them in Node.
//
// The canonical `buildViewerUrl` lives in `lib/signaling-config.js`. In the
// browser the bridge page loads `signaling-config.js` before this file, so
// `buildViewerUrl` is already defined as a global by the time bridge.js runs.
// In Vitest we require the sibling module directly and re-export it for
// tests that previously imported `buildViewerUrl` from this file.

function pickDefaultSelectedTab(state) {
  const tabs = state && state.tabs;
  if (!tabs || !tabs.length) return null;
  const capturedTabId = state.status && state.status.capturedTabId;
  if (capturedTabId && tabs.some((tab) => tab.id === capturedTabId)) {
    return capturedTabId;
  }
  const active = tabs.find((tab) => tab.active);
  return active ? active.id : tabs[0].id;
}

if (typeof module !== 'undefined' && module.exports) {
  const { buildViewerUrl } = require('./signaling-config.js');
  module.exports = { buildViewerUrl, pickDefaultSelectedTab };
}
