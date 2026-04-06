const modeSelect = document.getElementById('mode-select');
const hostPanel = document.getElementById('host-panel');
const viewerPanel = document.getElementById('viewer-panel');

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

// Host mode
const hostStart = document.getElementById('host-start');
const hostStop = document.getElementById('host-stop');
const hostPeerId = document.getElementById('host-peer-id');
const hostStatus = document.getElementById('host-status');

hostStart.addEventListener('click', async () => {
  hostStart.disabled = true;
  hostStatus.textContent = 'Starting...';
  hostStatus.className = 'status';

  const response = await chrome.runtime.sendMessage({ action: 'startHosting' });
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

  // Open viewer in a new tab
  const url = chrome.runtime.getURL(`viewer.html?peerId=${encodeURIComponent(peerId)}`);
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
