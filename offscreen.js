// Offscreen document — holds PeerJS peer + MediaStream for host mode
// Supports two modes:
//   tabCapture — MediaStream from chrome.tabCapture via getUserMedia
//   screencast — MediaStream from a canvas fed by CDP screencast JPEG frames

let peer = null;
let mediaStream = null;
let currentCall = null;
let dataConnection = null;

// Screencast canvas state
let screencastCanvas = null;
let screencastCtx = null;
let hostMode = null; // 'tabCapture' | 'screencast'

const INPUT_TYPES = new Set(['mouse', 'key']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'offscreen:startHost') {
    hostMode = 'tabCapture';
    startHostTabCapture(msg.streamId, msg.tabId);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === 'offscreen:startHostScreencast') {
    hostMode = 'screencast';
    startHostScreencast(msg.width, msg.height);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === 'offscreen:screencastFrame') {
    drawScreencastFrame(msg.data, msg.metadata);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === 'offscreen:screencastResize') {
    resizeScreencastCanvas(msg.width, msg.height);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === 'offscreen:stopHost') {
    stopHost();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === 'offscreen:sendToViewer') {
    sendToViewer(msg.message);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === 'offscreen:switchStream') {
    switchStream(msg.streamId, msg.tabId);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

function sendToViewer(message) {
  if (!dataConnection) {
    console.warn('[VIPSEE:offscreen] sendToViewer: no data connection');
    return;
  }
  try {
    dataConnection.send(JSON.stringify(message));
  } catch (e) {
    console.error('[VIPSEE:offscreen] Failed to send to viewer:', e);
  }
}

// --- Shared PeerJS setup (used by both modes) ---

function setupPeer() {
  peer = new Peer();

  peer.on('open', (id) => {
    console.log('[VIPSEE:offscreen] Peer ready, id:', id);
    chrome.runtime.sendMessage({ action: 'peerReady', peerId: id });
  });

  peer.on('call', (call) => {
    console.log('[VIPSEE:offscreen] Incoming media call from viewer');
    currentCall = call;
    call.answer(mediaStream);

    call.on('close', () => {
      console.log('[VIPSEE:offscreen] Media call closed');
      currentCall = null;
    });

    call.on('error', (err) => {
      console.error('[VIPSEE:offscreen] Media call error:', err);
    });
  });

  peer.on('connection', (conn) => {
    console.log('[VIPSEE:offscreen] Data connection from viewer');
    dataConnection = conn;

    chrome.runtime.sendMessage({ action: 'viewerConnected' });

    conn.on('open', () => {
      console.log('[VIPSEE:offscreen] Data channel open');
      sendViewportInfo();
    });

    conn.on('data', (data) => {
      const evt = typeof data === 'string' ? JSON.parse(data) : data;

      if (INPUT_TYPES.has(evt.type)) {
        if (evt.type !== 'mouse' || evt.action !== 'move') {
          console.log('[VIPSEE:offscreen] Forwarding input:', evt.type, evt.action,
            evt.type === 'mouse' ? `(${evt.x},${evt.y})` : evt.key);
        }
        chrome.runtime.sendMessage({ action: 'inputEvent', event: evt });
      } else {
        console.log('[VIPSEE:offscreen] Forwarding control:', evt.type);
        chrome.runtime.sendMessage({ action: 'controlEvent', event: evt });
      }
    });

    conn.on('close', () => {
      console.log('[VIPSEE:offscreen] Data connection closed');
      dataConnection = null;
      chrome.runtime.sendMessage({ action: 'viewerDisconnected' });
    });

    conn.on('error', (err) => {
      console.error('[VIPSEE:offscreen] Data connection error:', err);
    });
  });

  peer.on('error', (err) => {
    console.error('[VIPSEE:offscreen] Peer error:', err);
  });

  peer.on('disconnected', () => {
    console.log('[VIPSEE:offscreen] Peer disconnected from signaling, reconnecting...');
    if (peer && !peer.destroyed) {
      peer.reconnect();
    }
  });
}

function sendViewportInfo() {
  if (hostMode === 'tabCapture') {
    const track = mediaStream ? mediaStream.getVideoTracks()[0] : null;
    if (track) {
      const settings = track.getSettings();
      console.log('[VIPSEE:offscreen] Sending viewport:', settings.width, 'x', settings.height);
      sendToViewer({ type: 'viewport', width: settings.width, height: settings.height });
    }
  } else if (hostMode === 'screencast' && screencastCanvas) {
    console.log('[VIPSEE:offscreen] Sending viewport:', screencastCanvas.width, 'x', screencastCanvas.height);
    sendToViewer({
      type: 'viewport',
      width: screencastCanvas.width,
      height: screencastCanvas.height
    });
  }
}

// --- tabCapture mode ---

async function startHostTabCapture(streamId, tabId) {
  try {
    console.log('[VIPSEE:offscreen] Starting host (tabCapture), streamId:', streamId);

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });

    console.log('[VIPSEE:offscreen] Got MediaStream, tracks:', mediaStream.getTracks().length);
    setupPeer();
  } catch (err) {
    console.error('[VIPSEE:offscreen] Failed to start host (tabCapture):', err);
  }
}

async function switchStream(streamId, tabId) {
  console.log('[VIPSEE:offscreen] Switching stream, tabId:', tabId);

  const newStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    }
  });

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
  }
  mediaStream = newStream;

  if (currentCall && currentCall.peerConnection) {
    const newTrack = newStream.getVideoTracks()[0];
    const senders = currentCall.peerConnection.getSenders();
    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
    if (videoSender) {
      await videoSender.replaceTrack(newTrack);
      console.log('[VIPSEE:offscreen] Replaced video track on RTC connection');
    }
  }

  sendViewportInfo();
}

// --- Screencast canvas mode ---

function startHostScreencast(width, height) {
  console.log('[VIPSEE:offscreen] Starting host (screencast), canvas:', width, 'x', height);

  // Create canvas for rendering JPEG frames
  screencastCanvas = document.createElement('canvas');
  screencastCanvas.width = width;
  screencastCanvas.height = height;
  screencastCtx = screencastCanvas.getContext('2d');

  // Fill with black initially
  screencastCtx.fillStyle = '#000';
  screencastCtx.fillRect(0, 0, width, height);

  // Get MediaStream from canvas — 0 means frames are captured on
  // requestAnimationFrame / when the canvas is painted
  mediaStream = screencastCanvas.captureStream(0);

  console.log('[VIPSEE:offscreen] Canvas MediaStream created, tracks:', mediaStream.getTracks().length);
  setupPeer();
}

let frameDrawCount = 0;

function drawScreencastFrame(base64Data, metadata) {
  if (!screencastCtx || !screencastCanvas) {
    console.warn('[VIPSEE:offscreen] Frame dropped: no canvas/ctx');
    return;
  }
  if (!base64Data) {
    console.warn('[VIPSEE:offscreen] Frame dropped: no data');
    return;
  }

  frameDrawCount++;
  if (frameDrawCount <= 3 || frameDrawCount % 30 === 0) {
    console.log('[VIPSEE:offscreen] drawScreencastFrame #' + frameDrawCount,
      '| data length:', base64Data.length,
      '| canvas:', screencastCanvas.width, 'x', screencastCanvas.height,
      '| stream tracks:', mediaStream ? mediaStream.getVideoTracks().length : 0);
  }

  const img = new Image();
  img.onload = () => {
    // Resize canvas if frame dimensions changed
    if (img.width !== screencastCanvas.width || img.height !== screencastCanvas.height) {
      console.log('[VIPSEE:offscreen] Canvas resize:', img.width, 'x', img.height);
      screencastCanvas.width = img.width;
      screencastCanvas.height = img.height;
      screencastCtx = screencastCanvas.getContext('2d');
      sendViewportInfo();
    }

    screencastCtx.drawImage(img, 0, 0);

    // Request a frame capture from the canvas stream
    const track = mediaStream ? mediaStream.getVideoTracks()[0] : null;
    if (track && track.requestFrame) {
      track.requestFrame();
    } else if (frameDrawCount <= 3) {
      console.warn('[VIPSEE:offscreen] No requestFrame available on track',
        '| track:', track, '| has requestFrame:', track ? !!track.requestFrame : false);
    }
  };
  img.onerror = (err) => {
    console.error('[VIPSEE:offscreen] Image decode failed for frame #' + frameDrawCount);
  };
  img.src = 'data:image/jpeg;base64,' + base64Data;
}

function resizeScreencastCanvas(width, height) {
  if (!screencastCanvas) return;
  console.log('[VIPSEE:offscreen] Resizing screencast canvas to', width, 'x', height);
  screencastCanvas.width = width;
  screencastCanvas.height = height;
  screencastCtx = screencastCanvas.getContext('2d');
  screencastCtx.fillStyle = '#000';
  screencastCtx.fillRect(0, 0, width, height);
  sendViewportInfo();
}

// --- Cleanup ---

function stopHost() {
  console.log('[VIPSEE:offscreen] Stopping host, mode:', hostMode);
  if (dataConnection) {
    dataConnection.close();
    dataConnection = null;
  }
  if (currentCall) {
    currentCall.close();
    currentCall = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  if (peer) {
    peer.destroy();
    peer = null;
  }
  screencastCanvas = null;
  screencastCtx = null;
  hostMode = null;
}
