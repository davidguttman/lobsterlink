---
name: vipsee-tab-share
description: Use when a human wants to share a logged-in tab from the isolated OpenClaw browser so the agent can work through Vipsee in that authenticated session. Triggers include requests to share a tab, give a Vipsee peer/share ID, use a logged-in tab, or host/stop hosting a tab through Vipsee.
---

# Vipsee Tab Share

Use this when Vipsee is already loaded in the isolated `openclaw` browser profile and the human wants the agent to use or share an authenticated tab through Vipsee.

If Vipsee is not installed yet, use the bundled `INSTALL-PROMPT.md` first.

## Hard Rules

- Use the isolated `openclaw` browser profile, not the human `user` profile, unless explicitly asked otherwise.
- Prefer the bridge/runtime path, not the popup click path.
- Do not rely on popup `tabCapture` for agent automation. Chrome user gesture rules make that unreliable.
- Verify bridge state before claiming success.
- After hosting starts, switch back to the hosted target tab.

## Quick Flow

1. Confirm the extension is loaded.
2. Find the requested target tab.
3. Open `chrome-extension://<EXTENSION_ID>/bridge.html`.
4. Stop any old host.
5. Start hosting the requested tab through `startHostingCDP` or the bridge controls.
6. Verify:
   - bridge says `Hosting`
   - peer ID is populated
   - captured tab matches the request
   - capture mode is present
7. Re-focus the hosted tab.
8. Return the peer ID.

To stop sharing, call `stopHosting` and verify hosting is false.

## Verification

Before replying, confirm all relevant items:

- extension loaded in isolated profile
- target tab exists
- bridge page opened
- host started or stopped successfully
- bridge/runtime state matches the requested outcome
- target tab re-focused after start

## Notes

- Some browser tools block `chrome-extension://` navigation. If that happens, create the bridge target through CDP instead.
- A visible popup is not proof that hosting actually started.
- Return concrete evidence, not assumptions.
