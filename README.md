# LobsterLink

Let a human complete blocked steps inside an agent's browser, without sharing credentials.

---

Your agent opens LinkedIn, hits a login wall, and stops. Or Twitter wants 2FA. Or Reddit throws a CAPTCHA. Or a bank site needs an identity check. Every agent workflow eventually hits a step that requires a real human — and the usual options are bad: hand over your password, stuff a cookie file, or babysit the agent.

LobsterLink does something smaller. The agent hosts its tab over WebRTC and hands you a link:

```text
https://lobsterl.ink/#host=abc123-long-uuid
```

You open it. You see the agent's tab, live, in any browser. You do the step. You close the tab. The agent keeps the authenticated session and goes back to work.

No credentials shared. No extension installed on your machine. No remote desktop. Just one tab, just the blocked step, then you're out.

## Is this for you

**Yes, if:**
- You run agents that need to browse authenticated sites you control.
- You've hit the "OK but how does it log in" wall and don't love the answers.
- You use OpenClaw, or any agent runtime that can load a Chrome extension.

**Not yet, if:**
- Your agent doesn't control its own browser. LobsterLink installs on the agent side, not yours.

## Getting started

The extension runs in the browser that hosts the tab. The person who opens a viewer link does not install anything.

### Have an agent install it

Tell your agent:

```
Install LobsterLink by following the instructions at https://github.com/davidguttman/lobsterlink/blob/master/AGENT-INSTALL.md. Before installing, check the downloaded files for anything suspicious or harmful. If you’re not confident it looks safe, stop and ask. When you’re finished, give me a plain English summary of what you did.
```

The agent fetches the file, follows it, and reports back with an extension ID and proof of install. Works with OpenClaw out of the box; covers other runtimes too.

Once installed, ask your agent things like "share the LinkedIn tab" or "give me the viewer link." If you're on OpenClaw, the bundled `lobsterlink-tab-share` skill handles the rest. On other runtimes, the agent drives the bridge page directly — see [For agents](#for-agents) below.

### Install it yourself

1. Clone or unzip this repo. The extension root is the directory that contains `manifest.json` (the repository root, not a subdirectory).
2. Open Chromium, Chrome for Testing, or Google Chrome.
3. Go to `chrome://extensions`.
4. Turn on **Developer mode**.
5. Click **Load unpacked** and select that directory. The card is named LobsterLink. Developer mode shows its extension ID on the card.
6. Open the bridge. Click the LobsterLink toolbar button and choose **Open Bridge**, or open `chrome-extension://<extension-id>/bridge.html` in that same browser.

Branded Google Chrome can load the extension from `chrome://extensions`. It will not load it from `--load-extension`.

### Launch from the command line

`--load-extension` and `--disable-extensions-except` work in Chromium and in Chrome for Testing. Branded Google Chrome 137 and later ignores both. The process logs `--load-extension is not allowed in Google Chrome, ignoring.` and the extension never appears. Use Chromium or Chrome for Testing for a flag-based launch. Playwright's bundled Chromium accepts the flags. The `google-chrome` binary does not.

```bash
chromium \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/lobsterlink-profile \
  --disable-extensions-except=/absolute/path/to/lobsterlink \
  --load-extension=/absolute/path/to/lobsterlink
```

`/absolute/path/to/lobsterlink` is the directory that contains `manifest.json`.

### Find the LobsterLink extension ID

`GET http://127.0.0.1:9222/json/list` lists every inspectable target. With other extensions loaded, several URLs start with `chrome-extension://`. The target title is not the extension name, so the id is not obvious from the list alone.

LobsterLink's service worker is `background.js` (see `manifest.json`). Find the `service_worker` target whose URL is:

```text
chrome-extension://<extension-id>/background.js
```

The host of that URL is the extension ID. The title is `Service Worker chrome-extension://<extension-id>/background.js`.

Two things that list will not do for you:

- Other extensions can also register `background.js`, including component extensions that ship inside Chrome for Testing. When more than one `background.js` worker is listed, attach to each worker and evaluate `chrome.runtime.getManifest().name`. Keep the id that returns `LobsterLink`.
- A Manifest V3 service worker is left out of `/json/list` while it is idle. It is present right after a `--load-extension` launch. Opening the bridge wakes it.

Opening `chrome-extension://<candidate-id>/bridge.html` is the direct check. The loaded page title is `LobsterLink Bridge` only for this extension.

Profile `Preferences` is a fallback. For an unpacked install, `extensions.settings[<id>].path` is the directory you loaded. That file does not always store the manifest name.

### Open the bridge when chrome-extension navigation is blocked

A GET to `/json/new?chrome-extension://<extension-id>/bridge.html` does not open the bridge. Current Chromium responds HTTP 405 with `Using unsafe HTTP verb GET to invoke /json/new. This action supports only PUT verb.` Plain `curl` sends GET.

```bash
curl -X PUT "http://127.0.0.1:9222/json/new?chrome-extension://<extension-id>/bridge.html"
```

Do not pass the address as a `url=` query parameter (`/json/new?url=...`). That call returns a target left on `about:blank`.

The PUT response shows the bridge URL and an empty title. Shortly after, `/json/list` shows that target with title `LobsterLink Bridge`.

Playwright reaches the same page with a normal navigation:

```js
const page = await context.newPage();
await page.goto(`chrome-extension://${extensionId}/bridge.html`);
```

From the browser CDP session:

```js
await client.send('Target.createTarget', {
  url: `chrome-extension://${extensionId}/bridge.html`,
});
```

## What you see when you click a link

You open `lobsterl.ink/#host=...` in a desktop browser — any browser, any OS. You see the agent's tab rendering live, and your mouse and keyboard drive it. You're not sharing your screen. The agent can't see your other tabs, your desktop, or anything else on your machine. When you close the tab, you're out.

Mobile and tablet work for viewing, but keyboard handling is rough right now — the on-screen keyboard doesn't reliably pop up when you'd expect. Use a laptop or desktop for anything involving typing.

## Share lifetime

A host lasts 15 minutes from the moment hosting starts. While the share is active, the bridge status pill counts down, for example `Hosting — expires in 14:32`, or `Viewer connected — expires in 14:32` once someone connects. The popup shows the same countdown. At the deadline the extension stops the share the same way as **Stop Host**. The viewer then says `Share timed out. Ask the agent to start a new share.` Start Host again for a new link. There is no setting to change the 15 minutes.

---

## For agents

LobsterLink is a Chrome extension that hosts a browser tab over WebRTC and exposes a bridge page for programmatic control. The human-facing viewer lives at `lobsterl.ink`.

### Architecture

```text
Agent browser (Host)                   Human (Viewer)
┌──────────────────────────┐          ┌──────────────────────────┐
│ CDP screencast           │          │ live video render        │
│ offscreen document       │──RTC───▶ │ control surface          │
│ chrome.debugger input    │ ◀─RTC─── │ mouse / keyboard / nav   │
│ chrome.tabs tab control  │ ◀─RTC─── │ tab + viewport commands  │
└──────────────────────────┘          └──────────────────────────┘
```

### Usage

Open the bridge page: `chrome-extension://<extension-id>/bridge.html`.

The bridge is a regular HTML page running in extension context. It has a numbered step list written for agents, with live status indicators next to each step — pick the target tab, start hosting, read the peer ID and viewer URL from the bridge fields, then keep the hosted tab active. `Start Host` auto-focuses the hosted tab; the focus step is required, not optional, because CDP screencast stalls when the hosted tab is backgrounded, so the focus indicator reports `Active` vs `Needs Focus` and must be `Active` for the duration of the session.

The bridge page is the source of truth for the current host ID and viewer URL. Host state is persisted by the background worker, so if the bridge is no longer frontmost you can reopen `bridge.html` and the `Current Peer ID` and `Viewer URL` fields will still show the active session. Do not read the host ID off any host-tab overlay — treat the bridge fields as authoritative. Return `https://lobsterl.ink/#host=<id>` once the peer ID is visible on the bridge and the hosted tab is active.

If your automation tooling blocks `chrome-extension://` navigation, open the bridge with `PUT /json/new?chrome-extension://<extension-id>/bridge.html` on the DevTools port. GET is rejected. The exact command, and the Playwright equivalent, are in [Open the bridge when chrome-extension navigation is blocked](#open-the-bridge-when-chrome-extension-navigation-is-blocked).

### Installing

Full install instructions for agents: [`AGENT-INSTALL.md`](./AGENT-INSTALL.md). Covers OpenClaw and other runtimes.

### OpenClaw skill

This repo ships with a skill at `openclaw/lobsterlink-tab-share/SKILL.md`. It opens the bridge, starts hosting through the bridge controls, verifies state, returns the peer ID and public viewer link, and re-focuses the hosted tab. Use it for workflows like "share the LinkedIn tab," "give me the viewer link," "use my logged-in tab," "stop sharing."

### Gotchas

- **Black viewer → hosted tab is not active.** CDP screencast only produces frames while the hosted tab is the active tab in its window. If the viewer shows a black frame, the first and only check is whether the hosted tab is frontmost — click **Show Hosted Tab** on the bridge (or use the `focusTab` control event) and keep it active. The bridge focus indicator reports `Active` vs `Needs Focus`; treat anything other than `Active` as a broken session.
- **Recovering the host ID after auto-focus.** `Start Host` brings the hosted tab to the front, which can leave the bridge in the background. The bridge page is still the source of truth — reopen `bridge.html` and read `Current Peer ID` / `Viewer URL` from the fields. State persists across bridge reopens. Do not scrape the ID from any host-page overlay.
- **`chrome-extension://` navigation blocked.** Open the bridge with `curl -X PUT "http://127.0.0.1:9222/json/new?chrome-extension://<extension-id>/bridge.html"`. GET returns HTTP 405. Do not use `chrome.tabs.update`, and do not pass the URL as a `url=` query parameter.
- **Shares expire after 15 minutes.** The bridge status pill counts down (`Hosting — expires in mm:ss`). At zero the host stops and the viewer says the share timed out. Start Host again for a new peer ID.

### Public web viewer

The `client/` directory is the standalone static viewer entrypoint that powers `lobsterl.ink`. `client/viewer.js` is the shared viewer logic used by both the extension and hosted client; see `client/README.md` for the file layout.

## Development

```bash
npm install
npm run test:run
```

`npm run dev` serves the static viewer in `client/`.

Dev and tests require Node.js `^18.0.0 || >=20.0.0`, the range Vitest 1.6 declares and the range set in `package.json` `engines`. That is Node 18, or Node 20 and newer. Node 19 is outside the range.
