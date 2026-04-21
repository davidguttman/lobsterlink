'use strict';

const els = {
  viewerUrlBase: document.getElementById('viewerUrlBase'),
  peerJsHost: document.getElementById('peerJsHost'),
  peerJsPort: document.getElementById('peerJsPort'),
  peerJsPath: document.getElementById('peerJsPath'),
  peerJsSecure: document.getElementById('peerJsSecure'),
  save: document.getElementById('save'),
  reset: document.getElementById('reset'),
  status: document.getElementById('status')
};

let statusTimer = null;
function setStatus(text, tone = '') {
  els.status.textContent = text || '';
  els.status.className = `status${tone ? ` ${tone}` : ''}`;
  if (statusTimer) clearTimeout(statusTimer);
  if (text) {
    statusTimer = setTimeout(() => {
      els.status.textContent = '';
      els.status.className = 'status';
    }, 2500);
  }
}

function populate(config) {
  const normalized = normalizeSignalingConfig(config);
  els.viewerUrlBase.value = normalized.viewerUrlBase;
  els.peerJsHost.value = normalized.peerJsHost;
  els.peerJsPort.value = String(normalized.peerJsPort);
  els.peerJsPath.value = normalized.peerJsPath;
  els.peerJsSecure.checked = !!normalized.peerJsSecure;
}

async function load() {
  const stored = await chrome.storage.local.get(DEFAULT_SIGNALING_CONFIG);
  populate(stored);
}

async function save() {
  const input = {
    viewerUrlBase: els.viewerUrlBase.value,
    peerJsHost: els.peerJsHost.value,
    peerJsPort: els.peerJsPort.value,
    peerJsPath: els.peerJsPath.value,
    peerJsSecure: els.peerJsSecure.checked
  };
  const normalized = normalizeSignalingConfig(input);
  await chrome.storage.local.set(normalized);
  populate(normalized);
  setStatus('Saved', 'ok');
}

async function resetDefaults() {
  await chrome.storage.local.set(DEFAULT_SIGNALING_CONFIG);
  populate(DEFAULT_SIGNALING_CONFIG);
  setStatus('Reset to defaults', 'ok');
}

els.save.addEventListener('click', () => {
  save().catch((err) => setStatus(err.message || 'Save failed', 'error'));
});
els.reset.addEventListener('click', () => {
  resetDefaults().catch((err) => setStatus(err.message || 'Reset failed', 'error'));
});

load().catch((err) => setStatus(err.message || 'Load failed', 'error'));
