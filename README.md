# Vipsee — Remote Browser Tab Viewer

A Chrome extension for remotely viewing and controlling browser tabs via WebRTC (PeerJS).

One extension, two modes:
- **Host** — shares a tab's video stream and accepts input/control commands
- **Viewer** — connects to a host, renders the live tab, and sends mouse/keyboard input

Two capture backends:
- **tabCapture** — high fidelity, requires human click in popup (user gesture)
- **CDP screencast** — works programmatically (agent/API use), falls back automatically when tabCapture is unavailable

## Setup

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select this directory
5. The Vipsee extension icon appears in the toolbar

## Usage

### Host (remote machine)

1. Navigate to the tab you want to share
2. Click the Vipsee extension icon → **Host** → **Start Hosting**
3. The viewer auto-opens in a new window with the peer ID pre-filled
4. Share the peer ID if connecting from a different machine

### Viewer (local machine)

1. Click the Vipsee extension icon → **Viewer**
2. Paste the host's peer ID, click **Connect**
3. The viewer opens in a new window with the remote tab's live video
4. Mouse and keyboard events are forwarded to the host automatically
5. Use the nav bar: back/forward/reload, URL bar, tab dropdown, viewport selector

### Programmatic / Agent Use

Send a `startHostingCDP` message to the service worker to start hosting without a user gesture:
```js
chrome.runtime.sendMessage({ action: 'startHostingCDP', tabId: 123 });
```
This uses CDP `Page.startScreencast` instead of `tabCapture`.

## Requirements

- Chrome (not headless — `tabCapture` needs a headed browser)
- On servers, run Chrome under Xvfb: `xvfb-run google-chrome --no-sandbox`
- Both machines need internet access (PeerJS uses `0.peerjs.com` for signaling, then direct WebRTC)

## Troubleshooting

- **"Extension is debugging this tab" infobar** — expected when `chrome.debugger` is attached. Don't dismiss it or input injection stops.
- **Black/frozen video (same window)** — In tabCapture mode, the host tab must stay active. If the viewer is in the same window, Chrome backgrounds the host tab and freezes the stream. The popup auto-opens the viewer in a separate window to prevent this.
- **No video** — ensure the host tab is active when starting. `tabCapture` requires an active tab.
- **Connection fails** — both machines must reach `0.peerjs.com:443` and establish a direct WebRTC connection (or TURN relay). Firewalls/NAT may block this.
- **Screencast black screen** — CDP screencast only sends frames on visual changes. On static pages, frames may arrive before the viewer connects. The extension restarts the screencast on viewer connect and uses a canvas frame ticker to force continuous output.

## Architecture

```
Host (service worker + offscreen doc)     Viewer (viewer.html)
┌─────────────────────────┐               ┌─────────────────────┐
│ tabCapture / screencast  │               │ <video> element      │
│ → MediaStream (offscreen)│──RTC video──→ │ → renders live tab   │
│                          │               │                      │
│ chrome.debugger          │←─RTC data───  │ mouse/keyboard/ctrl  │
│ → Input.dispatch*        │   channel     │ → forwarded events   │
│                          │               │                      │
│ chrome.tabs.*            │←─RTC data───  │ nav bar, tab list    │
│ → tab management         │   channel     │ → control messages   │
└──────────────────────────┘               └──────────────────────┘
```

## Permissions

- `tabCapture` — capture tab video
- `tabs` — query/manage tabs
- `debugger` — inject input events + screencast via Chrome DevTools Protocol
- `activeTab` — access active tab on user gesture
- `offscreen` — create offscreen document for MediaStream handling
