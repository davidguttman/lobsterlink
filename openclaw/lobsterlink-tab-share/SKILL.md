---
name: lobsterlink-tab-share
description: Use when a human wants to share a logged-in tab from the isolated OpenClaw browser so the agent can work through LobsterLink in that authenticated session. Triggers include requests to share a tab, give a LobsterLink peer/share ID, use a logged-in tab, or host/stop hosting a tab through LobsterLink. Skip install/reinstall if INSTALLED is already marked true in this skill.
---

# LobsterLink Tab Share

Use this when LobsterLink is already loaded in the isolated `openclaw` browser profile and the human wants the agent to use or share an authenticated tab through LobsterLink.

If LobsterLink is not installed yet, follow the install instructions in this repo's `AGENT-INSTALL.md` first.

## Recorded Bridge URL

- `BRIDGE_URL = <RECORDED_BRIDGE_URL>`
- During install, replace `<RECORDED_BRIDGE_URL>` in the local/runtime copy of this skill with the full bridge URL, for example `chrome-extension://<extension-id>/bridge.html`.
- If this placeholder is still present, the install flow did not finish patching the skill. Discover the extension ID, update the skill, then continue.

## Installation Status

- `INSTALLED = true`
- Extension ID: <id>
- Install date: <YYYY-MM-DD>
- If `INSTALLED = true` and bridge URL is resolved, skip the install flow on future runs. Only reinstall if the extension is unloaded or the bridge URL is broken.

## Hard Rules

- Use the isolated `openclaw` browser profile, not the human `user` profile, unless explicitly asked otherwise.
- When using the OpenClaw `browser` tool for this workflow, target the isolated profile explicitly: `profile="openclaw"` (normally with `target="host"`). Do not use `profile="user"` for LobsterLink hosting or inspection unless the human explicitly asks for the human browser.
- Prefer the bridge path, not the popup click path.
- Verify bridge state before claiming success.
- After hosting starts, the hosted tab MUST be the active tab in its window. This is required, not optional — CDP screencast stalls when the hosted tab is backgrounded and the viewer goes black. `Start Host` auto-focuses the hosted tab; keep it frontmost and re-focus with **Show Hosted Tab** if it drops.
- The bridge page is the source of truth for the peer ID and viewer URL. Read them from the bridge's `Current Peer ID` and `Viewer URL` fields, not from any overlay on the hosted tab. Host state is persisted by the extension, so if `Start Host` leaves the bridge in the background you can reopen `BRIDGE_URL` — the fields will still show the current session.

## Quick Flow

1. Confirm the extension is loaded in the isolated browser, not the human browser.
2. If using the OpenClaw `browser` tool, use `profile="openclaw"` from the first call onward. Do not inspect LobsterLink tabs with `profile="user"` unless the human explicitly asked for that browser.
3. Confirm `BRIDGE_URL` above is a real `chrome-extension://.../bridge.html` URL, not the placeholder.
4. Find the requested target tab.
5. Open `BRIDGE_URL` from this skill.
6. Stop any old host.
7. Start hosting the requested tab through the bridge controls. The bridge auto-focuses the hosted tab, which may background the bridge — that is expected.
8. Read the peer ID and viewer URL from the bridge's `Current Peer ID` and `Viewer URL` fields. If the bridge is no longer frontmost, reopen `BRIDGE_URL`; host state persists and the fields will still be populated. Do not try to read the ID from an overlay on the hosted tab.
9. Verify:
   - bridge says `Hosting`
   - peer ID is populated
   - captured tab matches the request
   - capture mode is present
10. Keep the hosted tab active/frontmost. Confirm the bridge focus indicator reads `Active`, not `Needs Focus`. Do not return the link until this is true.
11. Return the peer ID and the public viewer link: `https://lobsterl.ink/?host=<PEER_ID>`

If the viewer is black, the first recovery step is to refocus the hosted tab so it is frontmost. Only investigate other causes after the focus indicator reads `Active`.

To stop sharing, click **Stop Host** on the bridge and verify hosting is false.

## Verification

Before replying, confirm all relevant items:

- extension loaded in isolated profile
- target tab exists
- bridge page opened
- host started or stopped successfully
- bridge/runtime state matches the requested outcome
- hosted tab is active/frontmost after start (bridge focus indicator reads `Active`)

## Notes

- Some browser tools block `chrome-extension://` navigation. If that happens, create the bridge target through CDP instead.
- `profile="user"` vs `profile="openclaw"` is a real failure mode in OpenClaw. If the observed tabs/state do not match expectations, first confirm you are attached to the isolated `openclaw` profile before debugging anything else.
- A visible popup is not proof that hosting actually started.
- Return concrete evidence, not assumptions.
