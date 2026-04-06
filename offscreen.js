// Offscreen document — holds PeerJS peer + MediaStream for host mode

let peer = null;
let mediaStream = null;
let currentCall = null;
let dataConnection = null;

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
  return false;
});

async function startHost(streamId, tabId) {
  try {
    // Get MediaStream from the tab capture stream ID
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });

    // Create PeerJS peer
    peer = new Peer();

    peer.on('open', (id) => {
      console.log('Vipsee host peer ready:', id);
      chrome.runtime.sendMessage({ action: 'peerReady', peerId: id });
    });

    peer.on('call', (call) => {
      console.log('Incoming call from viewer');
      currentCall = call;
      call.answer(mediaStream);

      call.on('close', () => {
        console.log('Call closed');
        currentCall = null;
      });

      call.on('error', (err) => {
        console.error('Call error:', err);
      });
    });

    peer.on('connection', (conn) => {
      console.log('Data connection from viewer');
      dataConnection = conn;

      chrome.runtime.sendMessage({ action: 'viewerConnected' });

      // Send viewport info
      const track = mediaStream.getVideoTracks()[0];
      const settings = track.getSettings();
      conn.on('open', () => {
        conn.send(JSON.stringify({
          type: 'viewport',
          width: settings.width,
          height: settings.height
        }));
      });

      conn.on('data', (data) => {
        const evt = typeof data === 'string' ? JSON.parse(data) : data;
        // Forward input events to service worker for debugger injection
        chrome.runtime.sendMessage({ action: 'inputEvent', event: evt });
      });

      conn.on('close', () => {
        console.log('Data connection closed');
        dataConnection = null;
        chrome.runtime.sendMessage({ action: 'viewerDisconnected' });
      });
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
    });
  } catch (err) {
    console.error('Failed to start host:', err);
  }
}

function stopHost() {
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
