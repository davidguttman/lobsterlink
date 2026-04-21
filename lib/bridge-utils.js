'use strict';

// LobsterLink bridge pure helpers.
// Classic-script-compatible: defines functions at script scope so the
// extension (bridge.html -> bridge.js) can pick them up as globals, and
// exports via CommonJS so Vitest can import them in Node.

function buildViewerUrl(peerId) {
  if (!peerId) return '';
  return `https://lobsterl.ink/?host=${encodeURIComponent(peerId)}`;
}

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
  module.exports = { buildViewerUrl, pickDefaultSelectedTab };
}
