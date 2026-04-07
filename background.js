// Vipsee service worker — orchestrates host mode
// Supports two capture modes:
//   'tabCapture' — chrome.tabCapture (requires user gesture from popup)
//   'screencast' — CDP Page.startScreencast (works programmatically)

const SCREENCAST_MAX_WIDTH = 1280;
const SCREENCAST_MAX_HEIGHT = 720;

let hostState = {
  hosting: false,
  peerId: null,
  capturedTabId: null,
  debuggerAttached: false,
  viewerConnected: false,
  captureMode: null // 'tabCapture' | 'screencast'
};

// --- Message handling ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startHosting') {
    handleStartHosting().then(sendResponse);
    return true;
  }
  if (msg.action === 'startHostingCDP') {
    // Explicit CDP screencast mode (for programmatic/agent use)
    handleStartHostingCDP(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.action === 'stopHosting') {
    handleStopHosting().then(sendResponse);
    return true;
  }
  if (msg.action === 'getStatus') {
    sendResponse({
      hosting: hostState.hosting,
      peerId: hostState.peerId,
      viewerConnected: hostState.viewerConnected,
      captureMode: hostState.captureMode
    });
    return false;
  }
  // Messages from offscreen document
  if (msg.action === 'peerReady') {
    hostState.peerId = msg.peerId;
    return false;
  }
  if (msg.action === 'viewerConnected') {
    (async () => {
      hostState.viewerConnected = true;
      console.log('[VIPSEE:bg] Viewer connected, mode:', hostState.captureMode);
      // In screencast mode, debugger is already attached (needed for screencast).
      // In tabCapture mode, attach now for input injection.
      if (hostState.captureMode === 'tabCapture') {
        await attachDebugger(hostState.capturedTabId);
      } else if (hostState.captureMode === 'screencast' && hostState.debuggerAttached) {
        // Restart screencast to force CDP to emit fresh frames.
        // CDP only sends frames on visual changes, so on a static page
        // frames may have arrived before the viewer connected.
        console.log('[VIPSEE:bg] Restarting screencast for new viewer');
        const tabId = hostState.capturedTabId;
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast');
          const layoutMetrics = await chrome.debugger.sendCommand(
            { tabId }, 'Page.getLayoutMetrics'
          );
          const w = Math.round(layoutMetrics.cssLayoutViewport.clientWidth);
          const h = Math.round(layoutMetrics.cssLayoutViewport.clientHeight);
          await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', {
            format: 'jpeg',
            quality: 80,
            maxWidth: SCREENCAST_MAX_WIDTH,
            maxHeight: SCREENCAST_MAX_HEIGHT
          });
          screencastFrameCount = 0;
          console.log('[VIPSEE:bg] Screencast restarted at', w, 'x', h);
        } catch (e) {
          console.error('[VIPSEE:bg] Failed to restart screencast:', e.message || e);
        }
      }
      console.log('[VIPSEE:bg] Debugger attached:', hostState.debuggerAttached);
      sendTabListToViewer();
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.action === 'viewerDisconnected') {
    hostState.viewerConnected = false;
    console.log('[VIPSEE:bg] Viewer disconnected');
    // In tabCapture mode, detach debugger (it was only for input).
    // In screencast mode, keep debugger attached (needed for screencast).
    if (hostState.captureMode === 'tabCapture') {
      detachDebugger(hostState.capturedTabId);
    }
    return false;
  }
  if (msg.action === 'inputEvent') {
    handleInputEvent(msg.event);
    return false;
  }
  if (msg.action === 'controlEvent') {
    console.log('[VIPSEE:bg] Received controlEvent:', msg.event.type);
    handleControlEvent(msg.event);
    return false;
  }
  return false;
});

// --- Host lifecycle: tabCapture mode ---

async function handleStartHosting() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { error: 'No active tab found' };

    console.log('[VIPSEE:bg] Starting host on tab', tab.id, tab.url);
    hostState.capturedTabId = tab.id;

    // Try tabCapture first (requires user gesture)
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

      await ensureOffscreenDocument();
      await chrome.runtime.sendMessage({
        action: 'offscreen:startHost',
        streamId,
        tabId: tab.id
      });

      const peerId = await waitForPeerId();
      hostState.hosting = true;
      hostState.peerId = peerId;
      hostState.captureMode = 'tabCapture';
      setupTabListeners();

      console.log('[VIPSEE:bg] Host started (tabCapture), peerId:', peerId);
      return { peerId, captureMode: 'tabCapture' };
    } catch (tabCaptureErr) {
      console.warn('[VIPSEE:bg] tabCapture failed, falling back to CDP screencast:', tabCaptureErr.message);
      return await startScreencastMode(tab.id);
    }
  } catch (err) {
    console.error('[VIPSEE:bg] startHosting error:', err);
    return { error: err.message };
  }
}

// --- Host lifecycle: CDP screencast mode ---

async function handleStartHostingCDP(tabId) {
  try {
    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return { error: 'No active tab found' };
      tabId = tab.id;
    }
    console.log('[VIPSEE:bg] Starting host (explicit CDP mode) on tab', tabId);
    return await startScreencastMode(tabId);
  } catch (err) {
    console.error('[VIPSEE:bg] startHostingCDP error:', err);
    return { error: err.message };
  }
}

async function startScreencastMode(tabId) {
  hostState.capturedTabId = tabId;

  // Attach debugger (needed for screencast AND input)
  await attachDebugger(tabId);
  if (!hostState.debuggerAttached) {
    return { error: 'Failed to attach debugger for screencast' };
  }

  console.log('[VIPSEE:bg] Screencast dimensions capped to', SCREENCAST_MAX_WIDTH, 'x', SCREENCAST_MAX_HEIGHT);

  // Set up offscreen document in screencast/canvas mode
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    action: 'offscreen:startHostScreencast',
    width: SCREENCAST_MAX_WIDTH,
    height: SCREENCAST_MAX_HEIGHT
  });

  // Enable Page domain events (required for screencastFrame events to fire)
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  console.log('[VIPSEE:bg] Page domain enabled');

  // Start CDP screencast
  await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', {
    format: 'jpeg',
    quality: 80,
    maxWidth: SCREENCAST_MAX_WIDTH,
    maxHeight: SCREENCAST_MAX_HEIGHT
  });

  console.log('[VIPSEE:bg] CDP screencast started');

  const peerId = await waitForPeerId();
  hostState.hosting = true;
  hostState.peerId = peerId;
  hostState.captureMode = 'screencast';
  setupTabListeners();

  console.log('[VIPSEE:bg] Host started (screencast), peerId:', peerId);
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

// --- Stop hosting (both modes) ---

async function handleStopHosting() {
  teardownTabListeners();

  if (hostState.captureMode === 'screencast') {
    await stopScreencast();
  }

  try {
    await chrome.runtime.sendMessage({ action: 'offscreen:stopHost' });
  } catch (e) { /* offscreen may already be gone */ }

  await detachDebugger(hostState.capturedTabId);

  try {
    await chrome.offscreen.closeDocument();
  } catch (e) { /* may not exist */ }

  hostState = {
    hosting: false,
    peerId: null,
    capturedTabId: null,
    debuggerAttached: false,
    viewerConnected: false,
    captureMode: null
  };

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

// --- CDP screencast frame handling ---

let screencastFrameCount = 0;

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== hostState.capturedTabId) return;
  if (method !== 'Page.screencastFrame') return;

  screencastFrameCount++;
  if (screencastFrameCount <= 3 || screencastFrameCount % 30 === 0) {
    console.log('[VIPSEE:bg] screencastFrame #' + screencastFrameCount,
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
      console.error('[VIPSEE:bg] Failed to forward frame to offscreen:', err.message || err);
    }
  });

  // Ack the frame so CDP sends the next one
  const ackSessionId = params.sessionId;
  if (screencastFrameCount <= 3) {
    console.log('[VIPSEE:bg] Acking frame #' + screencastFrameCount,
      '| sessionId:', ackSessionId, '| tabId:', source.tabId);
  }
  chrome.debugger.sendCommand(source, 'Page.screencastFrameAck', {
    sessionId: ackSessionId
  }).then(() => {
    if (screencastFrameCount <= 3) {
      console.log('[VIPSEE:bg] Ack succeeded for frame #' + screencastFrameCount);
    }
  }).catch((err) => {
    console.error('[VIPSEE:bg] Ack FAILED for frame #' + screencastFrameCount,
      ':', err.message || err, '| sessionId:', ackSessionId);
  });
});

// --- Tab management (Phase 3) ---

function onTabActivated(activeInfo) {
  if (!hostState.hosting || !hostState.viewerConnected) return;
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
  if (tabId === hostState.capturedTabId) {
    if (hostState.captureMode === 'screencast') {
      stopScreencast();
    }
    hostState.capturedTabId = null;
    hostState.debuggerAttached = false;
    sendToViewer({ type: 'status', capturing: false, tabId: null });
  }
  sendTabListToViewer();
}

function onTabCreated(tab) {
  if (!hostState.hosting || !hostState.viewerConnected) return;
  sendTabListToViewer();
  if (tab && tab.openerTabId === hostState.capturedTabId) {
    console.log('[VIPSEE:bg] New tab opened from captured tab, auto-switching to', tab.id);
    setTimeout(() => switchTab(tab.id), 300);
  }
}

function setupTabListeners() {
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  chrome.tabs.onCreated.addListener(onTabCreated);
}

function teardownTabListeners() {
  chrome.tabs.onActivated.removeListener(onTabActivated);
  chrome.tabs.onUpdated.removeListener(onTabUpdated);
  chrome.tabs.onRemoved.removeListener(onTabRemoved);
  chrome.tabs.onCreated.removeListener(onTabCreated);
}

async function sendTabListToViewer() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
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
    console.error('[VIPSEE:bg] Failed to send tab list:', e);
  }
}

// --- Control message handling (Phase 3) ---

async function handleControlEvent(evt) {
  try {
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

      case 'newTab':
        await createNewTab(evt.url);
        break;

      case 'closeTab':
        await closeTab(evt.tabId);
        break;
    }
  } catch (err) {
    console.error('[VIPSEE:bg] Control event error:', err, evt);
  }
}

async function switchTab(tabId) {
  if (!tabId) return;

  if (hostState.captureMode === 'screencast') {
    // Stop screencast on old tab
    await stopScreencast();
    await detachDebugger(hostState.capturedTabId);

    // Activate and capture new tab
    await chrome.tabs.update(tabId, { active: true });
    hostState.capturedTabId = tabId;

    await attachDebugger(tabId);

    // Get new page dimensions
    const layoutMetrics = await chrome.debugger.sendCommand(
      { tabId }, 'Page.getLayoutMetrics'
    );
    const width = Math.round(layoutMetrics.cssLayoutViewport.clientWidth);
    const height = Math.round(layoutMetrics.cssLayoutViewport.clientHeight);

    // Resize canvas in offscreen doc
    await chrome.runtime.sendMessage({
      action: 'offscreen:screencastResize',
      width,
      height
    });

    // Restart screencast on new tab
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: SCREENCAST_MAX_WIDTH,
      maxHeight: SCREENCAST_MAX_HEIGHT
    });
  } else {
    // tabCapture mode
    await detachDebugger(hostState.capturedTabId);
    await chrome.tabs.update(tabId, { active: true });

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    hostState.capturedTabId = tabId;

    await chrome.runtime.sendMessage({
      action: 'offscreen:switchStream',
      streamId,
      tabId
    });

    await attachDebugger(tabId);
  }

  const tab = await chrome.tabs.get(tabId);
  sendToViewer({
    type: 'tabChanged',
    tabId: tab.id,
    url: tab.url || '',
    title: tab.title || ''
  });
  sendToViewer({ type: 'status', capturing: true, tabId });
  await sendTabListToViewer();
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
  if (!tabId || hostState.debuggerAttached) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    console.log('[VIPSEE:bg] Attaching debugger to tab', tabId, '| url:', tab.url);

    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
      console.warn('[VIPSEE:bg] WARNING: Cannot attach debugger to chrome:// or extension pages');
      return;
    }

    await chrome.debugger.attach({ tabId }, '1.3');
    hostState.debuggerAttached = true;
    console.log('[VIPSEE:bg] Debugger attached successfully to tab', tabId);

    await injectCursorOverlay(tabId);
  } catch (e) {
    console.error('[VIPSEE:bg] Failed to attach debugger to tab', tabId, ':', e.message || e);
  }
}

async function detachDebugger(tabId) {
  if (!tabId || !hostState.debuggerAttached) return;
  try {
    await chrome.debugger.detach({ tabId });
    console.log('[VIPSEE:bg] Debugger detached from tab', tabId);
  } catch (e) { /* may already be detached */ }
  hostState.debuggerAttached = false;
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== hostState.capturedTabId) return;
  console.warn('[VIPSEE:bg] Debugger detached externally, reason:', reason);
  hostState.debuggerAttached = false;

  if (hostState.hosting && hostState.viewerConnected) {
    retryAttachDebugger(5, 500);
  }
});

// --- Debugger reattach with retries ---

let reattachInProgress = false;

async function retryAttachDebugger(maxRetries, delayMs) {
  if (reattachInProgress) return;
  reattachInProgress = true;

  for (let i = 0; i < maxRetries; i++) {
    if (hostState.debuggerAttached) break;
    if (!hostState.hosting || !hostState.viewerConnected) break;

    await new Promise(r => setTimeout(r, delayMs));
    console.log(`[VIPSEE:bg] Reattach attempt ${i + 1}/${maxRetries}...`);

    try {
      const tab = await chrome.tabs.get(hostState.capturedTabId);
      if (tab) {
        await attachDebugger(tab.id);
        if (hostState.debuggerAttached) {
          // If in screencast mode, restart the screencast
          if (hostState.captureMode === 'screencast') {
            const layoutMetrics = await chrome.debugger.sendCommand(
              { tabId: tab.id }, 'Page.getLayoutMetrics'
            );
            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable');
            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.startScreencast', {
              format: 'jpeg', quality: 80,
              maxWidth: SCREENCAST_MAX_WIDTH, maxHeight: SCREENCAST_MAX_HEIGHT
            });
          }
          console.log('[VIPSEE:bg] Reattach succeeded on attempt', i + 1);
          break;
        }
      }
    } catch (e) {
      console.log('[VIPSEE:bg] Original tab gone, switching to active tab');
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) {
          await switchTab(activeTab.id);
          break;
        }
      } catch (e2) {
        console.error('[VIPSEE:bg] Reattach attempt', i + 1, 'failed:', e2.message);
      }
    }

    delayMs = Math.min(delayMs * 1.5, 3000);
  }

  reattachInProgress = false;
  if (!hostState.debuggerAttached) {
    console.error('[VIPSEE:bg] Failed to reattach debugger after', maxRetries, 'attempts');
  }
}

// --- Remote cursor overlay (injected into host page via CDP) ---

const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M2 2l6 16 2.5-6.5L17 9z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

const CURSOR_INJECT_JS = `
(function() {
  if (document.getElementById('__vipsee_cursor__')) return;
  var el = document.createElement('div');
  el.id = '__vipsee_cursor__';
  el.style.cssText = 'position:fixed;top:0;left:0;width:20px;height:20px;z-index:2147483647;pointer-events:none;opacity:0.85;will-change:transform;';
  el.innerHTML = '${CURSOR_SVG.replace(/'/g, "\\'")}';
  document.documentElement.appendChild(el);
})();
`;

let cursorMoveCount = 0;

async function injectCursorOverlay(tabId) {
  if (!hostState.debuggerAttached) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: CURSOR_INJECT_JS
    });
    console.log('[VIPSEE:bg] Cursor overlay injected into tab', tabId);
  } catch (e) {
    console.warn('[VIPSEE:bg] Failed to inject cursor overlay:', e.message || e);
  }
}

function updateCursorPosition(tabId, x, y) {
  cursorMoveCount++;
  if (cursorMoveCount % 3 !== 0) return;

  const expr = `(function(){var c=document.getElementById('__vipsee_cursor__');if(c)c.style.transform='translate(${x}px,${y}px)'})()`;
  chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: expr
  }).catch(() => {});
}

function onTabNavigated(tabId) {
  if (tabId === hostState.capturedTabId && hostState.debuggerAttached) {
    setTimeout(() => injectCursorOverlay(tabId), 500);
  }
}

// --- Input injection ---

function handleInputEvent(evt) {
  const tabId = hostState.capturedTabId;
  if (!tabId) {
    console.warn('[VIPSEE:bg] Input dropped: no capturedTabId');
    return;
  }
  if (!hostState.debuggerAttached) {
    if (!reattachInProgress) {
      console.warn('[VIPSEE:bg] Input dropped: debugger not attached, triggering reattach');
      retryAttachDebugger(5, 300);
    }
    return;
  }

  if (evt.type === 'mouse') {
    dispatchMouseEvent(tabId, evt);
  } else if (evt.type === 'key') {
    dispatchKeyEvent(tabId, evt);
  }
}

function dispatchMouseEvent(tabId, evt) {
  const target = { tabId };

  if (evt.action === 'wheel') {
    chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: evt.x,
      y: evt.y,
      deltaX: evt.deltaX || 0,
      deltaY: evt.deltaY || 0
    }).catch(err => {
      console.error('[VIPSEE:bg] dispatchMouseEvent(wheel) failed:', err.message || err);
    });
    return;
  }

  const typeMap = {
    move: 'mouseMoved',
    down: 'mousePressed',
    up: 'mouseReleased'
  };

  const params = {
    type: typeMap[evt.action],
    x: evt.x,
    y: evt.y,
    button: evt.button || 'left',
    clickCount: evt.clickCount || (evt.action === 'down' ? 1 : 0)
  };

  if (evt.modifiers) params.modifiers = evt.modifiers;

  if (evt.action !== 'move') {
    console.log('[VIPSEE:bg] Dispatching mouse', evt.action, 'at', evt.x, evt.y, 'button:', params.button);
  }

  if (evt.action === 'move') {
    updateCursorPosition(tabId, evt.x, evt.y);
  }

  chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', params).catch(err => {
    console.error('[VIPSEE:bg] dispatchMouseEvent(' + evt.action + ') failed:', err.message || err);
  });
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

  console.log('[VIPSEE:bg] Dispatching key', evt.action, ':', evt.key, '(code:', evt.code, ')');

  chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', params).catch(err => {
    console.error('[VIPSEE:bg] dispatchKeyEvent(' + evt.action + ') failed:', err.message || err);
  });
}

// Expose for programmatic CDP triggering
self.handleStartHosting = handleStartHosting;
self.handleStartHostingCDP = handleStartHostingCDP;

