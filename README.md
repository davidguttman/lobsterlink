# LobsterLink

Let a human complete blocked steps inside an agent's browser, without sharing credentials.

---

Your agent opens LinkedIn, hits a login wall, and stops. Or Twitter wants 2FA. Or Reddit throws a CAPTCHA. Or a bank site needs an identity check. Every agent workflow eventually hits a step that requires a real human — and the usual options are bad: hand over your password, stuff a cookie file, or babysit the agent.

LobsterLink does something smaller. The agent hosts its tab over WebRTC and hands you a link:

```text
https://lobsterl.ink/?host=abc123-long-uuid
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

LobsterLink installs into the agent's browser, not yours. You don't install anything locally.

Tell your agent:

```
Install LobsterLink by following the instructions at https://github.com/davidguttman/lobsterlink/blob/master/AGENT-INSTALL.md
```

That's the whole install step. The agent fetches the file, follows it, and reports back with an extension ID and proof of install. Works with OpenClaw out of the box; covers other runtimes too.

Once installed, ask your agent things like "share the LinkedIn tab" or "give me the viewer link." If you're on OpenClaw, the bundled `lobsterlink-tab-share` skill handles the rest. On other runtimes, the agent drives the bridge page directly — see [For agents](#for-agents) below.

## What you see when you click a link

You open `lobsterl.ink/?host=...` in a desktop browser — any browser, any OS. You see the agent's tab rendering live, and your mouse and keyboard drive it. You're not sharing your screen. The agent can't see your other tabs, your desktop, or anything else on your machine. When you close the tab, you're out.

Mobile and tablet work for viewing, but keyboard handling is rough right now — the on-screen keyboard doesn't reliably pop up when you'd expect. Use a laptop or desktop for anything involving typing.

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

The bridge page is the source of truth for the current host ID and viewer URL. Host state is persisted by the background worker, so if the bridge is no longer frontmost you can reopen `bridge.html` and the `Current Peer ID` and `Viewer URL` fields will still show the active session. Do not read the host ID off any host-tab overlay — treat the bridge fields as authoritative. Return `https://lobsterl.ink/?host=<id>` once the peer ID is visible on the bridge and the hosted tab is active.

If your automation tooling blocks `chrome-extension://` navigation, open the bridge via CDP target creation instead.

### Installing

Full install instructions for agents: [`AGENT-INSTALL.md`](./AGENT-INSTALL.md). Covers OpenClaw and other runtimes.

### OpenClaw skill

This repo ships with a skill at `openclaw/lobsterlink-tab-share/SKILL.md`. It opens the bridge, starts hosting through the bridge controls, verifies state, returns the peer ID and public viewer link, and re-focuses the hosted tab. Use it for workflows like "share the LinkedIn tab," "give me the viewer link," "use my logged-in tab," "stop sharing."

### Gotchas

- **Black viewer → hosted tab is not active.** CDP screencast only produces frames while the hosted tab is the active tab in its window. If the viewer shows a black frame, the first and only check is whether the hosted tab is frontmost — click **Show Hosted Tab** on the bridge (or use the `focusTab` control event) and keep it active. The bridge focus indicator reports `Active` vs `Needs Focus`; treat anything other than `Active` as a broken session.
- **Recovering the host ID after auto-focus.** `Start Host` brings the hosted tab to the front, which can leave the bridge in the background. The bridge page is still the source of truth — reopen `bridge.html` and read `Current Peer ID` / `Viewer URL` from the fields. State persists across bridge reopens. Do not scrape the ID from any host-page overlay.
- **`chrome-extension://` navigation blocked.** Open the bridge through CDP target creation, not `chrome.tabs.update`.

### Public web viewer

The `client/` directory is the standalone static viewer entrypoint that powers `lobsterl.ink`. `client/viewer.js` is the shared viewer logic used by both the extension and hosted client; see `client/README.md` for the file layout.
