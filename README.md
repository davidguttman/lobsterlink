# Vipsee — Remote Browser Tab Viewer

A Chrome extension for remotely viewing and controlling browser tabs via WebRTC (PeerJS).

One extension, two modes:
- **Host** — shares a tab's video stream and accepts input/control commands
- **Viewer** — connects to a host, renders the live tab, and sends mouse/keyboard input

## Setup

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select this directory
5. The Vipsee extension icon appears in the toolbar

## Usage

### Host (remote machine)

1. Navigate to the tab you want to share
2. Click the Vipsee extension icon
3. Click **Host** → **Start Hosting**
4. Copy the peer ID displayed

### Viewer (local machine)

1. Click the Vipsee extension icon
2. Click **Viewer**, paste the host's peer ID, click **Connect**
3. A new tab opens with the remote tab's live video
4. Click on the video to focus it — mouse and keyboard events are forwarded to the host
5. Use the nav bar to navigate, switch tabs, open/close tabs

## Two-Machine Testing

### Requirements
- Chrome (not Chromium headless — `tabCapture` needs a headed browser)
- On headless servers, run Chrome under Xvfb: `xvfb-run google-chrome --no-sandbox`
- Both machines need internet access (PeerJS uses `0.peerjs.com` for signaling, then direct WebRTC)

### Steps

1. Install the extension on both machines
2. On Machine A (host): open a tab, start hosting, note the peer ID
3. On Machine B (viewer): enter the peer ID, connect
4. Verify: video renders, mouse clicks/scrolls work, keyboard input works
5. Test nav: type a URL in the viewer's URL bar and press Enter
6. Test tabs: use the dropdown to switch tabs, + to open, × to close

### Troubleshooting

- **"Extension is debugging this tab" infobar** — expected; Chrome shows this when `chrome.debugger` is attached. Do not dismiss it or input injection will stop.
- **Black/frozen video (same window)** — In tabCapture mode, if the viewer tab is in the same window as the host tab, Chrome backgrounds and throttles the host tab, killing the capture stream. The viewer must be in a **separate window**. The popup auto-opens the viewer in a new window to avoid this.
- **No video** — check that the host tab is active when you start hosting. `tabCapture` requires an active tab.
- **Connection fails** — both machines need to be able to reach `0.peerjs.com:443` and establish a direct WebRTC connection (or have TURN relay). Firewalls/NAT may block this.
- **Input not working** — click on the video element to focus it. Keyboard events only send when the video is focused.

## Architecture

```
Host (service worker + offscreen doc)     Viewer (viewer.html)
┌─────────────────────────┐               ┌─────────────────────┐
│ chrome.tabCapture        │               │ <video> element      │
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
- `debugger` — inject input events via Chrome DevTools Protocol
- `activeTab` — access active tab on user gesture
- `offscreen` — create offscreen document for MediaStream handling
