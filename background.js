// LobsterLink service worker — orchestrates host mode.
// Hosting uses CDP Page.startScreencast exclusively.

const SCREENCAST_MAX_WIDTH = 3840;
const SCREENCAST_MAX_HEIGHT = 2160;
const SCREENCAST_JPEG_QUALITY = 92;
const DIAGNOSTIC_LOG_URL = 'http://127.0.0.1:8787/log';
const HOST_STATE_STORAGE_KEY = 'lobsterlinkHostState';

const DEFAULT_HOST_STATE = {
  hosting: false,
  peerId: null,
  capturedTabId: null,
  debuggerAttached: false,
  viewerConnected: false,
  captureMode: null, // 'screencast' when hosting
  screencastWidth: null,
  screencastHeight: null,
  pageAgentReady: false,
  pageViewportWidth: null,
  pageViewportHeight: null,
  pageDevicePixelRatio: null,
  pageVisualViewportWidth: null,
  pageVisualViewportHeight: null,
  pageVisualViewportOffsetLeft: null,
  pageVisualViewportOffsetTop: null,
  pageVisualViewportScale: null
};

let hostState = { ...DEFAULT_HOST_STATE };

const DEBUGGER_REATTACH_BASE_MS = 350;
const DEBUGGER_REATTACH_MAX_MS = 5000;
const DEBUGGER_SUSPEND_MS = 900;
const MAX_DIAGNOSTIC_EVENTS = 150;

let reattachInProgress = false;
let debuggerRecoverTimer = null;
let debuggerSuspendedUntil = 0;
let debuggerSuspendReason = null;
let hostStateLoaded = false;
let hostStateLoadPromise = null;
let tabListenersInstalled = false;
let recentDiagnostics = [];
let lastDiagnosticError = null;
let remoteLoggingEnabled = false;

// Load opt-in remote logging flag from storage (default: off)
chrome.storage.local.get({ lobsterlinkDebugLoggingEnabled: false }, (result) => {
  remoteLoggingEnabled = !!result.lobsterlinkDebugLoggingEnabled;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lobsterlinkDebugLoggingEnabled) {
    remoteLoggingEnabled = !!changes.lobsterlinkDebugLoggingEnabled.newValue;
  }
});

// Debug-gated console helpers — silent unless lobsterlinkDebugLoggingEnabled is true
const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);
function log(...args) { if (remoteLoggingEnabled) _log(...args); }
function warn(...args) { if (remoteLoggingEnabled) _warn(...args); }
function error(...args) { if (remoteLoggingEnabled) _error(...args); }

function serializeHostState() {
  return {
    hosting: hostState.hosting,
    peerId: hostState.peerId,
    capturedTabId: hostState.capturedTabId,
    debuggerAttached: hostState.debuggerAttached,
    viewerConnected: hostState.viewerConnected,
    captureMode: hostState.captureMode,
    screencastWidth: hostState.screencastWidth,
    screencastHeight: hostState.screencastHeight,
    pageAgentReady: hostState.pageAgentReady,
    pageViewportWidth: hostState.pageViewportWidth,
    pageViewportHeight: hostState.pageViewportHeight,
    pageDevicePixelRatio: hostState.pageDevicePixelRatio,
    pageVisualViewportWidth: hostState.pageVisualViewportWidth,
    pageVisualViewportHeight: hostState.pageVisualViewportHeight,
    pageVisualViewportOffsetLeft: hostState.pageVisualViewportOffsetLeft,
    pageVisualViewportOffsetTop: hostState.pageVisualViewportOffsetTop,
    pageVisualViewportScale: hostState.pageVisualViewportScale
  };
}

async function persistHostState() {
  try {
    await chrome.storage.session.set({
      [HOST_STATE_STORAGE_KEY]: serializeHostState()
    });
  } catch (e) {
    warn('[LOBSTERLINK:bg] persistHostState failed:', e.message || e);
  }
}

async function ensureHostStateLoaded() {
  if (hostStateLoaded) return;
  if (hostStateLoadPromise) {
    await hostStateLoadPromise;
    return;
  }

  hostStateLoadPromise = chrome.storage.session.get(HOST_STATE_STORAGE_KEY).then((stored) => {
    const saved = stored?.[HOST_STATE_STORAGE_KEY];
    if (saved && typeof saved === 'object') {
      hostState = {
        ...hostState,
        ...saved
      };
    }
    if (hostState.hosting) {
      setupTabListeners();
    }
    hostStateLoaded = true;
  }).catch((e) => {
    warn('[LOBSTERLINK:bg] ensureHostStateLoaded failed:', e.message || e);
    hostStateLoaded = true;
  }).finally(() => {
    hostStateLoadPromise = null;
  });

  await hostStateLoadPromise;
}

function logDiagnostic(event, details = {}) {
  const payload = {
    ts: new Date().toISOString(),
    source: 'background',
    event,
    details,
    state: {
      hosting: hostState.hosting,
      viewerConnected: hostState.viewerConnected,
      captureMode: hostState.captureMode,
      capturedTabId: hostState.capturedTabId,
      debuggerAttached: hostState.debuggerAttached,
      peerId: hostState.peerId
    }
  };

  recentDiagnostics = [payload, ...recentDiagnostics].slice(0, MAX_DIAGNOSTIC_EVENTS);
  if (details?.error || /error|failure|exhausted|blocked/i.test(event)) {
    lastDiagnosticError = {
      ts: payload.ts,
      event,
      error: details?.error || null,
      details
    };
  }

  if (remoteLoggingEnabled) {
    fetch(DIAGNOSTIC_LOG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {});
  }
}

function getViewerUrl(peerId) {
  if (!peerId) return null;
  return `https://lobsterl.ink/?host=${encodeURIComponent(peerId)}`;
}

function getStatusPayload() {
  return {
    hosting: hostState.hosting,
    peerId: hostState.peerId,
    viewerConnected: hostState.viewerConnected,
    captureMode: hostState.captureMode,
    capturedTabId: hostState.capturedTabId,
    debuggerAttached: hostState.debuggerAttached,
    pageAgentReady: hostState.pageAgentReady,
    viewerUrl: getViewerUrl(hostState.peerId)
  };
}

function getDiagnosticsPayload() {
  return {
    logs: recentDiagnostics,
    lastError: lastDiagnosticError
  };
}

function clearDebuggerRecoveryTimer() {
  if (debuggerRecoverTimer) {
    clearTimeout(debuggerRecoverTimer);
    debuggerRecoverTimer = null;
  }
}

function isDebuggerSuspended() {
  return Date.now() < debuggerSuspendedUntil;
}

function suspendDebuggerRecovery(reason, durationMs = DEBUGGER_SUSPEND_MS) {
  debuggerSuspendedUntil = Date.now() + durationMs;
  debuggerSuspendReason = reason;
  logDiagnostic('debugger_recovery_suspended', {
    reason,
    durationMs,
    suspendedUntil: new Date(debuggerSuspendedUntil).toISOString()
  });
}

function scheduleDebuggerRecovery(delayMs, reason = 'scheduled_recovery') {
  if (!hostState.hosting || !hostState.viewerConnected || hostState.debuggerAttached) return;

  clearDebuggerRecoveryTimer();
  const effectiveDelay = Math.max(delayMs, isDebuggerSuspended() ? debuggerSuspendedUntil - Date.now() : 0);
  logDiagnostic('debugger_recovery_scheduled', {
    reason,
    delayMs: effectiveDelay,
    suspended: isDebuggerSuspended(),
    suspendReason: debuggerSuspendReason
  });

  debuggerRecoverTimer = setTimeout(() => {
    debuggerRecoverTimer = null;
    retryAttachDebugger(6, DEBUGGER_REATTACH_BASE_MS);
  }, effectiveDelay);
}

function isForeignExtensionAttachError(errorMessage) {
  return /Cannot access a chrome-extension:\/\/ URL of different extension/i.test(errorMessage || '');
}

function resetPageAgentState() {
  hostState.pageAgentReady = false;
  hostState.pageViewportWidth = null;
  hostState.pageViewportHeight = null;
  hostState.pageDevicePixelRatio = null;
  hostState.pageVisualViewportWidth = null;
  hostState.pageVisualViewportHeight = null;
  hostState.pageVisualViewportOffsetLeft = null;
  hostState.pageVisualViewportOffsetTop = null;
  hostState.pageVisualViewportScale = null;
}

async function ensurePageAgent(tabId) {
  if (!tabId) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['host-agent.js']
    });
    logDiagnostic('page_agent_injected', { tabId });
    return true;
  } catch (e) {
    logDiagnostic('page_agent_inject_failure', {
      tabId,
      error: e.message || String(e)
    });
    return false;
  }
}

async function getPageDevicePixelRatio(tabId) {
  if (!tabId) return 1;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.devicePixelRatio || 1
    });
    return Number(result?.result) || 1;
  } catch (e) {
    warn('[LOBSTERLINK:bg] getPageDevicePixelRatio failed:', e.message || e);
    return 1;
  }
}

async function sendHostOverlay(tabId, peerId) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'pageAgentHostOverlay',
      peerId: peerId || null
    });
  } catch (e) {
    // Agent may not be injected yet — will be (re)sent on pageAgentReady.
  }
}

async function sendPageAgentInput(tabId, evt, attempt = 0) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      action: 'pageAgentInput',
      event: evt
    });
  } catch (e) {
    const errorMessage = e.message || String(e);
    if (attempt === 0 && /Receiving end does not exist|Could not establish connection/i.test(errorMessage)) {
      const injected = await ensurePageAgent(tabId);
      if (injected) {
        return sendPageAgentInput(tabId, evt, 1);
      }
    }
    logDiagnostic('page_agent_input_failure', {
      tabId,
      type: evt.type,
      action: evt.action,
      error: errorMessage
    });
    return null;
  }
}

// --- Message handling ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startHostingCDP') {
    ensureHostStateLoaded().then(() => handleStartHostingCDP(msg.tabId)).then(sendResponse);
    return true;
  }
  if (msg.action === 'stopHosting') {
    ensureHostStateLoaded().then(() => handleStopHosting()).then(sendResponse);
    return true;
  }
  if (msg.action === 'getStatus') {
    ensureHostStateLoaded().then(() => {
      sendResponse(getStatusPayload());
    });
    return true;
  }
  if (msg.action === 'getDiagnostics') {
    sendResponse(getDiagnosticsPayload());
    return false;
  }
  if (msg.action === 'clearDiagnostics') {
    recentDiagnostics = [];
    lastDiagnosticError = null;
    sendResponse({ ok: true });
    return false;
  }
  // Messages from offscreen document
  if (msg.action === 'peerReady') {
    ensureHostStateLoaded().then(async () => {
      hostState.peerId = msg.peerId;
      await persistHostState();
    });
    return false;
  }
  if (msg.action === 'pageAgentReady') {
    ensureHostStateLoaded().then(async () => {
      if (sender.tab?.id === hostState.capturedTabId) {
        hostState.pageAgentReady = true;
        hostState.pageViewportWidth = msg.width || null;
        hostState.pageViewportHeight = msg.height || null;
        hostState.pageDevicePixelRatio = msg.devicePixelRatio || null;
        hostState.pageVisualViewportWidth = msg.visualViewportWidth || null;
        hostState.pageVisualViewportHeight = msg.visualViewportHeight || null;
        hostState.pageVisualViewportOffsetLeft = msg.visualViewportOffsetLeft || null;
        hostState.pageVisualViewportOffsetTop = msg.visualViewportOffsetTop || null;
        hostState.pageVisualViewportScale = msg.visualViewportScale || null;
        await persistHostState();
        logDiagnostic('page_agent_ready', {
          tabId: sender.tab.id,
          width: msg.width || null,
          height: msg.height || null
        });
        if (hostState.hosting && hostState.peerId) {
          sendHostOverlay(sender.tab.id, hostState.peerId).catch(() => {});
        }
        if (hostState.viewerConnected) {
          sendHostMetricsToViewer(true).catch(() => {});
        }
      }
    });
    return false;
  }
  if (msg.action === 'pageAgentViewport') {
    ensureHostStateLoaded().then(async () => {
      if (sender.tab?.id === hostState.capturedTabId) {
        hostState.pageViewportWidth = msg.width || null;
        hostState.pageViewportHeight = msg.height || null;
        hostState.pageDevicePixelRatio = msg.devicePixelRatio || null;
        hostState.pageVisualViewportWidth = msg.visualViewportWidth || null;
        hostState.pageVisualViewportHeight = msg.visualViewportHeight || null;
        hostState.pageVisualViewportOffsetLeft = msg.visualViewportOffsetLeft || null;
        hostState.pageVisualViewportOffsetTop = msg.visualViewportOffsetTop || null;
        hostState.pageVisualViewportScale = msg.visualViewportScale || null;
        await persistHostState();
        if (hostState.viewerConnected) {
          sendHostMetricsToViewer(true).catch(() => {});
        }
      }
    });
    return false;
  }
  if (msg.action === 'viewerConnected') {
    ensureHostStateLoaded().then(async () => {
      hostState.viewerConnected = true;
      await persistHostState();
      log('[LOBSTERLINK:bg] Viewer connected');
      logDiagnostic('viewer_connected', { mode: hostState.captureMode });
      if (hostState.debuggerAttached) {
        // Restart screencast to force CDP to emit fresh frames.
        // CDP only sends frames on visual changes, so on a static page
        // frames may have arrived before the viewer connected.
        log('[LOBSTERLINK:bg] Restarting screencast for new viewer');
        const tabId = hostState.capturedTabId;
        try {
          const { width: w, height: h } = await getCurrentViewport(tabId);
          const devicePixelRatio = hostState.pageDevicePixelRatio || await getPageDevicePixelRatio(tabId);
          const capture = getCaptureSize(w, h, devicePixelRatio);
          hostState.screencastWidth = w;
          hostState.screencastHeight = h;
          hostState.pageDevicePixelRatio = devicePixelRatio;
          await chrome.runtime.sendMessage({
            action: 'offscreen:screencastResize',
            width: capture.width,
            height: capture.height,
            viewportWidth: w,
            viewportHeight: h
          }).catch(() => {});
          await restartScreencast(tabId, capture.width, capture.height);
          log('[LOBSTERLINK:bg] Screencast restarted at', w, 'x', h);
        } catch (e) {
          error('[LOBSTERLINK:bg] Failed to restart screencast:', e.message || e);
        }
      }
      log('[LOBSTERLINK:bg] Debugger attached:', hostState.debuggerAttached);
      sendTabListToViewer();
      await sendHostMetricsToViewer(true);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.action === 'viewerDisconnected') {
    ensureHostStateLoaded().then(async () => {
      hostState.viewerConnected = false;
      await persistHostState();
      log('[LOBSTERLINK:bg] Viewer disconnected');
      logDiagnostic('viewer_disconnected');
    });
    return false;
  }
  if (msg.action === 'inputEvent') {
    ensureHostStateLoaded().then(() => handleInputEvent(msg.event));
    return false;
  }
  if (msg.action === 'controlEvent') {
    log('[LOBSTERLINK:bg] Received controlEvent:', msg.event.type);
    ensureHostStateLoaded().then(() => handleControlEvent(msg.event));
    return false;
  }
  return false;
});

// --- Tab URL validation ---

function isForbiddenTab(tab) {
  if (!tab || !tab.url) return true;
  const url = tab.url;
  return url.startsWith('chrome-extension://') ||
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:');
}

async function findCapturableTab() {
  // 1. Prefer active tab in current window
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && !isForbiddenTab(activeTab)) {
    log('[LOBSTERLINK:bg] findCapturableTab: currentWindow active tab', activeTab.id);
    return activeTab;
  }

  // 2. Try lastFocusedWindow — active tab first, then any capturable tab
  const [lfActive] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (lfActive && !isForbiddenTab(lfActive)) {
    log('[LOBSTERLINK:bg] findCapturableTab: lastFocusedWindow active tab', lfActive.id);
    return lfActive;
  }
  const lfTabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const lfCandidate = lfTabs.find(t => !isForbiddenTab(t));
  if (lfCandidate) {
    log('[LOBSTERLINK:bg] findCapturableTab: lastFocusedWindow fallback tab', lfCandidate.id);
    return lfCandidate;
  }

  // 3. Global fallback — any capturable tab across all windows
  const allTabs = await chrome.tabs.query({});
  const globalCandidate = allTabs.find(t => !isForbiddenTab(t));
  if (globalCandidate) {
    log('[LOBSTERLINK:bg] findCapturableTab: global fallback tab', globalCandidate.id);
    return globalCandidate;
  }

  return null;
}

// --- Window sizing helper ---

async function ensureWindowVisible(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);

    if (win.state === 'minimized') {
      log('[LOBSTERLINK:bg] Restoring minimized window', win.id);
      await chrome.windows.update(win.id, { state: 'normal' });
    }
  } catch (e) {
    warn('[LOBSTERLINK:bg] ensureWindowVisible failed:', e.message || e);
  }
}

async function ensureWindowLargeEnough(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    const minWidth = 1280;
    const minHeight = 900;

    if (win.state === 'minimized') {
      log('[LOBSTERLINK:bg] Restoring minimized window', win.id);
      await chrome.windows.update(win.id, { state: 'normal' });
    }

    const currentWidth = win.width || 0;
    const currentHeight = win.height || 0;
    if (currentWidth < minWidth || currentHeight < minHeight) {
      log('[LOBSTERLINK:bg] Window too small (' + currentWidth + 'x' + currentHeight +
        '), resizing to at least ' + minWidth + 'x' + minHeight);

      if (win.state !== 'normal') {
        await chrome.windows.update(win.id, { state: 'normal' });
      }

      await chrome.windows.update(win.id, {
        width: Math.max(currentWidth, minWidth),
        height: Math.max(currentHeight, minHeight),
        focused: true
      });
    }
  } catch (e) {
    warn('[LOBSTERLINK:bg] ensureWindowLargeEnough failed:', e.message || e);
  }
}

async function activateTabWindow(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) {
    warn('[LOBSTERLINK:bg] activateTabWindow failed:', e.message || e);
  }
}

async function resetTabZoom(tabId) {
  try {
    const zoomFactor = await chrome.tabs.getZoom(tabId);
    if (zoomFactor !== 1) {
      log('[LOBSTERLINK:bg] Resetting tab zoom from', zoomFactor, 'to 1 on tab', tabId);
    }
    await chrome.tabs.setZoom(tabId, 1);
  } catch (e) {
    warn('[LOBSTERLINK:bg] resetTabZoom failed:', e.message || e);
  }
}

// --- Host lifecycle: CDP screencast mode ---

async function handleStartHostingCDP(tabId) {
  try {
    if (!tabId) {
      const tab = await findCapturableTab();
      if (!tab) {
        logDiagnostic('start_cdp_blocked', {
          error: 'No capturable tab found (switch to a normal web tab and retry)'
        });
        return { error: 'No capturable tab found (switch to a normal web tab and retry)' };
      }
      tabId = tab.id;
    } else {
      // Validate the explicitly provided tabId
      const tab = await chrome.tabs.get(tabId);
      if (isForbiddenTab(tab)) {
        logDiagnostic('start_cdp_forbidden_tab', {
          error: 'Cannot capture extension/chrome pages (switch to a normal web tab)',
          tabId
        });
        return { error: 'Cannot capture extension/chrome pages (switch to a normal web tab)' };
      }
    }
    log('[LOBSTERLINK:bg] Starting host (CDP screencast) on tab', tabId);
    return await startScreencastMode(tabId);
  } catch (err) {
    error('[LOBSTERLINK:bg] startHostingCDP error:', err);
    logDiagnostic('start_cdp_error', { error: err.message || String(err), tabId: tabId || null });
    return { error: err.message };
  }
}

async function startScreencastMode(tabId) {
  hostState.capturedTabId = tabId;
  resetPageAgentState();

  await resetTabZoom(tabId);
  await ensureWindowLargeEnough(tabId);

  // Attach debugger (needed for screencast AND input)
  await attachDebugger(tabId);
  if (!hostState.debuggerAttached) {
    return { error: 'Failed to attach debugger for screencast' };
  }

  // Use the tab's actual CSS viewport. Auto-overriding the viewport on start
  // can make Chrome scale the host tab down, which then makes the viewer look tiny.
  const { width, height } = await getCurrentViewport(tabId);
  const devicePixelRatio = await getPageDevicePixelRatio(tabId);
  const capture = getCaptureSize(width, height, devicePixelRatio);

  hostState.screencastWidth = width;
  hostState.screencastHeight = height;
  hostState.pageDevicePixelRatio = devicePixelRatio;

  log('[LOBSTERLINK:bg] Screencast viewport:', width, 'x', height,
    '| dpr:', devicePixelRatio,
    '| capture:', capture.width, 'x', capture.height);

  // Set up offscreen document in screencast/canvas mode
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    action: 'offscreen:startHostScreencast',
    width: capture.width,
    height: capture.height,
    viewportWidth: width,
    viewportHeight: height
  });

  // Enable Page domain events (required for screencastFrame events to fire)
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  log('[LOBSTERLINK:bg] Page domain enabled');

  // Start CDP screencast at the same dimensions
  await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', {
    format: 'jpeg',
    quality: SCREENCAST_JPEG_QUALITY,
    maxWidth: capture.width,
    maxHeight: capture.height
  });

  log('[LOBSTERLINK:bg] CDP screencast started at', capture.width, 'x', capture.height);

  const peerId = await waitForPeerId();
  hostState.hosting = true;
  hostState.peerId = peerId;
  hostState.captureMode = 'screencast';
  setupTabListeners();
  await persistHostState();
  await ensurePageAgent(tabId);
  await sendHostOverlay(tabId, peerId);
  await activateTabWindow(tabId);

  log('[LOBSTERLINK:bg] Host started (screencast), peerId:', peerId);
  return { peerId, captureMode: 'screencast' };
}

async function stopScreencast() {
  if (hostState.capturedTabId && hostState.debuggerAttached) {
    try {
      await chrome.debugger.sendCommand(
        { tabId: hostState.capturedTabId }, 'Page.stopScreencast'
      );
    } catch (e) { /* may already be stopped */ }
  }
}

// --- Stop hosting ---

async function handleStopHosting() {
  teardownTabListeners();

  if (hostState.capturedTabId) {
    await sendHostOverlay(hostState.capturedTabId, null);
  }

  await stopScreencast();
  // Restore original viewport
  if (hostState.capturedTabId && hostState.debuggerAttached) {
    try {
      await chrome.debugger.sendCommand(
        { tabId: hostState.capturedTabId }, 'Emulation.clearDeviceMetricsOverride'
      );
    } catch (e) { /* tab may be gone */ }
  }

  try {
    await chrome.runtime.sendMessage({ action: 'offscreen:stopHost' });
  } catch (e) { /* offscreen may already be gone */ }

  await detachDebugger(hostState.capturedTabId);

  try {
    await chrome.offscreen.closeDocument();
  } catch (e) { /* may not exist */ }

  hostState = { ...DEFAULT_HOST_STATE };
  clearDebuggerRecoveryTimer();
  debuggerSuspendedUntil = 0;
  debuggerSuspendReason = null;
  await persistHostState();

  return { ok: true };
}

function waitForPeerId() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Peer setup timeout')), 15000);

    function listener(msg) {
      if (msg.action === 'peerReady') {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(msg.peerId);
      }
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

// --- Offscreen document ---

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'PeerJS connection and MediaStream for tab sharing'
  });
}

function sendToViewer(message) {
  if (!hostState.viewerConnected) return;
  chrome.runtime.sendMessage({
    action: 'offscreen:sendToViewer',
    message
  }).catch(() => {});
}

async function collectHostMetrics() {
  const tabId = hostState.capturedTabId;
  if (!tabId) return null;

  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    let zoomFactor = null;

    try {
      zoomFactor = await chrome.tabs.getZoom(tabId);
    } catch (e) {
      zoomFactor = null;
    }

    return {
      type: 'hostMetrics',
      captureMode: hostState.captureMode,
      zoomFactor,
      windowWidth: win.width || null,
      windowHeight: win.height || null,
      tabWidth: tab.width || null,
      tabHeight: tab.height || null,
      viewportWidth: hostState.pageViewportWidth || hostState.screencastWidth || tab.width || null,
      viewportHeight: hostState.pageViewportHeight || hostState.screencastHeight || tab.height || null,
      devicePixelRatio: hostState.pageDevicePixelRatio || null,
      visualViewportWidth: hostState.pageVisualViewportWidth || null,
      visualViewportHeight: hostState.pageVisualViewportHeight || null,
      visualViewportOffsetLeft: hostState.pageVisualViewportOffsetLeft || null,
      visualViewportOffsetTop: hostState.pageVisualViewportOffsetTop || null,
      visualViewportScale: hostState.pageVisualViewportScale || null
    };
  } catch (e) {
    warn('[LOBSTERLINK:bg] collectHostMetrics failed:', e.message || e);
    return null;
  }
}

async function sendHostMetricsToViewer() {
  const metrics = await collectHostMetrics();
  if (metrics) {
    sendToViewer(metrics);
  }
}

function getCaptureSize(width, height, devicePixelRatio = 1) {
  if (!width || !height) {
    return {
      width: SCREENCAST_MAX_WIDTH,
      height: SCREENCAST_MAX_HEIGHT
    };
  }

  const scaleFactor = Math.max(1, Number(devicePixelRatio) || 1);
  const targetWidth = Math.max(1, Math.round(width * scaleFactor));
  const targetHeight = Math.max(1, Math.round(height * scaleFactor));

  const scale = Math.min(
    1,
    SCREENCAST_MAX_WIDTH / targetWidth,
    SCREENCAST_MAX_HEIGHT / targetHeight
  );

  return {
    width: Math.max(1, Math.round(targetWidth * scale)),
    height: Math.max(1, Math.round(targetHeight * scale))
  };
}

async function getCurrentViewport(tabId) {
  const layoutMetrics = await chrome.debugger.sendCommand(
    { tabId }, 'Page.getLayoutMetrics'
  );
  return {
    width: Math.round(layoutMetrics.cssLayoutViewport.clientWidth),
    height: Math.round(layoutMetrics.cssLayoutViewport.clientHeight)
  };
}

async function restartScreencast(tabId, width, height) {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast');
  } catch (e) {
    // Safe to ignore if no screencast was active.
  }

  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', {
    format: 'jpeg',
    quality: SCREENCAST_JPEG_QUALITY,
    maxWidth: width,
    maxHeight: height
  });
  screencastFrameCount = 0;
}

// --- CDP screencast frame handling ---

let screencastFrameCount = 0;

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== hostState.capturedTabId) return;
  if (method !== 'Page.screencastFrame') return;

  screencastFrameCount++;
  if (screencastFrameCount <= 3 || screencastFrameCount % 30 === 0) {
    log('[LOBSTERLINK:bg] screencastFrame #' + screencastFrameCount,
      '| data length:', params.data ? params.data.length : 0,
      '| metadata:', JSON.stringify(params.metadata));
  }

  // Forward frame to offscreen document for canvas rendering
  chrome.runtime.sendMessage({
    action: 'offscreen:screencastFrame',
    data: params.data,
    sessionId: params.sessionId,
    metadata: params.metadata
  }).catch((err) => {
    if (screencastFrameCount <= 5) {
      error('[LOBSTERLINK:bg] Failed to forward frame to offscreen:', err.message || err);
    }
  });

  // Ack the frame so CDP sends the next one
  const ackSessionId = params.sessionId;
  if (screencastFrameCount <= 3) {
    log('[LOBSTERLINK:bg] Acking frame #' + screencastFrameCount,
      '| sessionId:', ackSessionId, '| tabId:', source.tabId);
  }
  chrome.debugger.sendCommand(source, 'Page.screencastFrameAck', {
    sessionId: ackSessionId
  }).then(() => {
    if (screencastFrameCount <= 3) {
      log('[LOBSTERLINK:bg] Ack succeeded for frame #' + screencastFrameCount);
    }
  }).catch((err) => {
    error('[LOBSTERLINK:bg] Ack FAILED for frame #' + screencastFrameCount,
      ':', err.message || err, '| sessionId:', ackSessionId);
  });
});

// --- Tab management (Phase 3) ---

function onTabActivated(activeInfo) {
  if (!hostState.hosting || !hostState.viewerConnected) return;
  logDiagnostic('tab_activated', {
    activeTabId: activeInfo.tabId,
    previousTabId: activeInfo.previousTabId,
    capturedTabId: hostState.capturedTabId,
    matchesCaptured: activeInfo.tabId === hostState.capturedTabId
  });
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    sendToViewer({
      type: 'tabChanged',
      tabId: tab.id,
      url: tab.url || '',
      title: tab.title || ''
    });
  });
}

function onTabUpdated(tabId, changeInfo, tab) {
  if (!hostState.hosting || !hostState.viewerConnected) return;
  if (tabId === hostState.capturedTabId) {
    if (changeInfo.status === 'loading') {
      resetPageAgentState();
      persistHostState().catch(() => {});
    }
    if (changeInfo.status === 'complete') {
      ensurePageAgent(tabId).catch(() => {});
    }
    sendHostMetricsToViewer(true).catch(() => {});
  }
  if (changeInfo.title || changeInfo.url || changeInfo.status === 'complete') {
    if (tabId === hostState.capturedTabId) {
      sendToViewer({
        type: 'tabChanged',
        tabId: tab.id,
        url: tab.url || '',
        title: tab.title || ''
      });
      if (changeInfo.status === 'complete') {
        onTabNavigated(tabId);
      }
    }
    sendTabListToViewer();
  }
}

function onTabRemoved(tabId) {
  if (!hostState.hosting || !hostState.viewerConnected) return;
  logDiagnostic('tab_removed', {
    tabId,
    wasCaptured: tabId === hostState.capturedTabId
  });
  if (tabId === hostState.capturedTabId) {
    stopScreencast();
    hostState.capturedTabId = null;
    hostState.debuggerAttached = false;
    resetPageAgentState();
    persistHostState().catch(() => {});
    sendToViewer({ type: 'status', capturing: false, tabId: null });
  }
  sendTabListToViewer();
}

function onTabCreated(tab) {
  if (!hostState.hosting || !hostState.viewerConnected) return;
  logDiagnostic('tab_created', {
    tabId: tab?.id || null,
    openerTabId: tab?.openerTabId || null,
    url: tab?.url || '',
    pendingUrl: tab?.pendingUrl || '',
    title: tab?.title || ''
  });
  sendTabListToViewer();
  if (tab && tab.openerTabId === hostState.capturedTabId) {
    log('[LOBSTERLINK:bg] New tab opened from captured tab, auto-switching to', tab.id);
    setTimeout(() => switchTab(tab.id), 300);
  }
}

function setupTabListeners() {
  if (tabListenersInstalled) return;
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  chrome.tabs.onCreated.addListener(onTabCreated);
  tabListenersInstalled = true;
}

function teardownTabListeners() {
  if (!tabListenersInstalled) return;
  chrome.tabs.onActivated.removeListener(onTabActivated);
  chrome.tabs.onUpdated.removeListener(onTabUpdated);
  chrome.tabs.onRemoved.removeListener(onTabRemoved);
  chrome.tabs.onCreated.removeListener(onTabCreated);
  tabListenersInstalled = false;
}

async function sendTabListToViewer() {
  try {
    const tabs = (await chrome.tabs.query({ currentWindow: true }))
      .filter((tab) => !isForbiddenTab(tab));
    sendToViewer({
      type: 'tabList',
      tabs: tabs.map(t => ({
        id: t.id,
        title: t.title || '',
        url: t.url || '',
        favIconUrl: t.favIconUrl || '',
        active: t.id === hostState.capturedTabId
      }))
    });
  } catch (e) {
    error('[LOBSTERLINK:bg] Failed to send tab list:', e);
  }
}

// --- Control message handling (Phase 3) ---

async function handleControlEvent(evt) {
  try {
    if (evt.type === 'switchTab' || evt.type === 'navigate' || evt.type === 'newTab' || evt.type === 'closeTab') {
      logDiagnostic('control_event', {
        type: evt.type,
        tabId: evt.tabId || null,
        url: evt.url || ''
      });
    }
    switch (evt.type) {
      case 'navigate':
        if (hostState.capturedTabId && evt.url) {
          let url = evt.url;
          if (!/^https?:\/\//i.test(url) && !url.startsWith('chrome://')) {
            url = 'https://' + url;
          }
          await chrome.tabs.update(hostState.capturedTabId, { url });
        }
        break;

      case 'goBack':
        if (hostState.capturedTabId) await chrome.tabs.goBack(hostState.capturedTabId);
        break;

      case 'goForward':
        if (hostState.capturedTabId) await chrome.tabs.goForward(hostState.capturedTabId);
        break;

      case 'reload':
        if (hostState.capturedTabId) await chrome.tabs.reload(hostState.capturedTabId);
        break;

      case 'listTabs':
        await sendTabListToViewer();
        break;

      case 'switchTab':
        await switchTab(evt.tabId);
        break;

      case 'focusTab':
        await activateTabWindow(evt.tabId || hostState.capturedTabId);
        break;

      case 'newTab':
        await createNewTab(evt.url);
        break;

      case 'closeTab':
        await closeTab(evt.tabId);
        break;

      case 'setViewport':
        await setHostViewport(evt.width, evt.height);
        break;
    }
  } catch (err) {
    error('[LOBSTERLINK:bg] Control event error:', err, evt);
    logDiagnostic('control_event_error', {
      error: err.message || String(err),
      eventType: evt?.type || null
    });
  }
}

async function setHostViewport(width, height) {
  if (!hostState.capturedTabId || !hostState.debuggerAttached) return;

  const tabId = hostState.capturedTabId;
  log('[LOBSTERLINK:bg] Setting host viewport to', width, 'x', height);

  // Resize the browser window so the tab's *inner* viewport matches the
  // requested CSS viewport. chrome.windows.update takes outer-window
  // dimensions (including title bar, toolbar, tab strip, frame chrome), so
  // we add the current outer-vs-inner delta before asking. Without this,
  // the viewer sees a letterbox because the host's actual viewport ends up
  // smaller than the size that was requested.
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    const deltaW = Math.max(0, (win.width || 0) - (tab.width || 0));
    const deltaH = Math.max(0, (win.height || 0) - (tab.height || 0));
    await chrome.windows.update(tab.windowId, {
      width: width + deltaW,
      height: height + deltaH
    });
  } catch (e) {
    warn('[LOBSTERLINK:bg] Failed to resize window:', e.message || e);
  }

  // Update CSS viewport
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false
  });

  // Update session dimensions
  hostState.screencastWidth = width;
  hostState.screencastHeight = height;

  const devicePixelRatio = hostState.pageDevicePixelRatio || await getPageDevicePixelRatio(tabId);
  hostState.pageDevicePixelRatio = devicePixelRatio;
  const capture = getCaptureSize(width, height, devicePixelRatio);

  // Resize canvas in offscreen doc
  await chrome.runtime.sendMessage({
    action: 'offscreen:screencastResize',
    width: capture.width,
    height: capture.height,
    viewportWidth: width,
    viewportHeight: height
  }).catch(() => {});

  // Restart screencast at new dimensions
  await restartScreencast(tabId, capture.width, capture.height);
  await persistHostState();
  await sendHostMetricsToViewer();

  log('[LOBSTERLINK:bg] Viewport, window, and screencast restarted at',
    width, 'x', height, '| capture:', capture.width, 'x', capture.height);
}

async function switchTab(tabId) {
  if (!tabId) return;
  const previousTabId = hostState.capturedTabId;
  logDiagnostic('switch_tab_requested', {
    nextTabId: tabId,
    previousTabId,
    mode: hostState.captureMode
  });

  if (previousTabId && previousTabId !== tabId) {
    sendHostOverlay(previousTabId, null).catch(() => {});
  }

  // Block switching to forbidden tabs
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isForbiddenTab(tab)) {
      warn('[LOBSTERLINK:bg] switchTab blocked: forbidden URL', tab.url);
      logDiagnostic('switch_tab_blocked_forbidden', {
        tabId,
        url: tab.url || ''
      });
      return;
    }
  } catch (e) {
    warn('[LOBSTERLINK:bg] switchTab: tab not found', tabId);
    logDiagnostic('switch_tab_missing', { tabId, error: e.message || String(e) });
    return;
  }

  // Stop screencast on old tab
  await stopScreencast();
  await detachDebugger(hostState.capturedTabId);
  resetPageAgentState();

  // Activate and capture new tab
  await activateTabWindow(tabId);
  await resetTabZoom(tabId);
  hostState.capturedTabId = tabId;

  await attachDebugger(tabId);

  // Get new page dimensions
  const { width, height } = await getCurrentViewport(tabId);
  const devicePixelRatio = await getPageDevicePixelRatio(tabId);
  const capture = getCaptureSize(width, height, devicePixelRatio);
  hostState.screencastWidth = width;
  hostState.screencastHeight = height;
  hostState.pageDevicePixelRatio = devicePixelRatio;

  // Resize canvas in offscreen doc
  await chrome.runtime.sendMessage({
    action: 'offscreen:screencastResize',
    width: capture.width,
    height: capture.height,
    viewportWidth: width,
    viewportHeight: height
  });

  // Restart screencast on new tab
  await restartScreencast(tabId, capture.width, capture.height);
  await ensurePageAgent(tabId);

  const tab = await chrome.tabs.get(tabId);
  await persistHostState();
  sendToViewer({
    type: 'tabChanged',
    tabId: tab.id,
    url: tab.url || '',
    title: tab.title || ''
  });
  sendToViewer({ type: 'status', capturing: true, tabId });
  await sendTabListToViewer();
  await sendHostMetricsToViewer(true);
  logDiagnostic('switch_tab_completed', { tabId });
}

async function createNewTab(url) {
  const createProps = {};
  if (url) {
    createProps.url = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  }
  const tab = await chrome.tabs.create(createProps);
  setTimeout(() => switchTab(tab.id), 300);
}

async function closeTab(tabId) {
  if (!tabId) return;
  const wasCaptured = tabId === hostState.capturedTabId;
  await chrome.tabs.remove(tabId);

  if (wasCaptured) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      await switchTab(activeTab.id);
    }
  }
}

// --- Debugger for input injection ---

async function attachDebugger(tabId) {
  if (!tabId || hostState.debuggerAttached) return hostState.debuggerAttached;
  try {
    const tab = await chrome.tabs.get(tabId);
    log('[LOBSTERLINK:bg] Attaching debugger to tab', tabId, '| url:', tab.url);
    logDiagnostic('debugger_attach_attempt', {
      tabId,
      url: tab.url || ''
    });

    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
      warn('[LOBSTERLINK:bg] WARNING: Cannot attach debugger to chrome:// or extension pages');
      logDiagnostic('debugger_attach_blocked', {
        tabId,
        url: tab.url || ''
      });
      return false;
    }

    await chrome.debugger.attach({ tabId }, '1.3');
    hostState.debuggerAttached = true;
    debuggerSuspendedUntil = 0;
    debuggerSuspendReason = null;
    clearDebuggerRecoveryTimer();
    await persistHostState();
    log('[LOBSTERLINK:bg] Debugger attached successfully to tab', tabId);
    logDiagnostic('debugger_attach_success', { tabId });

    await hideHostCursor(tabId);
    return true;
  } catch (e) {
    const errorMessage = e.message || String(e);
    error('[LOBSTERLINK:bg] Failed to attach debugger to tab', tabId, ':', e.message || e);
    logDiagnostic('debugger_attach_failure', {
      tabId,
      error: errorMessage
    });
    if (isForeignExtensionAttachError(errorMessage)) {
      suspendDebuggerRecovery('foreign_extension_surface');
      scheduleDebuggerRecovery(DEBUGGER_SUSPEND_MS, 'foreign_extension_surface');
    }
    return false;
  }
}

async function detachDebugger(tabId) {
  if (!tabId || !hostState.debuggerAttached) return;
  try {
    await chrome.debugger.detach({ tabId });
    log('[LOBSTERLINK:bg] Debugger detached from tab', tabId);
    logDiagnostic('debugger_detach', { tabId });
  } catch (e) { /* may already be detached */ }
  hostState.debuggerAttached = false;
  await persistHostState();
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== hostState.capturedTabId) return;
  warn('[LOBSTERLINK:bg] Debugger detached externally, reason:', reason);
  logDiagnostic('debugger_detached_externally', {
    tabId: source.tabId,
    reason
  });
  hostState.debuggerAttached = false;
  persistHostState().catch(() => {});

  if (hostState.hosting && hostState.viewerConnected) {
    if (reason === 'target_closed') {
      suspendDebuggerRecovery('target_closed');
      scheduleDebuggerRecovery(DEBUGGER_SUSPEND_MS, 'target_closed');
      return;
    }
    scheduleDebuggerRecovery(DEBUGGER_REATTACH_BASE_MS, `detach:${reason}`);
  }
});

// --- Debugger reattach with retries ---

async function retryAttachDebugger(maxRetries, delayMs) {
  if (reattachInProgress) return;
  reattachInProgress = true;

  for (let i = 0; i < maxRetries; i++) {
    if (hostState.debuggerAttached) break;
    if (!hostState.hosting || !hostState.viewerConnected) break;

    const suspendDelay = isDebuggerSuspended() ? debuggerSuspendedUntil - Date.now() : 0;
    const effectiveDelay = Math.max(delayMs, suspendDelay, 0);
    if (effectiveDelay > 0) {
      await new Promise(r => setTimeout(r, effectiveDelay));
    }
    log(`[LOBSTERLINK:bg] Reattach attempt ${i + 1}/${maxRetries}...`);
    logDiagnostic('debugger_reattach_attempt', {
      attempt: i + 1,
      maxRetries,
      delayMs: effectiveDelay,
      suspended: isDebuggerSuspended(),
      suspendReason: debuggerSuspendReason
    });

    try {
      const tab = await chrome.tabs.get(hostState.capturedTabId);
      if (tab) {
        const attached = await attachDebugger(tab.id);
        if (hostState.debuggerAttached) {
          const { width, height } = await getCurrentViewport(tab.id);
          const devicePixelRatio = hostState.pageDevicePixelRatio || await getPageDevicePixelRatio(tab.id);
          const capture = getCaptureSize(width, height, devicePixelRatio);
          hostState.screencastWidth = width;
          hostState.screencastHeight = height;
          hostState.pageDevicePixelRatio = devicePixelRatio;
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable');
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.startScreencast', {
            format: 'jpeg',
            quality: SCREENCAST_JPEG_QUALITY,
            maxWidth: capture.width,
            maxHeight: capture.height
          });
          log('[LOBSTERLINK:bg] Reattach succeeded on attempt', i + 1);
          logDiagnostic('debugger_reattach_success', { attempt: i + 1, tabId: tab.id });
          break;
        }
        if (!attached && isDebuggerSuspended()) {
          logDiagnostic('debugger_reattach_deferred', {
            attempt: i + 1,
            suspendReason: debuggerSuspendReason,
            suspendedUntil: new Date(debuggerSuspendedUntil).toISOString()
          });
          break;
        }
      }
    } catch (e) {
      log('[LOBSTERLINK:bg] Original tab gone, switching to active tab');
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) {
          await switchTab(activeTab.id);
          break;
        }
      } catch (e2) {
        error('[LOBSTERLINK:bg] Reattach attempt', i + 1, 'failed:', e2.message);
      }
    }

    delayMs = Math.min(delayMs * 1.5, DEBUGGER_REATTACH_MAX_MS);
  }

  reattachInProgress = false;
  if (!hostState.debuggerAttached) {
    error('[LOBSTERLINK:bg] Failed to reattach debugger after', maxRetries, 'attempts');
    logDiagnostic('debugger_reattach_exhausted', { maxRetries });
  }
}

// --- Hide host cursor (CDP-driven tabs don't show a visible cursor anyway) ---

function getHostGuardExpression() {
  return `(() => {
    const installKey = '__lobsterlinkHostGuardsInstalled';
    const vendorPattern = /(1password|lastpass|dashlane|bitwarden)/i;
    const cursorRootId = '__lobsterlink_remote_cursor_root';
    const overlayRootId = '__lobsterlink_overlay_root';
    const directSelectors = [
      'iframe[src^="chrome-extension://"]',
      'iframe[src^="moz-extension://"]',
      'iframe[src^="safari-web-extension://"]',
      'com-1password-button',
      'com-1password-inline-menu',
      'com-1password-notification',
      '[data-lastpass-root]',
      '[data-lastpass-icon-root]',
      '[data-dashlanecreated]',
      '[data-bitwarden-watching]'
    ];

    const getClassName = (el) => typeof el.className === 'string' ? el.className : '';

    const shouldSuppress = (el) => {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

      const tagName = String(el.tagName || '').toLowerCase();
      if (tagName.startsWith('com-1password')) return true;

      if (tagName === 'iframe') {
        const src = String(el.getAttribute('src') || '');
        if (/^(chrome-extension|moz-extension|safari-web-extension):/i.test(src)) {
          return true;
        }
      }

      const idText = String(el.id || '');
      if (vendorPattern.test(idText) || vendorPattern.test(getClassName(el))) {
        return true;
      }

      if (!el.getAttributeNames) return false;
      for (const attrName of el.getAttributeNames()) {
        const attrValue = String(el.getAttribute(attrName) || '');
        if (vendorPattern.test(attrName) || vendorPattern.test(attrValue)) {
          return true;
        }
      }

      return false;
    };

    const suppress = (el) => {
      if (!shouldSuppress(el)) return false;
      if (el.style) {
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
        el.style.setProperty('opacity', '0', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
      }
      el.setAttribute('data-lobsterlink-suppressed', '1');
      return true;
    };

    const ensureOverlayRoot = () => {
      if (!document.documentElement) return null;
      let root = document.getElementById(overlayRootId);
      if (!root) {
        root = document.createElement('div');
        root.id = overlayRootId;
        root.setAttribute('aria-hidden', 'true');
        root.style.position = 'fixed';
        root.style.top = '0';
        root.style.left = '0';
        root.style.width = '100vw';
        root.style.height = '100vh';
        root.style.pointerEvents = 'none';
        root.style.zIndex = '2147483647';
        root.style.margin = '0';
        root.style.padding = '0';
        root.style.border = '0';
        root.style.background = 'transparent';
      }
      if (document.documentElement.lastElementChild !== root) {
        document.documentElement.appendChild(root);
      }
      return root;
    };

    const ensureCursor = () => {
      const overlayRoot = ensureOverlayRoot();
      if (!overlayRoot) return null;

      let dot = document.getElementById(cursorRootId);
      if (!dot) {
        dot = document.createElement('div');
        dot.id = cursorRootId;
        dot.setAttribute('aria-hidden', 'true');
        dot.style.position = 'absolute';
        dot.style.left = '0';
        dot.style.top = '0';
        dot.style.width = '18px';
        dot.style.height = '18px';
        dot.style.pointerEvents = 'none';
        dot.style.opacity = '0';
        dot.style.transform = 'translate(-9999px, -9999px)';
        dot.style.transition = 'opacity 80ms linear';
        dot.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="4.5" fill="rgba(255,255,255,0.92)" stroke="#111111" stroke-width="1.5"/><circle cx="9" cy="9" r="1.6" fill="#ff4d4f"/><path d="M9 1.5v3M9 13.5v3M1.5 9h3M13.5 9h3" stroke="#111111" stroke-width="1.4" stroke-linecap="round"/></svg>';
      }
      if (dot.parentElement !== overlayRoot) overlayRoot.appendChild(dot);

      // Idempotent window helpers, installed every guard run. They look up
      // the dot each call so they survive reparenting/re-injection.
      window.__lobsterlinkUpdateRemoteCursor = (x, y, visible = true) => {
        ensureOverlayRoot();
        const d = document.getElementById(cursorRootId);
        if (!d) return;
        d.style.transform = 'translate(' + Math.round(x - 9) + 'px, ' + Math.round(y - 9) + 'px)';
        d.style.opacity = visible ? '1' : '0';
      };

      window.__lobsterlinkHideRemoteCursor = () => {
        const d = document.getElementById(cursorRootId);
        if (d) d.style.opacity = '0';
      };

      return dot;
    };

    const scan = (root) => {
      if (!root) return 0;
      const seen = new Set();
      let suppressed = 0;

      const maybeSuppress = (el) => {
        if (!el || seen.has(el)) return;
        seen.add(el);
        if (suppress(el)) suppressed++;
      };

      if (root.nodeType === Node.ELEMENT_NODE) {
        maybeSuppress(root);
      }

      if (!root.querySelectorAll) return suppressed;

      for (const selector of directSelectors) {
        for (const el of root.querySelectorAll(selector)) {
          maybeSuppress(el);
        }
      }

      for (const el of root.querySelectorAll('iframe, [id], [class]')) {
        maybeSuppress(el);
      }

      return suppressed;
    };

    ensureCursor();

    const initialSuppressed = scan(document);
    if (window[installKey]) {
      return 'refreshed:' + initialSuppressed;
    }

    window[installKey] = true;

    const observer = new MutationObserver((mutations) => {
      let htmlChildListTouched = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node && node.nodeType === Node.ELEMENT_NODE) {
            scan(node);
          }
        }
        if (mutation.type === 'childList' &&
            mutation.target === document.documentElement) {
          htmlChildListTouched = true;
        }
      }
      if (htmlChildListTouched) {
        const root = document.getElementById(overlayRootId);
        if (root && document.documentElement.lastElementChild !== root) {
          document.documentElement.appendChild(root);
        }
      }
    });

    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true
    });

    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    return 'installed:' + initialSuppressed;
  })()`;
}

async function hideHostCursor(tabId) {
  if (!hostState.debuggerAttached) return;
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: getHostGuardExpression(),
      returnByValue: true
    });
    logDiagnostic('host_guard_installed', {
      tabId,
      result: result?.result?.value || null
    });
  } catch (e) { /* non-critical */ }
}

async function updateHostRemoteCursor(tabId, x, y, visible = true) {
  if (!hostState.debuggerAttached) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(() => {
        if (typeof window.__lobsterlinkUpdateRemoteCursor === 'function') {
          window.__lobsterlinkUpdateRemoteCursor(${Math.round(x)}, ${Math.round(y)}, ${visible ? 'true' : 'false'});
        }
      })()`
    });
  } catch (e) { /* non-critical */ }
}

function onTabNavigated(tabId) {
  if (tabId === hostState.capturedTabId && hostState.debuggerAttached) {
    setTimeout(() => hideHostCursor(tabId), 500);
  }
}

// --- Input injection ---

async function routeInputToPageAgent(tabId, evt) {
  const response = await sendPageAgentInput(tabId, evt);
  if (!response) return null;

  if ((evt.action === 'copySelection' || evt.action === 'cutSelection') &&
      typeof response.text === 'string') {
    sendToViewer({
      type: 'clipboardResult',
      action: evt.action,
      text: response.text
    });
  }

  if (!response.handled) {
    logDiagnostic('page_agent_unhandled', {
      tabId,
      type: evt.type,
      action: evt.action
    });
  }

  return response;
}

async function handleInputEvent(evt) {
  const tabId = hostState.capturedTabId;
  if (!tabId) {
    warn('[LOBSTERLINK:bg] Input dropped: no capturedTabId');
    logDiagnostic('input_dropped_no_tab', { type: evt.type, action: evt.action });
    return;
  }

  // Routing policy (raw-input primary):
  //   debugger attached      → raw CDP Input.dispatch{Mouse,Key}Event for mouse/key.
  //                            This is browser-level input and is the only path that
  //                            reliably reaches cross-origin iframes (reCAPTCHA,
  //                            LinkedIn challenge frames, payment iframes, etc.).
  //                            Page-agent DOM synthesis (elementFromPoint + .click)
  //                            cannot cross those boundaries and silently no-ops.
  //   clipboard              → page-agent (DOM access for selection text / text
  //                            insertion into editables; no CDP equivalent here).
  if (hostState.debuggerAttached && evt.type === 'mouse') {
    dispatchMouseEvent(tabId, evt);
    return;
  }
  if (hostState.debuggerAttached && evt.type === 'key') {
    dispatchKeyEvent(tabId, evt);
    return;
  }

  if (evt.type === 'clipboard') {
    try {
      await routeInputToPageAgent(tabId, evt);
    } catch (err) {
      logDiagnostic('page_agent_route_failure', {
        tabId,
        type: evt.type,
        action: evt.action,
        error: err.message || String(err)
      });
    }
    return;
  }

  // Debugger is detached — drop event and kick off recovery rather than
  // silently falling back to synthetic DOM events.
  if (!reattachInProgress) {
    warn('[LOBSTERLINK:bg] Input dropped: debugger not attached, triggering reattach');
    logDiagnostic('input_dropped_debugger_missing', {
      type: evt.type,
      action: evt.action,
      tabId
    });
    scheduleDebuggerRecovery(DEBUGGER_REATTACH_BASE_MS, 'input_while_detached');
  }
}

function dispatchMouseEvent(tabId, evt) {
  const target = { tabId };

  if (evt.action === 'move' || evt.action === 'down' || evt.action === 'up') {
    updateHostRemoteCursor(tabId, evt.x, evt.y, true);
    // Decoupled hover-target visualization. The page agent only reads hit-test
    // state and draws an outline — it never handles the click itself.
    sendHoverHint(tabId, evt.x, evt.y);
  }

  if (evt.action === 'wheel') {
    chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: evt.x,
      y: evt.y,
      deltaX: evt.deltaX || 0,
      deltaY: evt.deltaY || 0
    }).catch(err => {
      error('[LOBSTERLINK:bg] dispatchMouseEvent(wheel) failed:', err.message || err);
    });
    return;
  }

  const typeMap = {
    move: 'mouseMoved',
    down: 'mousePressed',
    up: 'mouseReleased'
  };

  // `buttons` is the bitmask of currently-held buttons (1=left, 2=right, 4=middle).
  // Forwarding it during moves is what turns a hover into a drag as far as
  // Blink / page listeners are concerned.
  const heldButtons = Number.isInteger(evt.buttons) ? evt.buttons : 0;
  const primaryFromHeld = heldButtons & 1 ? 'left' :
                          heldButtons & 2 ? 'right' :
                          heldButtons & 4 ? 'middle' : 'none';

  let button;
  if (evt.action === 'move') {
    // During a drag the held button must ride along on moves.
    button = heldButtons ? primaryFromHeld : (evt.button || 'none');
  } else {
    button = evt.button || 'left';
  }

  // clickCount must be ≥1 on BOTH mousePressed and mouseReleased for Blink to
  // synthesize a 'click' event. A release with clickCount:0 suppresses the
  // click — that's what was breaking LinkedIn header dropdowns and other
  // custom controls that listen on 'click' rather than raw mouseup.
  let clickCount;
  if (evt.action === 'move') {
    clickCount = 0;
  } else if (typeof evt.clickCount === 'number') {
    clickCount = evt.clickCount;
  } else {
    clickCount = 1;
  }

  const params = {
    type: typeMap[evt.action],
    x: evt.x,
    y: evt.y,
    button,
    buttons: heldButtons,
    clickCount
  };

  if (evt.modifiers) params.modifiers = evt.modifiers;

  if (evt.action !== 'move') {
    log('[LOBSTERLINK:bg] Dispatching mouse', evt.action, 'at', evt.x, evt.y,
      '| button:', params.button, '| buttons:', params.buttons, '| clickCount:', params.clickCount);
  }

  chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', params).catch(err => {
    error('[LOBSTERLINK:bg] dispatchMouseEvent(' + evt.action + ') failed:', err.message || err);
  });
}

// Throttled hover-target hint to the page agent. Read-only — the page agent
// looks up the element at (x, y) and outlines it. This is a visualization
// only; raw CDP remains the sole path for delivering the actual click.
const HOVER_HINT_INTERVAL_MS = 50;
let lastHoverHintMs = 0;
function sendHoverHint(tabId, x, y) {
  const now = Date.now();
  if (now - lastHoverHintMs < HOVER_HINT_INTERVAL_MS) return;
  lastHoverHintMs = now;
  chrome.tabs.sendMessage(tabId, {
    action: 'pageAgentHoverHint',
    x,
    y
  }).catch(() => { /* agent may not be injected yet */ });
}

function dispatchKeyEvent(tabId, evt) {
  const target = { tabId };

  const typeMap = {
    down: 'keyDown',
    up: 'keyUp',
    char: 'char'
  };

  const params = {
    type: typeMap[evt.action],
    key: evt.key,
    code: evt.code,
    windowsVirtualKeyCode: evt.keyCode || 0,
    nativeVirtualKeyCode: evt.keyCode || 0
  };

  if (evt.text) params.text = evt.text;
  if (evt.unmodifiedText) params.unmodifiedText = evt.unmodifiedText;
  if (evt.modifiers) params.modifiers = evt.modifiers;

  log('[LOBSTERLINK:bg] Dispatching key', evt.action, ':', evt.key, '(code:', evt.code, ')');

  chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', params).catch(err => {
    error('[LOBSTERLINK:bg] dispatchKeyEvent(' + evt.action + ') failed:', err.message || err);
  });
}

// Expose for programmatic CDP triggering
self.handleStartHostingCDP = handleStartHostingCDP;
