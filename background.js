// Vipsee service worker — orchestrates host mode

let hostState = {
  hosting: false,
  peerId: null,
  capturedTabId: null,
  debuggerAttached: false,
  viewerConnected: false
};

// --- Message handling ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startHosting') {
    handleStartHosting().then(sendResponse);
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
      viewerConnected: hostState.viewerConnected
    });
    return false;
  }
  // Messages from offscreen document
  if (msg.action === 'peerReady') {
    hostState.peerId = msg.peerId;
    return false;
  }
  if (msg.action === 'viewerConnected') {
    // Must be async — await debugger attach before input can work
    (async () => {
      hostState.viewerConnected = true;
      console.log('[VIPSEE:bg] Viewer connected, attaching debugger to tab', hostState.capturedTabId);
      await attachDebugger(hostState.capturedTabId);
      console.log('[VIPSEE:bg] Debugger attached:', hostState.debuggerAttached);
      sendTabListToViewer();
      sendResponse({ ok: true });
    })();
    return true; // keep sendResponse channel open for async
  }
  if (msg.action === 'viewerDisconnected') {
    hostState.viewerConnected = false;
    console.log('[VIPSEE:bg] Viewer disconnected, detaching debugger');
    detachDebugger(hostState.capturedTabId);
    return false;
  }
  if (msg.action === 'inputEvent') {
    console.log('[VIPSEE:bg] Received inputEvent:', msg.event.type, msg.event.action,
      msg.event.type === 'mouse' ? `(${msg.event.x},${msg.event.y})` : msg.event.key);
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

// --- Host lifecycle ---

async function handleStartHosting() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { error: 'No active tab found' };

    console.log('[VIPSEE:bg] Starting host on tab', tab.id, tab.url);
    hostState.capturedTabId = tab.id;

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

    // Start listening for tab changes
    setupTabListeners();

    console.log('[VIPSEE:bg] Host started, peerId:', peerId);
    return { peerId };
  } catch (err) {
    console.error('[VIPSEE:bg] startHosting error:', err);
    return { error: err.message };
  }
}

async function handleStopHosting() {
  teardownTabListeners();

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
    viewerConnected: false
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

// Send a message to the viewer via the offscreen doc's data channel
function sendToViewer(message) {
  if (!hostState.viewerConnected) return;
  chrome.runtime.sendMessage({
    action: 'offscreen:sendToViewer',
    message
  }).catch(() => {}); // offscreen may be gone
}

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
      // Re-inject cursor after page navigation completes
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
    hostState.capturedTabId = null;
    hostState.debuggerAttached = false;
    sendToViewer({ type: 'status', capturing: false, tabId: null });
  }
  sendTabListToViewer();
}

function onTabCreated() {
  if (!hostState.hosting || !hostState.viewerConnected) return;
  sendTabListToViewer();
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
        if (hostState.capturedTabId) {
          await chrome.tabs.goBack(hostState.capturedTabId);
        }
        break;

      case 'goForward':
        if (hostState.capturedTabId) {
          await chrome.tabs.goForward(hostState.capturedTabId);
        }
        break;

      case 'reload':
        if (hostState.capturedTabId) {
          await chrome.tabs.reload(hostState.capturedTabId);
        }
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
    // Log what we're attaching to so we can spot chrome:// / extension page issues
    const tab = await chrome.tabs.get(tabId);
    console.log('[VIPSEE:bg] Attaching debugger to tab', tabId, '| url:', tab.url);

    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
      console.warn('[VIPSEE:bg] WARNING: Cannot attach debugger to chrome:// or extension pages');
      return;
    }

    await chrome.debugger.attach({ tabId }, '1.3');
    hostState.debuggerAttached = true;
    console.log('[VIPSEE:bg] Debugger attached successfully to tab', tabId);

    // Inject cursor overlay into the host page
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
  if (source.tabId === hostState.capturedTabId) {
    console.warn('[VIPSEE:bg] Debugger detached externally, reason:', reason);
    hostState.debuggerAttached = false;

    // Auto-reattach after navigation or target_closed
    if (hostState.hosting && hostState.viewerConnected) {
      console.log('[VIPSEE:bg] Attempting debugger re-attach...');
      setTimeout(async () => {
        // The tab may have navigated — check if it still exists
        try {
          const tab = await chrome.tabs.get(hostState.capturedTabId);
          if (tab) {
            await attachDebugger(tab.id);
            return;
          }
        } catch (e) {
          // Tab is gone — find the now-active tab and switch to it
          console.log('[VIPSEE:bg] Original tab gone, switching to active tab');
        }
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab) {
            await switchTab(activeTab.id);
          }
        } catch (e) {
          console.error('[VIPSEE:bg] Failed to recover after debugger detach:', e);
        }
      }, 500);
    }
  }
});

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
  // Throttle: update every 3rd move to reduce Runtime.evaluate overhead
  cursorMoveCount++;
  if (cursorMoveCount % 3 !== 0) return;

  const expr = `(function(){var c=document.getElementById('__vipsee_cursor__');if(c)c.style.transform='translate(${x}px,${y}px)'})()`;
  chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: expr
  }).catch(() => {}); // non-critical, suppress errors
}

// Re-inject cursor after page navigation
function onTabNavigated(tabId) {
  if (tabId === hostState.capturedTabId && hostState.debuggerAttached) {
    // Small delay to let the new page load
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
    console.warn('[VIPSEE:bg] Input dropped: debugger not attached');
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

  // Update injected cursor position on moves
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
