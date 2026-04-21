const modeSelect = document.getElementById('mode-select');
const hostPanel = document.getElementById('host-panel');
const viewerPanel = document.getElementById('viewer-panel');
const bridgeButton = document.getElementById('btn-bridge');

function showPanel(panel) {
  modeSelect.style.display = 'none';
  hostPanel.classList.remove('active');
  viewerPanel.classList.remove('active');
  if (panel) panel.classList.add('active');
  else modeSelect.style.display = 'block';
}

document.getElementById('btn-host').addEventListener('click', () => showPanel(hostPanel));
document.getElementById('btn-viewer').addEventListener('click', () => showPanel(viewerPanel));
document.getElementById('host-back').addEventListener('click', () => showPanel(null));
document.getElementById('viewer-back').addEventListener('click', () => showPanel(null));
bridgeButton.addEventListener('click', async () => {
  const url = chrome.runtime.getURL('bridge.html');
  await chrome.tabs.create({ url });
  setTimeout(() => window.close(), 150);
});

// Host mode
const hostStart = document.getElementById('host-start');
const hostStop = document.getElementById('host-stop');
const hostPeerId = document.getElementById('host-peer-id');
const hostStatus = document.getElementById('host-status');

function isForbiddenTab(tab) {
  if (!tab || !tab.url) return true;
  return tab.url.startsWith('chrome-extension://') ||
    tab.url.startsWith('chrome://') ||
    tab.url.startsWith('edge://') ||
    tab.url.startsWith('about:');
}

hostStart.addEventListener('click', async () => {
  hostStart.disabled = true;
  hostStatus.textContent = 'Starting...';
  hostStatus.className = 'status';

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || isForbiddenTab(activeTab)) {
    hostStatus.textContent = 'Switch to a normal web tab and retry';
    hostStatus.className = 'status error';
    hostStart.disabled = false;
    return;
  }

  const response = await chrome.runtime.sendMessage({
    action: 'startHostingCDP',
    tabId: activeTab.id
  });

  if (response.error) {
    hostStatus.textContent = response.error;
    hostStatus.className = 'status error';
    hostStart.disabled = false;
    return;
  }

  hostPeerId.textContent = response.peerId;
  hostPeerId.style.display = 'block';
  hostStart.style.display = 'none';
  hostStop.style.display = 'inline-block';
  hostStatus.textContent = 'Hosting — share the peer ID with the viewer';
  hostStatus.className = 'status ok';
});

hostStop.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'stopHosting' });
  hostPeerId.style.display = 'none';
  hostStop.style.display = 'none';
  hostStart.style.display = 'inline-block';
  hostStart.disabled = false;
  hostStatus.textContent = 'Stopped';
  hostStatus.className = 'status';
});

// Viewer mode
const viewerPeerInput = document.getElementById('viewer-peer-input');
const viewerConnect = document.getElementById('viewer-connect');
const viewerStatus = document.getElementById('viewer-status');

viewerConnect.addEventListener('click', async () => {
  const peerId = viewerPeerInput.value.trim();
  if (!peerId) return;

  viewerConnect.disabled = true;
  viewerStatus.textContent = 'Opening viewer...';

  // Open public LobsterLink viewer
  const url = `https://lobsterl.ink/?host=${encodeURIComponent(peerId)}`;
  chrome.tabs.create({ url });

  // Close popup after short delay
  setTimeout(() => window.close(), 300);
});

// Check current state on popup open
chrome.runtime.sendMessage({ action: 'getStatus' }).then((response) => {
  if (response && response.hosting) {
    showPanel(hostPanel);
    hostPeerId.textContent = response.peerId;
    hostPeerId.style.display = 'block';
    hostStart.style.display = 'none';
    hostStop.style.display = 'inline-block';
    hostStatus.textContent = response.viewerConnected
      ? 'Viewer connected'
      : 'Hosting — share the peer ID with the viewer';
    hostStatus.className = 'status ok';
  }
});
