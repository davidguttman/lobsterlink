// Offscreen document — holds PeerJS peer + MediaStream for host mode

let peer = null;
let mediaStream = null;
let currentCall = null;
let dataConnection = null;

// Input event types that go to the debugger; everything else is a control event
const INPUT_TYPES = new Set(['mouse', 'key']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'offscreen:startHost') {
    startHost(msg.streamId, msg.tabId);
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

async function startHost(streamId, tabId) {
  try {
    console.log('[VIPSEE:offscreen] Starting host, streamId:', streamId, 'tabId:', tabId);

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
        const track = mediaStream.getVideoTracks()[0];
        if (track) {
          const settings = track.getSettings();
          console.log('[VIPSEE:offscreen] Sending viewport:', settings.width, 'x', settings.height);
          conn.send(JSON.stringify({
            type: 'viewport',
            width: settings.width,
            height: settings.height
          }));
        }
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
  } catch (err) {
    console.error('[VIPSEE:offscreen] Failed to start host:', err);
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

  const track = newStream.getVideoTracks()[0];
  if (track && dataConnection) {
    const settings = track.getSettings();
    sendToViewer({
      type: 'viewport',
      width: settings.width,
      height: settings.height
    });
  }
}

function stopHost() {
  console.log('[VIPSEE:offscreen] Stopping host');
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
}
