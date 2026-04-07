// Vipsee Viewer — connects to host, renders video, captures and sends input

const video = document.getElementById('remote-video');
const overlay = document.getElementById('connect-overlay');
const overlayInput = document.getElementById('overlay-peer-input');
const overlayConnect = document.getElementById('overlay-connect');
const overlayError = document.getElementById('overlay-error');
const overlayMsg = document.getElementById('overlay-msg');
const statusEl = document.getElementById('connection-status');
const urlBar = document.getElementById('url-bar');
const tabSelect = document.getElementById('tab-select');

let peer = null;
let dataConn = null;
let mediaCall = null;
let remoteViewport = { width: 1920, height: 1080 };
let currentTabId = null;

// --- Reconnect state ---
let connectedPeerId = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 20;

// --- Mousemove throttle ---
const MOUSEMOVE_INTERVAL_MS = 16; // ~60fps
let lastMousemoveTime = 0;
let pendingMousemove = null;
let mousemoveRafId = null;

// Check URL params for peer ID
const params = new URLSearchParams(location.search);
const initialPeerId = params.get('peerId');
if (initialPeerId) {
  overlayInput.value = initialPeerId;
}

// --- Connection ---

overlayConnect.addEventListener('click', () => startConnect(overlayInput.value.trim()));
overlayInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startConnect(overlayInput.value.trim());
});

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

function startConnect(hostPeerId) {
  if (!hostPeerId) return;
  connectedPeerId = hostPeerId;
  reconnectAttempts = 0;
  clearReconnectTimer();
  connect(hostPeerId);
}

function connect(hostPeerId) {
  // Clean up any previous peer
  cleanup();

  overlayError.textContent = '';
  overlayMsg.textContent = reconnectAttempts > 0
    ? `Reconnecting (attempt ${reconnectAttempts})...`
    : '';
  setStatus(reconnectAttempts > 0 ? 'Reconnecting...' : 'Connecting...', reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

  peer = new Peer();

  peer.on('open', () => {
    dataConn = peer.connect(hostPeerId, { reliable: true });

    dataConn.on('open', () => {
      reconnectAttempts = 0;
      clearReconnectTimer();
      setStatus('Connected', 'connected');
      overlay.classList.add('hidden');
      overlayMsg.textContent = '';
      console.log('[VIPSEE:viewer] Data channel open, connected to host');

      // Request tab list on connect
      sendControl({ type: 'listTabs' });
    });

    dataConn.on('data', (data) => {
      const msg = typeof data === 'string' ? JSON.parse(data) : data;
      handleHostMessage(msg);
    });

    dataConn.on('close', () => {
      handleDisconnect('Data channel closed');
    });

    dataConn.on('error', (err) => {
      console.error('Data connection error:', err);
    });

    // Request media call
    mediaCall = peer.call(hostPeerId, createEmptyStream());

    mediaCall.on('stream', (remoteStream) => {
      video.srcObject = remoteStream;
      console.log('[VIPSEE:viewer] Remote stream received, tracks:', remoteStream.getTracks().length);
      video.play().catch(e => console.error('[VIPSEE:viewer] play() failed:', e));
    });

    mediaCall.on('close', () => {
      video.srcObject = null;
    });

    mediaCall.on('error', (err) => {
      console.error('Call error:', err);
    });
  });

  peer.on('error', (err) => {
    console.error('Peer error:', err);
    const msg = err.type === 'peer-unavailable'
      ? 'Host not found — check the peer ID'
      : (err.message || 'Connection failed');
    overlayError.textContent = msg;

    // Don't auto-reconnect for peer-unavailable (wrong ID)
    if (err.type === 'peer-unavailable') {
      setStatus('Not found', 'error');
      overlay.classList.remove('hidden');
    } else {
      handleDisconnect(msg);
    }
  });

  peer.on('disconnected', () => {
    // PeerJS lost connection to signaling server
    if (peer && !peer.destroyed) {
      peer.reconnect();
    }
  });
}

function handleDisconnect(reason) {
  setStatus('Disconnected', '');
  video.srcObject = null;
  currentTabId = null;

  if (connectedPeerId && reconnectAttempts < RECONNECT_MAX_ATTEMPTS) {
    scheduleReconnect();
  } else {
    overlay.classList.remove('hidden');
    overlayMsg.textContent = '';
    if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      overlayError.textContent = 'Gave up reconnecting — try manually';
    }
  }
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(1.5, reconnectAttempts - 1),
    RECONNECT_MAX_MS
  );
  setStatus(`Reconnecting in ${Math.round(delay / 1000)}s...`, 'reconnecting');
  overlay.classList.remove('hidden');
  overlayMsg.textContent = `Connection lost. Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`;

  reconnectTimer = setTimeout(() => {
    connect(connectedPeerId);
  }, delay);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function cleanup() {
  if (dataConn) {
    try { dataConn.close(); } catch (e) {}
    dataConn = null;
  }
  if (mediaCall) {
    try { mediaCall.close(); } catch (e) {}
    mediaCall = null;
  }
  if (peer) {
    try { peer.destroy(); } catch (e) {}
    peer = null;
  }
  if (mousemoveRafId) {
    cancelAnimationFrame(mousemoveRafId);
    mousemoveRafId = null;
  }
  pendingMousemove = null;
}

// Create a dummy stream so PeerJS call() works (it requires a local stream)
function createEmptyStream() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  return canvas.captureStream(0);
}

// --- Host messages ---

function handleHostMessage(msg) {
  switch (msg.type) {
    case 'viewport':
      remoteViewport.width = msg.width;
      remoteViewport.height = msg.height;
      console.log('[VIPSEE:viewer] Remote viewport:', msg.width, 'x', msg.height);
      break;

    case 'tabChanged':
      urlBar.value = msg.url || '';
      currentTabId = msg.tabId;
      document.title = `Vipsee — ${msg.title || 'Remote Tab'}`;
      // Highlight active tab in dropdown
      if (tabSelect.value !== String(msg.tabId)) {
        tabSelect.value = String(msg.tabId);
      }
      break;

    case 'tabList':
      populateTabDropdown(msg.tabs);
      break;

    case 'status':
      if (!msg.capturing) {
        setStatus('Tab closed', 'error');
      }
      break;
  }
}

// --- Tab dropdown (Phase 3) ---

function populateTabDropdown(tabs) {
  const prevValue = tabSelect.value;
  tabSelect.innerHTML = '';

  for (const tab of tabs) {
    const opt = document.createElement('option');
    opt.value = tab.id;
    // Truncate long titles
    const title = tab.title.length > 40
      ? tab.title.slice(0, 37) + '...'
      : tab.title;
    opt.textContent = tab.active ? `● ${title}` : `  ${title}`;
    if (tab.active) {
      opt.selected = true;
      currentTabId = tab.id;
    }
    tabSelect.appendChild(opt);
  }

  // Restore selection if the active tab didn't change
  if (!tabs.some(t => t.active) && prevValue) {
    tabSelect.value = prevValue;
  }
}

tabSelect.addEventListener('change', () => {
  const tabId = parseInt(tabSelect.value, 10);
  if (tabId && tabId !== currentTabId) {
    sendControl({ type: 'switchTab', tabId });
  }
});

// --- Send helpers ---

function sendControl(evt) {
  if (!dataConn || !dataConn.open) {
    console.warn('[VIPSEE:viewer] sendControl dropped (no connection):', evt.type);
    return;
  }
  console.log('[VIPSEE:viewer] Sending control:', evt.type);
  dataConn.send(JSON.stringify(evt));
}

function sendInput(evt) {
  if (!dataConn || !dataConn.open) return;
  // Log non-move events to avoid spam
  if (evt.type !== 'mouse' || evt.action !== 'move') {
    console.log('[VIPSEE:viewer] Sending input:', evt.type, evt.action,
      evt.type === 'mouse' ? `(${evt.x},${evt.y})` : evt.key);
  }
  dataConn.send(JSON.stringify(evt));
}

// --- Nav bar (Phase 3) ---

document.getElementById('btn-back').addEventListener('click', () => {
  sendControl({ type: 'goBack' });
});

document.getElementById('btn-forward').addEventListener('click', () => {
  sendControl({ type: 'goForward' });
});

document.getElementById('btn-reload').addEventListener('click', () => {
  sendControl({ type: 'reload' });
});

urlBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const url = urlBar.value.trim();
    if (url) {
      sendControl({ type: 'navigate', url });
    }
    // Return focus to video for input capture
    video.focus();
  }
});

document.getElementById('btn-new-tab').addEventListener('click', () => {
  const url = prompt('URL for new tab (leave empty for blank tab):');
  if (url === null) return; // cancelled
  sendControl({ type: 'newTab', url: url.trim() || undefined });
});

document.getElementById('btn-close-tab').addEventListener('click', () => {
  if (currentTabId) {
    sendControl({ type: 'closeTab', tabId: currentTabId });
  }
});

// --- Coordinate mapping ---

function getModifiers(e) {
  let m = 0;
  if (e.altKey) m |= 1;
  if (e.ctrlKey) m |= 2;
  if (e.metaKey) m |= 4;
  if (e.shiftKey) m |= 8;
  return m;
}

function mapCoords(e) {
  // Video element is explicitly sized to match aspect ratio (no object-fit),
  // so its bounding rect maps directly to the remote viewport.
  const rect = video.getBoundingClientRect();

  const localX = e.clientX - rect.left;
  const localY = e.clientY - rect.top;

  const x = Math.round((localX / rect.width) * remoteViewport.width);
  const y = Math.round((localY / rect.height) * remoteViewport.height);

  if (isNaN(x) || isNaN(y) || x < -100 || y < -100 ||
      x > remoteViewport.width + 100 || y > remoteViewport.height + 100) {
    console.warn('[VIPSEE:viewer] Bad coords:', x, y,
      '| rect:', rect.width, 'x', rect.height,
      '| remoteViewport:', remoteViewport.width, 'x', remoteViewport.height);
  }

  return { x, y };
}

const BUTTON_MAP = ['left', 'middle', 'right'];

// --- Mouse events (with throttled mousemove) ---

video.addEventListener('mousemove', (e) => {
  const now = performance.now();
  const { x, y } = mapCoords(e);
  const evt = { type: 'mouse', action: 'move', x, y, modifiers: getModifiers(e) };

  if (now - lastMousemoveTime >= MOUSEMOVE_INTERVAL_MS) {
    sendInput(evt);
    lastMousemoveTime = now;
    pendingMousemove = null;
  } else {
    // Buffer the latest move and flush on next frame
    pendingMousemove = evt;
    if (!mousemoveRafId) {
      mousemoveRafId = requestAnimationFrame(() => {
        mousemoveRafId = null;
        if (pendingMousemove) {
          sendInput(pendingMousemove);
          lastMousemoveTime = performance.now();
          pendingMousemove = null;
        }
      });
    }
  }
});

video.addEventListener('mousedown', (e) => {
  e.preventDefault();
  // preventDefault suppresses default focus, so we must focus explicitly
  video.focus();
  const { x, y } = mapCoords(e);
  sendInput({
    type: 'mouse', action: 'down', x, y,
    button: BUTTON_MAP[e.button] || 'left',
    clickCount: e.detail || 1,
    modifiers: getModifiers(e)
  });
});

video.addEventListener('mouseup', (e) => {
  e.preventDefault();
  const { x, y } = mapCoords(e);
  sendInput({
    type: 'mouse', action: 'up', x, y,
    button: BUTTON_MAP[e.button] || 'left',
    modifiers: getModifiers(e)
  });
});

video.addEventListener('wheel', (e) => {
  e.preventDefault();
  const { x, y } = mapCoords(e);
  sendInput({
    type: 'mouse', action: 'wheel', x, y,
    deltaX: e.deltaX,
    deltaY: e.deltaY
  });
}, { passive: false });

video.addEventListener('contextmenu', (e) => e.preventDefault());

// --- Keyboard events ---

video.setAttribute('tabindex', '0');

function shouldCapture(e) {
  // Only capture when video is focused — allows typing in URL bar etc.
  return document.activeElement === video;
}

video.addEventListener('keydown', (e) => {
  if (!shouldCapture(e)) return;

  // Prevent local browser shortcuts
  e.preventDefault();
  e.stopPropagation();

  const evt = {
    type: 'key', action: 'down',
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    modifiers: getModifiers(e)
  };
  if (e.key.length === 1) {
    evt.text = e.key;
    evt.unmodifiedText = e.key;
  }
  sendInput(evt);
}, true);

video.addEventListener('keyup', (e) => {
  if (!shouldCapture(e)) return;

  e.preventDefault();
  e.stopPropagation();

  sendInput({
    type: 'key', action: 'up',
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    modifiers: getModifiers(e)
  });
}, true);

// --- Video sizing (JS-driven, not CSS) ---

// No JS resizing. Video renders at 1:1 native pixels.
// Focus video on click for keyboard capture
video.addEventListener('click', () => video.focus());
video.addEventListener('playing', () => {
  video.focus();
  console.log('[VIPSEE:viewer] Video playing — intrinsic:', video.videoWidth, 'x', video.videoHeight);
});

// --- Clean disconnect on page unload ---

window.addEventListener('beforeunload', () => {
  cleanup();
});

// --- Auto-connect if peer ID was provided ---

if (initialPeerId) {
  startConnect(initialPeerId);
}
