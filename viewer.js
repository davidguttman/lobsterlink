// Vipsee Viewer — connects to host, renders video, captures and sends input

const video = document.getElementById('remote-video');
const overlay = document.getElementById('connect-overlay');
const overlayInput = document.getElementById('overlay-peer-input');
const overlayConnect = document.getElementById('overlay-connect');
const overlayError = document.getElementById('overlay-error');
const statusEl = document.getElementById('connection-status');
const urlBar = document.getElementById('url-bar');

let peer = null;
let dataConn = null;
let remoteViewport = { width: 1920, height: 1080 };

// Check URL params for peer ID
const params = new URLSearchParams(location.search);
const initialPeerId = params.get('peerId');
if (initialPeerId) {
  overlayInput.value = initialPeerId;
}

// --- Connection ---

overlayConnect.addEventListener('click', () => connect(overlayInput.value.trim()));
overlayInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connect(overlayInput.value.trim());
});

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

function connect(hostPeerId) {
  if (!hostPeerId) return;
  overlayError.textContent = '';
  setStatus('Connecting...', 'connecting');

  peer = new Peer();

  peer.on('open', () => {
    // Open data connection
    dataConn = peer.connect(hostPeerId, { reliable: true });

    dataConn.on('open', () => {
      setStatus('Connected', 'connected');
      overlay.classList.add('hidden');
    });

    dataConn.on('data', (data) => {
      const msg = typeof data === 'string' ? JSON.parse(data) : data;
      handleHostMessage(msg);
    });

    dataConn.on('close', () => {
      setStatus('Disconnected', '');
      overlay.classList.remove('hidden');
    });

    dataConn.on('error', (err) => {
      overlayError.textContent = err.message || 'Connection error';
      setStatus('Error', '');
    });

    // Request media call
    const call = peer.call(hostPeerId, createEmptyStream());

    call.on('stream', (remoteStream) => {
      video.srcObject = remoteStream;
    });

    call.on('close', () => {
      video.srcObject = null;
    });

    call.on('error', (err) => {
      console.error('Call error:', err);
    });
  });

  peer.on('error', (err) => {
    console.error('Peer error:', err);
    overlayError.textContent = err.message || 'Failed to connect';
    setStatus('Error', '');
  });
}

// We need to send a stream to initiate the call (PeerJS requires it for call())
// Create a dummy silent stream
function createEmptyStream() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  return canvas.captureStream(0);
}

function handleHostMessage(msg) {
  if (msg.type === 'viewport') {
    remoteViewport.width = msg.width;
    remoteViewport.height = msg.height;
  } else if (msg.type === 'tabChanged') {
    urlBar.value = msg.url || '';
    document.title = `Vipsee — ${msg.title || 'Remote Tab'}`;
  } else if (msg.type === 'tabList') {
    // Phase 3: populate tab dropdown
  }
}

// --- Input capture (Phase 2) ---

function getModifiers(e) {
  let m = 0;
  if (e.altKey) m |= 1;
  if (e.ctrlKey) m |= 2;
  if (e.metaKey) m |= 4;
  if (e.shiftKey) m |= 8;
  return m;
}

function mapCoords(e) {
  const rect = video.getBoundingClientRect();
  // Video may be letterboxed — compute actual rendered area
  const videoW = video.videoWidth || remoteViewport.width;
  const videoH = video.videoHeight || remoteViewport.height;
  const videoAspect = videoW / videoH;
  const rectAspect = rect.width / rect.height;

  let renderW, renderH, offsetX, offsetY;
  if (rectAspect > videoAspect) {
    // Letterboxed horizontally
    renderH = rect.height;
    renderW = rect.height * videoAspect;
    offsetX = (rect.width - renderW) / 2;
    offsetY = 0;
  } else {
    // Letterboxed vertically
    renderW = rect.width;
    renderH = rect.width / videoAspect;
    offsetX = 0;
    offsetY = (rect.height - renderH) / 2;
  }

  const localX = e.clientX - rect.left - offsetX;
  const localY = e.clientY - rect.top - offsetY;

  // Map to remote viewport coordinates
  const x = Math.round((localX / renderW) * remoteViewport.width);
  const y = Math.round((localY / renderH) * remoteViewport.height);

  return { x, y };
}

const BUTTON_MAP = ['left', 'middle', 'right'];

function sendInput(evt) {
  if (!dataConn || dataConn.open === false) return;
  dataConn.send(JSON.stringify(evt));
}

// Mouse events
video.addEventListener('mousemove', (e) => {
  const { x, y } = mapCoords(e);
  sendInput({ type: 'mouse', action: 'move', x, y, modifiers: getModifiers(e) });
});

video.addEventListener('mousedown', (e) => {
  e.preventDefault();
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

// Context menu suppression
video.addEventListener('contextmenu', (e) => e.preventDefault());

// Keyboard events — capture when video is focused
video.setAttribute('tabindex', '0');

video.addEventListener('keydown', (e) => {
  e.preventDefault();
  const evt = {
    type: 'key', action: 'down',
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    modifiers: getModifiers(e)
  };
  // For printable characters, also send text
  if (e.key.length === 1) {
    evt.text = e.key;
    evt.unmodifiedText = e.key;
  }
  sendInput(evt);
});

video.addEventListener('keyup', (e) => {
  e.preventDefault();
  sendInput({
    type: 'key', action: 'up',
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    modifiers: getModifiers(e)
  });
});

// Focus video on click so keyboard events are captured
video.addEventListener('click', () => video.focus());

// Auto-focus video when stream starts
video.addEventListener('playing', () => video.focus());

// Nav bar buttons (Phase 2: send control messages)
document.getElementById('btn-back').addEventListener('click', () => {
  sendInput({ type: 'goBack' });
});
document.getElementById('btn-forward').addEventListener('click', () => {
  sendInput({ type: 'goForward' });
});
document.getElementById('btn-reload').addEventListener('click', () => {
  sendInput({ type: 'reload' });
});

// Auto-connect if peer ID was provided
if (initialPeerId) {
  connect(initialPeerId);
}
