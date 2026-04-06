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
    return true; // async
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
    hostState.viewerConnected = true;
    attachDebugger(hostState.capturedTabId);
    return false;
  }
  if (msg.action === 'viewerDisconnected') {
    hostState.viewerConnected = false;
    detachDebugger(hostState.capturedTabId);
    return false;
  }
  if (msg.action === 'inputEvent') {
    handleInputEvent(msg.event);
    return false;
  }
  return false;
});

// --- Host lifecycle ---

async function handleStartHosting() {
  try {
    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { error: 'No active tab' };

    hostState.capturedTabId = tab.id;

    // Get media stream ID for the tab
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

    // Create offscreen document
    await ensureOffscreenDocument();

    // Tell offscreen to start hosting with this stream
    await chrome.runtime.sendMessage({
      action: 'offscreen:startHost',
      streamId,
      tabId: tab.id
    });

    // Wait for peer ID from offscreen
    const peerId = await waitForPeerId();

    hostState.hosting = true;
    hostState.peerId = peerId;

    return { peerId };
  } catch (err) {
    return { error: err.message };
  }
}

async function handleStopHosting() {
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

// --- Debugger for input injection (Phase 2) ---

async function attachDebugger(tabId) {
  if (!tabId || hostState.debuggerAttached) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    hostState.debuggerAttached = true;
  } catch (e) {
    console.error('Failed to attach debugger:', e);
  }
}

async function detachDebugger(tabId) {
  if (!tabId || !hostState.debuggerAttached) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (e) { /* may already be detached */ }
  hostState.debuggerAttached = false;
}

// Handle debugger detach (user dismissed infobar, tab closed, etc.)
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === hostState.capturedTabId) {
    hostState.debuggerAttached = false;
  }
});

// --- Input injection (Phase 2) ---

function handleInputEvent(evt) {
  const tabId = hostState.capturedTabId;
  if (!tabId || !hostState.debuggerAttached) return;

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

  chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', params);
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

  chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', params);
}
