---
name: lobsterlink-tab-share
description: Use when a human wants to share a logged-in tab from the isolated OpenClaw browser so the agent can work through LobsterLink in that authenticated session. Triggers include requests to share a tab, give a LobsterLink peer/share ID, use a logged-in tab, or host/stop hosting a tab through LobsterLink.
---

# LobsterLink Tab Share

Use this when LobsterLink is already loaded in the isolated `openclaw` browser profile and the human wants the agent to use or share an authenticated tab through LobsterLink.

If LobsterLink is not installed yet, follow the install instructions in this repo's `AGENT-INSTALL.md` first.

## Hard Rules

- Use the isolated `openclaw` browser profile, not the human `user` profile, unless explicitly asked otherwise.
- Prefer the bridge path, not the popup click path.
- Do not rely on popup `tabCapture` for agent automation. Chrome user gesture rules make that unreliable.
- Verify bridge state before claiming success.
- After hosting starts, the hosted tab MUST be the active tab in its window. This is required, not optional — CDP screencast stalls when the hosted tab is backgrounded and the viewer goes black. Re-focus it with **Show Hosted Tab** and do not leave it backgrounded before returning the link.

## Quick Flow

1. Confirm the extension is loaded.
2. Find the requested target tab.
3. Open `chrome-extension://<EXTENSION_ID>/bridge.html`.
4. Stop any old host.
5. Start hosting the requested tab through the bridge controls.
6. Verify:
   - bridge says `Hosting`
   - peer ID is populated
   - captured tab matches the request
   - capture mode is present
7. Re-focus the hosted tab so it is the active tab in its window. Confirm the bridge focus indicator reads `Active`, not `Needs Focus`. Do not return the link until this is true.
8. Return the peer ID and the public viewer link: `https://lobsterl.ink/?host=<PEER_ID>`

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
- A visible popup is not proof that hosting actually started.
- Return concrete evidence, not assumptions.
