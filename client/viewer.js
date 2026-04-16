// LobsterLink Viewer — connects to host, renders video, captures and sends input

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

let peer = null;
let dataConn = null;
let mediaCall = null;
let remoteViewport = { width: 1920, height: 1080 };
let currentTabId = null;
let hostMetrics = null;

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

// Check URL params for peer ID and debug flag
const params = new URLSearchParams(location.search);
const initialPeerId = params.get('host');
const debugEnabled = params.get('debug') === 'true';

// Debug-gated logging — silences viewer console output unless ?debug=true
const log = debugEnabled ? console.log.bind(console) : () => {};
const warn = debugEnabled ? console.warn.bind(console) : () => {};
const error = debugEnabled ? console.error.bind(console) : () => {};

if (!debugEnabled) {
  debugPanel.style.display = 'none';
}

if (initialPeerId) {
  overlayInput.value = initialPeerId;
} else {
  document.body.classList.add('landing');
  initLandingPage();
}

function initLandingPage() {
  const copyBtn = document.getElementById('copy-install');
  if (!copyBtn) return;
  const installText = 'Install LobsterLink by following the instructions at https://github.com/davidguttman/lobsterlink/blob/master/AGENT-INSTALL.md';
  const defaultLabel = copyBtn.textContent;
  let resetTimer = null;
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(installText);
      copyBtn.textContent = 'Copied! Now paste into your agent.';
      copyBtn.classList.add('copied');
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        copyBtn.textContent = defaultLabel;
        copyBtn.classList.remove('copied');
      }, 2400);
    } catch (err) {
      copyBtn.textContent = 'Copy failed — select and copy manually';
    }
  });
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

function updateDebugPanel() {
  if (!debugEnabled) return;
  const rect = video.getBoundingClientRect();
  const crop = getSourceContentRect();
  const inputViewport = getInputViewportSize();
  const rendered = getRenderedVideoRect();
  const track = video.srcObject ? video.srcObject.getVideoTracks()[0] : null;
  const trackSettings = track ? track.getSettings() : null;

  const lines = [
    `mode: ${hostMetrics?.captureMode || 'unknown'}`,
    `host zoom: ${hostMetrics?.zoomFactor ?? 'n/a'}`,
    `host window: ${hostMetrics?.windowWidth ?? 'n/a'}x${hostMetrics?.windowHeight ?? 'n/a'}`,
    `host tab: ${hostMetrics?.tabWidth ?? 'n/a'}x${hostMetrics?.tabHeight ?? 'n/a'}`,
    `host viewport: ${hostMetrics?.viewportWidth ?? 'n/a'}x${hostMetrics?.viewportHeight ?? 'n/a'}`,
    `host visual viewport: ${hostMetrics?.visualViewportWidth ?? 'n/a'}x${hostMetrics?.visualViewportHeight ?? 'n/a'} @ ${hostMetrics?.visualViewportOffsetLeft ?? 'n/a'},${hostMetrics?.visualViewportOffsetTop ?? 'n/a'} scale ${hostMetrics?.visualViewportScale ?? 'n/a'}`,
    `host dpr: ${hostMetrics?.devicePixelRatio ?? 'n/a'}`,
    `remote viewport: ${remoteViewport.width}x${remoteViewport.height}`,
    `input viewport: ${inputViewport.width}x${inputViewport.height}`,
    `video intrinsic: ${video.videoWidth || 0}x${video.videoHeight || 0}`,
    `track settings: ${trackSettings?.width ?? 'n/a'}x${trackSettings?.height ?? 'n/a'}`,
    `source crop: ${Math.round(crop.width)}x${Math.round(crop.height)} @ ${Math.round(crop.x)},${Math.round(crop.y)}`,
    `video box: ${Math.round(rect.width)}x${Math.round(rect.height)}`,
    `rendered box: ${Math.round(rendered.width || 0)}x${Math.round(rendered.height || 0)}`,
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
  pendingMousemove = null;
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
      document.title = `LobsterLink — ${msg.title || 'Remote Tab'}`;
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

function sendInput(evt) {
  if (!dataConn || !dataConn.open) return;
  // Log non-move events to avoid spam
  if (evt.type !== 'mouse' || evt.action !== 'move') {
    log('[LOBSTERLINK:viewer] Sending input:', evt.type, evt.action,
      evt.type === 'mouse' ? `(${evt.x},${evt.y})` : (evt.key || evt.text || ''));
  }
  dataConn.send(JSON.stringify(evt));
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

function getInputViewportSize() {
  const width = hostMetrics?.visualViewportWidth || hostMetrics?.viewportWidth;
  const height = hostMetrics?.visualViewportHeight || hostMetrics?.viewportHeight;
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

function getSourceContentRect() {
  const frame = getSourceFrameSize();
  const viewport = getInputViewportSize();
  const devicePixelRatio = Math.max(1, hostMetrics?.devicePixelRatio || 1);

  if (!frame.width || !frame.height || !viewport.width || !viewport.height) {
    return { x: 0, y: 0, width: frame.width || 1, height: frame.height || 1 };
  }

  const expectedWidth = Math.max(1, viewport.width * devicePixelRatio);
  const expectedHeight = Math.max(1, viewport.height * devicePixelRatio);

  if (expectedWidth > 0 && expectedHeight > 0) {
    let contentWidth = expectedWidth;
    let contentHeight = expectedHeight;

    if (frame.width < expectedWidth || frame.height < expectedHeight) {
      const scale = Math.min(frame.width / expectedWidth, frame.height / expectedHeight);
      contentWidth = expectedWidth * scale;
      contentHeight = expectedHeight * scale;
    }

    if (contentWidth > 0 && contentHeight > 0 &&
        contentWidth <= frame.width + 1 && contentHeight <= frame.height + 1) {
      return {
        x: (frame.width - contentWidth) / 2,
        y: (frame.height - contentHeight) / 2,
        width: contentWidth,
        height: contentHeight
      };
    }
  }

  const frameAspect = frame.width / frame.height;
  const viewportAspect = viewport.width / viewport.height;

  if (Math.abs(frameAspect - viewportAspect) < 0.001) {
    return {
      x: 0,
      y: 0,
      width: frame.width,
      height: frame.height
    };
  }

  if (frameAspect > viewportAspect) {
    const width = frame.height * viewportAspect;
    return {
      x: (frame.width - width) / 2,
      y: 0,
      width,
      height: frame.height
    };
  }

  const height = frame.width / viewportAspect;
  return {
    x: 0,
    y: (frame.height - height) / 2,
    width: frame.width,
    height
  };
}

function getVideoLayout() {
  const containerRect = videoContainer.getBoundingClientRect();
  const containerWidth = videoContainer.clientWidth || containerRect.width || 1;
  const containerHeight = videoContainer.clientHeight || containerRect.height || 1;
  const frame = getSourceFrameSize();
  const crop = getSourceContentRect();
  const scale = Math.min(containerWidth / crop.width, containerHeight / crop.height);
  const renderedWidth = crop.width * scale;
  const renderedHeight = crop.height * scale;
  const renderedLeft = (containerWidth - renderedWidth) / 2;
  const renderedTop = (containerHeight - renderedHeight) / 2;

  return {
    frame,
    crop,
    scale,
    containerRect,
    renderedLeft,
    renderedTop,
    renderedWidth,
    renderedHeight,
    videoLeft: renderedLeft - (crop.x * scale),
    videoTop: renderedTop - (crop.y * scale),
    videoWidth: frame.width * scale,
    videoHeight: frame.height * scale
  };
}

function layoutVideo() {
  const layout = getVideoLayout();
  video.style.left = `${layout.videoLeft}px`;
  video.style.top = `${layout.videoTop}px`;
  video.style.width = `${layout.videoWidth}px`;
  video.style.height = `${layout.videoHeight}px`;
}

function getRenderedVideoRect() {
  const layout = getVideoLayout();
  return {
    left: layout.containerRect.left + layout.renderedLeft,
    top: layout.containerRect.top + layout.renderedTop,
    width: layout.renderedWidth,
    height: layout.renderedHeight
  };
}

function mapCoords(e) {
  const inputViewport = getInputViewportSize();
  const rect = getRenderedVideoRect();
  const safeWidth = rect.width || 1;
  const safeHeight = rect.height || 1;

  const localX = clamp(e.clientX - rect.left, 0, safeWidth);
  const localY = clamp(e.clientY - rect.top, 0, safeHeight);

  const x = clamp(Math.round((localX / safeWidth) * inputViewport.width), 0, Math.max(0, inputViewport.width - 1));
  const y = clamp(Math.round((localY / safeHeight) * inputViewport.height), 0, Math.max(0, inputViewport.height - 1));

  if (isNaN(x) || isNaN(y) || x < -100 || y < -100 ||
      x > inputViewport.width + 100 || y > inputViewport.height + 100) {
    warn('[LOBSTERLINK:viewer] Bad coords:', x, y,
      '| rendered rect:', safeWidth, 'x', safeHeight,
      '| inputViewport:', inputViewport.width, 'x', inputViewport.height);
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
  // CDP expects pixel deltas; convert line/page modes
  let dx = e.deltaX, dy = e.deltaY;
  if (e.deltaMode === 1) { dx *= 40; dy *= 40; }       // lines → pixels
  else if (e.deltaMode === 2) { dx *= 800; dy *= 600; } // pages → pixels
  sendInput({
    type: 'mouse', action: 'wheel', x, y,
    deltaX: dx,
    deltaY: dy
  });
}, { passive: false });

video.addEventListener('contextmenu', (e) => e.preventDefault());

// --- Keyboard events ---
// Capture on the document so keys work regardless of which element has focus,
// except when typing in the URL bar or other nav inputs.

video.setAttribute('tabindex', '0');

function isNavInput(el) {
  return el && (el.id === 'url-bar' || el.id === 'overlay-peer-input' ||
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

document.addEventListener('keyup', (e) => {
  if (!dataConn || !dataConn.open) return;
  if (isNavInput(document.activeElement)) return;
  if (isClipboardShortcutKey(e)) return;

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

document.addEventListener('paste', (e) => {
  if (!dataConn || !dataConn.open) return;
  if (isNavInput(document.activeElement)) return;

  e.preventDefault();
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

  e.preventDefault();
  e.stopPropagation();
  sendInput({
    type: 'clipboard',
    action: 'copySelection'
  });
}, true);

document.addEventListener('cut', (e) => {
  if (!dataConn || !dataConn.open) return;
  if (isNavInput(document.activeElement)) return;

  e.preventDefault();
  e.stopPropagation();
  sendInput({
    type: 'clipboard',
    action: 'cutSelection'
  });
}, true);

video.addEventListener('click', () => video.focus());
video.addEventListener('loadedmetadata', () => {
  layoutVideo();
  log('[LOBSTERLINK:viewer] Video metadata — intrinsic:',
    video.videoWidth, 'x', video.videoHeight,
    '| remote viewport:', remoteViewport.width, 'x', remoteViewport.height);
  updateDebugPanel();
});
video.addEventListener('playing', () => {
  layoutVideo();
  video.focus();
  log('[LOBSTERLINK:viewer] Video playing — intrinsic:',
    video.videoWidth, 'x', video.videoHeight,
    '| remote viewport:', remoteViewport.width, 'x', remoteViewport.height);
  updateDebugPanel();
});
window.addEventListener('resize', () => {
  layoutVideo();
  updateDebugPanel();
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
      warn.textContent = 'Tip: Move this viewer tab to a separate window for best results (right-click tab \u2192 Move to new window). Same-window hosting may freeze the video.';
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
