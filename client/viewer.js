// LobsterLink Viewer - connects to host, renders video, captures and sends input

const video = document.getElementById('remote-video');
const videoContainer = document.getElementById('video-container');
const overlay = document.getElementById('connect-overlay');
const overlayInput = document.getElementById('overlay-peer-input');
const overlayConnect = document.getElementById('overlay-connect');
const overlayError = document.getElementById('overlay-error');
const overlayMsg = document.getElementById('overlay-msg');
const statusEl = document.getElementById('connection-status');
const urlBar = document.getElementById('url-bar');
const tabSelect = document.getElementById('tab-select');
const debugPanel = document.getElementById('debug-panel');
const mobileKeyboardButton = document.getElementById('btn-mobile-keyboard');
const mobileKeyboardInput = document.getElementById('mobile-keyboard-input');

let peer = null;
let dataConn = null;
let mediaCall = null;
let remoteViewport = { width: 1920, height: 1080 };
let currentTabId = null;
let hostMetrics = null;
let isMobileInputMode = false;
let lastMobileKeyboardValue = '';
let mobileKeyboardRefocusPending = false;

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

// --- Touch state ---
const TOUCH_TAP_MAX_DISTANCE = 12;
const TOUCH_MOUSE_SUPPRESS_MS = 800;
let activeTouchGesture = null;
let suppressMouseUntil = 0;

// --- Viewport follow state ---
const VIEWPORT_FOLLOW_DEBOUNCE_MS = 250;
const VIEWPORT_FOLLOW_PENDING_MS = 1500;
let lastRequestedViewport = null;
let viewportFollowTimer = null;

// Check URL params for peer ID and debug flag
const params = new URLSearchParams(location.search);
const initialPeerId = params.get('host');
const debugEnabled = params.get('debug') === 'true';

// Debug-gated logging - silences viewer console output unless ?debug=true
const log = debugEnabled ? console.log.bind(console) : () => {};
const warn = debugEnabled ? console.warn.bind(console) : () => {};
const error = debugEnabled ? console.error.bind(console) : () => {};

if (!debugEnabled) {
  debugPanel.style.display = 'none';
}

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
      log('[LOBSTERLINK:viewer] Data channel open, connected to host');

      // Request tab list on connect
      sendControl({ type: 'listTabs' });
      scheduleAutoViewport({ immediate: true });
    });

    dataConn.on('data', (data) => {
      const msg = typeof data === 'string' ? JSON.parse(data) : data;
      handleHostMessage(msg);
    });

    dataConn.on('close', () => {
      handleDisconnect('Data channel closed');
    });

    dataConn.on('error', (err) => {
      error('Data connection error:', err);
    });

    // Request media call
    mediaCall = peer.call(hostPeerId, createEmptyStream());

    mediaCall.on('stream', (remoteStream) => {
      video.srcObject = remoteStream;
      log('[LOBSTERLINK:viewer] Remote stream received, tracks:', remoteStream.getTracks().length);
      layoutVideo();
      updateDebugPanel();
      video.play().catch(e => error('[LOBSTERLINK:viewer] play() failed:', e));
    });

    mediaCall.on('close', () => {
      video.srcObject = null;
    });

    mediaCall.on('error', (err) => {
      error('Call error:', err);
    });
  });

  peer.on('error', (err) => {
    error('Peer error:', err);
    const msg = err.type === 'peer-unavailable'
      ? 'Host not found - check the peer ID'
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
      overlayError.textContent = 'Gave up reconnecting - try manually';
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

function updateDebugPanel() {
  if (!debugEnabled) return;
  const rect = video.getBoundingClientRect();
  const inputViewport = getHostViewportSize();
  const track = video.srcObject ? video.srcObject.getVideoTracks()[0] : null;
  const trackSettings = track ? track.getSettings() : null;

  const lines = [
    `mode: ${hostMetrics?.captureMode || 'unknown'}`,
    `host zoom: ${hostMetrics?.zoomFactor ?? 'n/a'}`,
    `host window: ${hostMetrics?.windowWidth ?? 'n/a'}x${hostMetrics?.windowHeight ?? 'n/a'}`,
    `host tab: ${hostMetrics?.tabWidth ?? 'n/a'}x${hostMetrics?.tabHeight ?? 'n/a'}`,
    `host viewport: ${hostMetrics?.viewportWidth ?? 'n/a'}x${hostMetrics?.viewportHeight ?? 'n/a'}`,
    `host dpr: ${hostMetrics?.devicePixelRatio ?? 'n/a'}`,
    `input viewport (mapping target): ${inputViewport.width}x${inputViewport.height}`,
    `video intrinsic: ${video.videoWidth || 0}x${video.videoHeight || 0}`,
    `track settings: ${trackSettings?.width ?? 'n/a'}x${trackSettings?.height ?? 'n/a'}`,
    `video bbox: ${Math.round(rect.width)}x${Math.round(rect.height)} @ ${Math.round(rect.left)},${Math.round(rect.top)}`,
    `viewer window: ${window.innerWidth}x${window.innerHeight}`
  ];

  debugPanel.textContent = lines.join('\n');
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
  if (viewportFollowTimer) {
    clearTimeout(viewportFollowTimer);
    viewportFollowTimer = null;
  }
  pendingMousemove = null;
  activeTouchGesture = null;
  hostMetrics = null;
  lastRequestedViewport = null;
  updateDebugPanel();
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
      log('[LOBSTERLINK:viewer] Remote viewport:', msg.width, 'x', msg.height);
      layoutVideo();
      updateDebugPanel();
      break;

    case 'tabChanged':
      urlBar.value = msg.url || '';
      currentTabId = msg.tabId;
      document.title = `LobsterLink - ${msg.title || 'Remote Tab'}`;
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

    case 'hostMode':
      setStatus(`Connected (${msg.mode})`, 'connected');
      hostMetrics = { ...(hostMetrics || {}), captureMode: msg.mode };
      layoutVideo();
      updateDebugPanel();
      scheduleAutoViewport({ immediate: true });
      break;

    case 'hostMetrics':
      hostMetrics = msg;
      layoutVideo();
      updateDebugPanel();
      break;

    case 'clipboardResult':
      writeClipboardText(msg.text || '');
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
    warn('[LOBSTERLINK:viewer] sendControl dropped (no connection):', evt.type);
    return;
  }
  log('[LOBSTERLINK:viewer] Sending control:', evt.type);
  dataConn.send(JSON.stringify(evt));
}

function sameViewportSize(a, b) {
  return !!a && !!b && a.width === b.width && a.height === b.height;
}

function getDesiredHostViewport() {
  // The video container — the viewer area reserved below the nav bar — is
  // the sole host interaction plane. Ask the host to set its viewport to
  // exactly the container's current client size (combined with the outer-
  // vs-inner delta fix in background.setHostViewport, the host's inner tab
  // viewport ends up equal to this value). That makes the mapping identity
  // inside the video rect: every viewer pixel in the plane == one host
  // pixel. The nav strip is outside this plane by construction.
  const width = Math.round(videoContainer.clientWidth || 0);
  const height = Math.round(videoContainer.clientHeight || 0);

  if (width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

function getCurrentHostViewport() {
  const width = Math.round(hostMetrics?.viewportWidth || 0);
  const height = Math.round(hostMetrics?.viewportHeight || 0);

  if (width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

function shouldAutoFollowViewport() {
  return hostMetrics?.captureMode === 'screencast';
}

function requestAutoViewport() {
  viewportFollowTimer = null;

  if (!dataConn || !dataConn.open) return;
  if (!shouldAutoFollowViewport()) return;

  const desiredViewport = getDesiredHostViewport();
  if (!desiredViewport) return;

  const currentViewport = getCurrentHostViewport();
  if (sameViewportSize(currentViewport, desiredViewport)) {
    lastRequestedViewport = { ...desiredViewport, at: Date.now() };
    return;
  }

  if (sameViewportSize(lastRequestedViewport, desiredViewport) &&
      (Date.now() - (lastRequestedViewport?.at || 0)) < VIEWPORT_FOLLOW_PENDING_MS) {
    return;
  }

  sendControl({ type: 'setViewport', width: desiredViewport.width, height: desiredViewport.height });
  lastRequestedViewport = { ...desiredViewport, at: Date.now() };
}

function scheduleAutoViewport({ immediate = false } = {}) {
  if (viewportFollowTimer) {
    clearTimeout(viewportFollowTimer);
    viewportFollowTimer = null;
  }

  if (immediate) {
    requestAutoViewport();
    return;
  }

  viewportFollowTimer = setTimeout(() => {
    requestAutoViewport();
  }, VIEWPORT_FOLLOW_DEBOUNCE_MS);
}

function sendInput(evt) {
  if (!dataConn || !dataConn.open) return;
  // Log non-move events to avoid spam
  if (evt.type !== 'mouse' || evt.action !== 'move') {
    log('[LOBSTERLINK:viewer] Sending input:', evt.type, evt.action,
      evt.type === 'mouse' ? `(${evt.x},${evt.y})` : (evt.key || evt.text || ''));
  }
  dataConn.send(JSON.stringify(evt));
}

function sendKeyTap(key, code, keyCode) {
  const downEvent = {
    type: 'key',
    action: 'down',
    key,
    code,
    keyCode,
    modifiers: 0
  };
  if (key.length === 1) {
    downEvent.text = key;
    downEvent.unmodifiedText = key;
  }

  sendInput(downEvent);
  sendInput({
    type: 'key',
    action: 'up',
    key,
    code,
    keyCode,
    modifiers: 0
  });
}

async function writeClipboardText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    const fallback = document.createElement('textarea');
    fallback.value = text;
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    fallback.style.pointerEvents = 'none';
    document.body.appendChild(fallback);
    fallback.focus();
    fallback.select();
    document.execCommand('copy');
    fallback.remove();
  }
}

function focusVideoForInput() {
  if (!isMobileInputMode) {
    video.focus();
  }
}

function focusMobileKeyboardInput() {
  if (!mobileKeyboardInput) return;
  isMobileInputMode = true;
  mobileKeyboardInput.focus({ preventScroll: true });
  try {
    const len = (mobileKeyboardInput.value || '').length;
    mobileKeyboardInput.setSelectionRange(len, len);
  } catch (e) {}
}

function resetMobileKeyboardInput() {
  if (mobileKeyboardInput) {
    mobileKeyboardInput.value = '';
  }
  lastMobileKeyboardValue = '';
}

function maintainMobileKeyboardFocus() {
  if (!isMobileInputMode) return;
  mobileKeyboardRefocusPending = true;
  requestAnimationFrame(() => {
    if (!mobileKeyboardRefocusPending) return;
    focusMobileKeyboardInput();
    mobileKeyboardRefocusPending = false;
  });
}

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
    focusVideoForInput();
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

document.getElementById('viewport-select').addEventListener('change', (e) => {
  const val = e.target.value;
  if (!val) return;
  const [w, h] = val.split('x').map(Number);
  if (w && h) {
    sendControl({ type: 'setViewport', width: w, height: h });
  }
  // Reset to label
  e.target.value = '';
});

if (mobileKeyboardButton && mobileKeyboardInput) {
  mobileKeyboardButton.addEventListener('click', (e) => {
    e.preventDefault();
    resetMobileKeyboardInput();
    focusMobileKeyboardInput();
  });

  mobileKeyboardInput.addEventListener('focus', () => {
    isMobileInputMode = true;
    mobileKeyboardRefocusPending = false;
    lastMobileKeyboardValue = mobileKeyboardInput.value || '';
  });

  mobileKeyboardInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (mobileKeyboardRefocusPending) return;
      isMobileInputMode = false;
      resetMobileKeyboardInput();
    }, 0);
  });

  mobileKeyboardInput.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      e.preventDefault();
      e.stopPropagation();
      sendKeyTap('Enter', 'Enter', 13);
    }
  });

  mobileKeyboardInput.addEventListener('input', (e) => {
    if (e.isComposing) return;
    const previousText = lastMobileKeyboardValue;
    const nextText = mobileKeyboardInput.value;
    const { removedText, insertedText } = diffMobileKeyboardText(previousText, nextText);

    if (removedText.length > 0) {
      const deleteKey = e.inputType === 'deleteContentForward'
        ? ['Delete', 'Delete', 46]
        : ['Backspace', 'Backspace', 8];
      for (let i = 0; i < removedText.length; i++) {
        sendKeyTap(...deleteKey);
      }
    }

    if (insertedText.length > 0) {
      sendInput({
        type: 'clipboard',
        action: 'pasteText',
        text: insertedText
      });
    }

    lastMobileKeyboardValue = mobileKeyboardInput.value;
  });
}

// --- Coordinate mapping ---

function getModifiers(e) {
  let m = 0;
  if (e.altKey) m |= 1;
  if (e.ctrlKey) m |= 2;
  if (e.metaKey) m |= 4;
  if (e.shiftKey) m |= 8;
  return m;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// --- 1:1 geometry contract (screencast/raw-CDP) ---
//
// Contract from the host: the outbound video frame's entire extent
// corresponds to the host page's *layout* viewport (hostMetrics.viewport{W,H})
// in CSS pixels. Aspect ratio is preserved end-to-end. No cropping, no
// letterboxing inside the frame.
//
// Given that contract, the only inputs needed for viewer→CDP mapping are:
//   1. the video element's actual painted box on the viewer page
//      (video.getBoundingClientRect() — the ground truth of what the user sees)
//   2. the host layout viewport dimensions (hostMetrics.viewportWidth/Height)
//
// We explicitly do NOT use visualViewport*: CDP Input.dispatchMouseEvent
// expects layout-viewport coordinates, and elementFromPoint on the host uses
// the same frame. Pinch-zoom / virtual keyboard must not shift the mapping.
// We also no longer reconstruct a "content crop" from frame × DPR heuristics;
// that inference was the source of drift whenever the host and viewer were
// briefly out of sync after resize/navigation/DPR changes.

function getHostViewportSize() {
  const width = Math.round(hostMetrics?.viewportWidth || 0);
  const height = Math.round(hostMetrics?.viewportHeight || 0);
  if (width > 0 && height > 0) {
    return { width, height };
  }
  return { width: remoteViewport.width, height: remoteViewport.height };
}

function getSourceFrameSize() {
  const track = video.srcObject ? video.srcObject.getVideoTracks()[0] : null;
  const trackSettings = track ? track.getSettings() : null;
  const width = video.videoWidth || trackSettings?.width || remoteViewport.width || 1;
  const height = video.videoHeight || trackSettings?.height || remoteViewport.height || 1;
  return {
    width: Math.max(1, width),
    height: Math.max(1, height)
  };
}

function layoutVideo() {
  // Aspect-fit the video inside the container using the frame's own intrinsic
  // aspect ratio. Explicit width/height on the video element makes the
  // painted box equal to getBoundingClientRect() — no reconstruction, no
  // heuristics, no "rendered rect" vs "video box" disagreement.
  const containerWidth = videoContainer.clientWidth || 1;
  const containerHeight = videoContainer.clientHeight || 1;
  const frame = getSourceFrameSize();
  const scale = Math.min(containerWidth / frame.width, containerHeight / frame.height);
  const w = frame.width * scale;
  const h = frame.height * scale;
  video.style.left = `${(containerWidth - w) / 2}px`;
  video.style.top = `${(containerHeight - h) / 2}px`;
  video.style.width = `${w}px`;
  video.style.height = `${h}px`;
}

function mapCoordsFromClientPoint(clientX, clientY) {
  const viewport = getHostViewportSize();
  // Ground truth: the video's actual painted rect on screen.
  const rect = video.getBoundingClientRect();
  const safeWidth = rect.width || 1;
  const safeHeight = rect.height || 1;

  const localX = clamp(clientX - rect.left, 0, safeWidth);
  const localY = clamp(clientY - rect.top, 0, safeHeight);

  const x = clamp(Math.round((localX / safeWidth) * viewport.width), 0, Math.max(0, viewport.width - 1));
  const y = clamp(Math.round((localY / safeHeight) * viewport.height), 0, Math.max(0, viewport.height - 1));

  return { x, y };
}

function mapCoords(source) {
  return mapCoordsFromClientPoint(source.clientX, source.clientY);
}

function preventDefaultIfPossible(event) {
  if (event.cancelable) {
    event.preventDefault();
  }
}

function shouldIgnoreMouseEvent() {
  return performance.now() < suppressMouseUntil;
}

function findTouchById(touchList, identifier) {
  if (!touchList) return null;
  for (const touch of touchList) {
    if (touch.identifier === identifier) {
      return touch;
    }
  }
  return null;
}

const BUTTON_MAP = ['left', 'middle', 'right'];

// --- Mouse events (with throttled mousemove) ---
// Drag support: mousedown arms `dragActive`, and mousemove/mouseup listen at
// document level so the drag keeps producing events when the pointer leaves
// the video rect. `e.buttons` is the native bitmask of held buttons and is
// forwarded straight to CDP so the host sees a real drag, not a hover.

let dragActive = false;

function isPointOverVideo(clientX, clientY) {
  const rect = video.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right &&
         clientY >= rect.top && clientY <= rect.bottom;
}

function flushMousemove(evt) {
  const now = performance.now();
  if (now - lastMousemoveTime >= MOUSEMOVE_INTERVAL_MS) {
    sendInput(evt);
    lastMousemoveTime = now;
    pendingMousemove = null;
    return;
  }
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

function handleDocumentMousemove(e) {
  if (shouldIgnoreMouseEvent()) return;
  const isDragging = dragActive && e.buttons !== 0;
  if (!isDragging && !isPointOverVideo(e.clientX, e.clientY)) return;
  const { x, y } = mapCoords(e);
  flushMousemove({
    type: 'mouse', action: 'move', x, y,
    buttons: e.buttons,
    modifiers: getModifiers(e)
  });
}

document.addEventListener('mousemove', handleDocumentMousemove);

video.addEventListener('mousedown', (e) => {
  if (shouldIgnoreMouseEvent()) return;

  preventDefaultIfPossible(e);
  if (isMobileInputMode) {
    maintainMobileKeyboardFocus();
  } else {
    focusVideoForInput();
  }
  dragActive = true;
  const { x, y } = mapCoords(e);
  sendInput({
    type: 'mouse', action: 'down', x, y,
    button: BUTTON_MAP[e.button] || 'left',
    buttons: e.buttons,
    clickCount: e.detail || 1,
    modifiers: getModifiers(e)
  });
});

function handleDocumentMouseup(e) {
  if (!dragActive) return;
  if (shouldIgnoreMouseEvent()) return;
  preventDefaultIfPossible(e);
  const { x, y } = mapCoords(e);
  sendInput({
    type: 'mouse', action: 'up', x, y,
    button: BUTTON_MAP[e.button] || 'left',
    // Keep clickCount=1 on release so Blink emits a proper 'click' after a
    // matching press — custom controls (LinkedIn header dropdowns, etc.)
    // listen on 'click', not on raw mouseup.
    buttons: e.buttons,
    clickCount: 1,
    modifiers: getModifiers(e)
  });
  if (!e.buttons) {
    dragActive = false;
  }
}

document.addEventListener('mouseup', handleDocumentMouseup, true);

// If the viewer tab loses focus mid-drag, browsers may swallow the mouseup.
// Forge a no-click release so the host doesn't get stuck with a held button.
// clickCount:0 tells Blink *not* to synthesize a 'click' on this release —
// we just need to cancel the drag without triggering a stray activation.
window.addEventListener('blur', () => {
  if (!dragActive) return;
  dragActive = false;
  if (!dataConn || !dataConn.open) return;
  sendInput({
    type: 'mouse', action: 'up', x: 0, y: 0,
    button: 'left',
    buttons: 0,
    clickCount: 0,
    modifiers: 0
  });
});

video.addEventListener('wheel', (e) => {
  preventDefaultIfPossible(e);
  const { x, y } = mapCoords(e);
  // CDP expects pixel deltas; convert line/page modes
  let dx = e.deltaX;
  let dy = e.deltaY;
  if (e.deltaMode === 1) { dx *= 40; dy *= 40; }       // lines -> pixels
  else if (e.deltaMode === 2) { dx *= 800; dy *= 600; } // pages -> pixels
  sendInput({
    type: 'mouse', action: 'wheel', x, y,
    deltaX: dx,
    deltaY: dy
  });
}, { passive: false });

video.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) {
    activeTouchGesture = null;
    return;
  }

  preventDefaultIfPossible(e);
  if (isMobileInputMode) {
    maintainMobileKeyboardFocus();
  }
  const touch = e.touches[0];
  suppressMouseUntil = performance.now() + TOUCH_MOUSE_SUPPRESS_MS;
  activeTouchGesture = {
    identifier: touch.identifier,
    startClientX: touch.clientX,
    startClientY: touch.clientY,
    lastClientX: touch.clientX,
    lastClientY: touch.clientY,
    moved: false
  };
}, { passive: false });

video.addEventListener('touchmove', (e) => {
  if (!activeTouchGesture) return;

  const touch = findTouchById(e.touches, activeTouchGesture.identifier) || e.touches[0];
  if (!touch) return;

  preventDefaultIfPossible(e);

  const totalDx = touch.clientX - activeTouchGesture.startClientX;
  const totalDy = touch.clientY - activeTouchGesture.startClientY;
  if (!activeTouchGesture.moved && Math.hypot(totalDx, totalDy) >= TOUCH_TAP_MAX_DISTANCE) {
    activeTouchGesture.moved = true;
  }

  const dx = touch.clientX - activeTouchGesture.lastClientX;
  const dy = touch.clientY - activeTouchGesture.lastClientY;
  activeTouchGesture.lastClientX = touch.clientX;
  activeTouchGesture.lastClientY = touch.clientY;

  if (!dx && !dy) return;

  const { x, y } = mapCoords(touch);
  sendInput({
    type: 'mouse',
    action: 'wheel',
    x,
    y,
    deltaX: -dx,
    deltaY: -dy
  });
}, { passive: false });

video.addEventListener('touchend', (e) => {
  if (!activeTouchGesture) return;

  const touch = findTouchById(e.changedTouches, activeTouchGesture.identifier);
  if (!touch) {
    activeTouchGesture = null;
    return;
  }

  preventDefaultIfPossible(e);
  suppressMouseUntil = performance.now() + TOUCH_MOUSE_SUPPRESS_MS;

  const totalDx = touch.clientX - activeTouchGesture.startClientX;
  const totalDy = touch.clientY - activeTouchGesture.startClientY;
  const isTap = !activeTouchGesture.moved && Math.hypot(totalDx, totalDy) < TOUCH_TAP_MAX_DISTANCE;

  if (isTap) {
    if (isMobileInputMode) {
      maintainMobileKeyboardFocus();
    }
    const { x, y } = mapCoords(touch);
    sendInput({
      type: 'mouse',
      action: 'down',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      modifiers: 0
    });
    sendInput({
      type: 'mouse',
      action: 'up',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      modifiers: 0
    });
  }

  activeTouchGesture = null;
}, { passive: false });

video.addEventListener('touchcancel', (e) => {
  if (!activeTouchGesture) return;
  preventDefaultIfPossible(e);
  activeTouchGesture = null;
  suppressMouseUntil = performance.now() + TOUCH_MOUSE_SUPPRESS_MS;
}, { passive: false });

video.addEventListener('contextmenu', (e) => e.preventDefault());

// --- Keyboard events ---
// Capture on the document so keys work regardless of which element has focus,
// except when typing in the URL bar or other nav inputs.

video.setAttribute('tabindex', '0');

function isNavInput(el) {
  return el && (el.id === 'url-bar' || el.id === 'overlay-peer-input' || el.id === 'mobile-keyboard-input' ||
    el.tagName === 'SELECT');
}

function isClipboardShortcutKey(e) {
  return (e.ctrlKey || e.metaKey) && !e.altKey &&
    ['c', 'x', 'v', 'C', 'X', 'V'].includes(e.key);
}

document.addEventListener('keydown', (e) => {
  if (!dataConn || !dataConn.open) return;
  if (isNavInput(document.activeElement)) return;
  if (isClipboardShortcutKey(e)) return;

  preventDefaultIfPossible(e);
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

document.addEventListener('keyup', (e) => {
  if (!dataConn || !dataConn.open) return;
  if (isNavInput(document.activeElement)) return;
  if (isClipboardShortcutKey(e)) return;

  preventDefaultIfPossible(e);
  e.stopPropagation();

  sendInput({
    type: 'key', action: 'up',
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    modifiers: getModifiers(e)
  });
}, true);

document.addEventListener('paste', (e) => {
  if (!dataConn || !dataConn.open) return;
  if (isNavInput(document.activeElement)) return;

  preventDefaultIfPossible(e);
  e.stopPropagation();
  sendInput({
    type: 'clipboard',
    action: 'pasteText',
    text: e.clipboardData?.getData('text/plain') || ''
  });
}, true);

document.addEventListener('copy', (e) => {
  if (!dataConn || !dataConn.open) return;
  if (isNavInput(document.activeElement)) return;

  preventDefaultIfPossible(e);
  e.stopPropagation();
  sendInput({
    type: 'clipboard',
    action: 'copySelection'
  });
}, true);

document.addEventListener('cut', (e) => {
  if (!dataConn || !dataConn.open) return;
  if (isNavInput(document.activeElement)) return;

  preventDefaultIfPossible(e);
  e.stopPropagation();
  sendInput({
    type: 'clipboard',
    action: 'cutSelection'
  });
}, true);

video.addEventListener('click', () => {
  if (shouldIgnoreMouseEvent()) return;
  if (isMobileInputMode) {
    maintainMobileKeyboardFocus();
  } else {
    focusVideoForInput();
  }
});
video.addEventListener('loadedmetadata', () => {
  layoutVideo();
  log('[LOBSTERLINK:viewer] Video metadata - intrinsic:',
    video.videoWidth, 'x', video.videoHeight,
    '| remote viewport:', remoteViewport.width, 'x', remoteViewport.height);
  updateDebugPanel();
});
video.addEventListener('playing', () => {
  layoutVideo();
  focusVideoForInput();
  log('[LOBSTERLINK:viewer] Video playing - intrinsic:',
    video.videoWidth, 'x', video.videoHeight,
    '| remote viewport:', remoteViewport.width, 'x', remoteViewport.height);
  updateDebugPanel();
});
window.addEventListener('resize', () => {
  layoutVideo();
  updateDebugPanel();
  scheduleAutoViewport();
});
setInterval(updateDebugPanel, 500);

// --- Clean disconnect on page unload ---

window.addEventListener('beforeunload', () => {
  cleanup();
});

// --- Same-window warning ---

// If viewer is in the same window as the host tab, the host tab gets
// backgrounded and Chrome throttles/freezes its capture stream.
async function checkSameWindow() {
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.runtime) return;
  try {
    const thisTab = await chrome.tabs.getCurrent();
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
    if (!status || !status.hosting || !thisTab) return;

    // Find the host's captured tab
    const allTabs = await chrome.tabs.query({ windowId: thisTab.windowId });
    // We can't know the exact captured tabId from here, but if hosting is
    // active and this viewer is in the same window, warn.
    if (allTabs.length > 1) {
      const warn = document.createElement('div');
      warn.style.cssText = 'position:fixed;top:44px;left:0;right:0;z-index:20;padding:6px 12px;background:#4a3a1a;color:#f0c055;font-size:12px;text-align:center;font-family:system-ui,sans-serif;';
      warn.textContent = 'Tip: Move this viewer tab to a separate window for best results (right-click tab -> Move to new window). Same-window hosting may freeze the video.';
      document.body.appendChild(warn);
      // Auto-dismiss after 10 seconds
      setTimeout(() => warn.remove(), 10000);
    }
  } catch (e) {
    // Not critical, ignore
  }
}
checkSameWindow();

// --- Auto-connect if peer ID was provided ---

if (initialPeerId) {
  startConnect(initialPeerId);
}
