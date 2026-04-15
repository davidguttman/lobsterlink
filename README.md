# Vipsee

## The pain

Agent-controlled browsers break exactly where things get useful.

The agent can open pages, click buttons, and fill forms, but it falls apart when the task depends on a browser session that already belongs to a human:

- a site is logged in in the human's browser, not the agent's
- the agent needs to see and use the real authenticated tab
- Chrome extension UI and `tabCapture` require user gestures
- remote control hacks freeze, blur, or lose the host tab
- browser automation tools often block `chrome-extension://` flows
- "just share the browser" usually means giving up reliability or control

That is the gap Vipsee is meant to close.

## The dream

A human keeps browsing normally in a real Chrome tab.

An agent can:
- see that exact tab
- interact with it remotely
- keep using the human's authenticated session
- switch tabs when needed
- stop sharing cleanly
- do all of this through a repeatable, automatable workflow

In other words: a browser tab becomes shareable infrastructure for agents.

## The fix

Vipsee is a Chrome extension for hosting and viewing live browser tabs over WebRTC.

It gives you two sides:
- **Host**: the browser that owns the real tab and session
- **Viewer**: the remote surface that sees the tab and sends control input back

And it gives you two capture paths:
- **tabCapture**: best fidelity, but requires a real human gesture
- **CDP screencast**: works programmatically, which is what makes agent workflows viable

The key idea is simple:

> when normal browser automation cannot use the authenticated tab directly, Vipsee lets the agent work through that tab instead of pretending to recreate it.

## Why this exists

Vipsee is built for the awkward middle ground between:
- normal browser automation, and
- full remote desktop

Browser automation is great when the agent can own the session.
Remote desktop is too blunt when the agent only needs one live tab.

Vipsee is the smaller, more precise primitive:
- host one tab
- preserve the real session
- drive it remotely
- keep the workflow scriptable

## Agent-first design

Vipsee is not just a human popup extension.

It includes a dedicated bridge page for automation:

```text
chrome-extension://<extension-id>/bridge.html
```

That bridge runs in extension context and is the preferred control surface for agent-managed browsers. It exposes:

- start host
- stop host
- current peer ID
- current hosted tab
- switch hosted tab
- launch/connect viewer
- viewport control
- diagnostics and last error

For direct programmatic control, the extension also supports runtime messages like:

```js
chrome.runtime.sendMessage({ action: 'startHostingCDP', tabId: 123 });
```

That starts the host in CDP screencast mode instead of popup-driven `tabCapture` mode.

## OpenClaw integration

This repo includes an OpenClaw-friendly prompt and skill:

- `openclaw/vipsee-tab-share/INSTALL-PROMPT.md`
- `openclaw/vipsee-tab-share/SKILL.md`

Intended OpenClaw flow:

1. Clone this repo on the OpenClaw host.
2. Use `INSTALL-PROMPT.md` once to patch `openclaw.json` so the isolated `openclaw` browser loads Vipsee as an unpacked extension.
3. Use the `vipsee-tab-share` skill for actual workflows like:
   - share the LinkedIn tab
   - give me the Vipsee peer ID
   - use my logged-in tab
   - stop sharing

The skill is designed around the reliable path:
- use the isolated OpenClaw browser profile
- open the bridge page
- start hosting through the runtime/CDP path
- verify hosting state
- return the peer ID
- re-focus the hosted tab

## Setup

1. Clone this repo.
2. Optional but useful during development, start the local dev runtime:

```bash
node scripts/dev-runtime.js
```

This starts:
- a local diagnostic log collector at `http://127.0.0.1:8787`
- automatic `manifest.json` version stamping on file changes

You can also run the pieces separately:

```bash
node scripts/log-server.js
node scripts/watch-version.js
```

3. Open `chrome://extensions` in Chrome.
4. Enable Developer mode.
5. Click **Load unpacked** and select this repo.
6. The Vipsee extension icon should appear in the toolbar.

## Basic usage

### Host

1. Open the tab you want to share.
2. Start hosting through the popup or bridge.
3. Get the generated peer ID.
4. Connect from the viewer.

### Viewer

1. Open the viewer.
2. Paste the peer ID.
3. Connect.
4. The remote tab video appears and input events are forwarded to the host.

## Requirements

- Chrome or Chromium
- headed browser for `tabCapture`
- internet connectivity for PeerJS signaling and WebRTC connectivity
- if running on a server, use a real display environment such as Xvfb

Example:

```bash
xvfb-run google-chrome --no-sandbox
```

## Troubleshooting

- **"Extension is debugging this tab" infobar**
  - Expected when `chrome.debugger` is attached.
  - Do not dismiss it while remote control is active.

- **Frozen or black host video**
  - In `tabCapture` mode, the host tab must stay active.
  - If the viewer lives in the same window, Chrome may background the host tab and freeze capture.

- **`chrome-extension://` navigation is blocked by automation tooling**
  - Open the bridge via CDP target creation instead of normal page navigation.

- **The popup exists but hosting is not actually running**
  - Check bridge/runtime state directly.
  - Do not treat popup visibility as proof.

- **No frames in screencast mode**
  - CDP screencast can stall on visually static pages.
  - Vipsee restarts screencast on viewer connect and uses frame ticking to keep output alive.

- **Connection fails**
  - Both sides must reach PeerJS signaling and successfully establish a WebRTC path.

## Local diagnostics

Run the log collector before reproducing debugger or focus issues:

```bash
node scripts/log-server.js
```

Vipsee posts JSON events to:

```text
http://127.0.0.1:8787/log
```

The server appends them to:

```text
logs/vipsee-debug.jsonl
```

Useful events include:
- `tab_activated`
- `tab_created`
- `switch_tab_requested`
- `debugger_attach_*`
- `debugger_detached_externally`
- `input_dropped_*`
- `host_guard_installed`

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## Architecture

```text
Host browser                        Viewer
┌──────────────────────────┐       ┌──────────────────────────┐
│ tabCapture / screencast  │       │ live video render        │
│ offscreen document       │──RTC─▶│ control surface          │
│ chrome.debugger input    │◀─RTC──│ mouse / keyboard / nav   │
│ chrome.tabs tab control  │◀─RTC──│ tab + viewport commands  │
└──────────────────────────┘       └──────────────────────────┘
```

## Permissions

- `tabCapture` — capture live tab video
- `tabs` — inspect and manage tabs
- `debugger` — inject input events and run screencast via CDP
- `activeTab` — access active tab on user gesture
- `offscreen` — handle media and rendering work offscreen
