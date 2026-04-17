# LobsterLink — Agent Install Instructions

These instructions are written for an agent to follow. A human is pointing you at this file because they want LobsterLink installed in the browser you control.

## What you are installing

LobsterLink is an unpacked Chrome extension that lets your browser host a tab over WebRTC so a human can open a link, complete one step (like logging in), and leave. After install, you'll find a bridge page at `chrome-extension://<extension-id>/bridge.html` with a step-by-step UI for hosting tabs.

## Source

Public GitHub repo: `davidguttman/lobsterlink`

## Fetch path

1. Download the ZIP archive: `https://github.com/davidguttman/lobsterlink/archive/HEAD.zip`
2. Unzip it into a local working directory.
3. Find the extracted top-level LobsterLink directory and use its absolute path as the extension source path.

## OpenClaw install

If you're running inside OpenClaw, the goal is to load this unpacked extension into the isolated `openclaw` browser via config so it survives browser restarts and can be used later.

### Requirements

- Use the isolated `openclaw` profile.
- Configure extension loading through OpenClaw browser config, not manual one-off clicks.
- Preserve unrelated browser settings.
- Verify with evidence, do not assume.

### What to inspect first

1. Browser config schema for:
   - `browser`
   - `browser.extraArgs`
2. Current browser config.
3. Current browser plugin availability.

### Config goals

- `browser.defaultProfile = "openclaw"`
- `browser.extraArgs` must include:
  - `--disable-extensions-except=<ABSOLUTE_PATH_TO_EXTRACTED_LOBSTERLINK_DIRECTORY>`
  - `--load-extension=<ABSOLUTE_PATH_TO_EXTRACTED_LOBSTERLINK_DIRECTORY>`

### Example patch target

```json
{
  "browser": {
    "defaultProfile": "openclaw",
    "extraArgs": [
      "--disable-extensions-except=<ABSOLUTE_PATH_TO_EXTRACTED_LOBSTERLINK_DIRECTORY>",
      "--load-extension=<ABSOLUTE_PATH_TO_EXTRACTED_LOBSTERLINK_DIRECTORY>"
    ]
  }
}
```

### Execution steps

1. Download and unzip LobsterLink locally.
2. Inspect the current config schema and current config.
3. Patch config safely.
4. Restart OpenClaw if needed so browser launch args refresh.
5. After any restart, continue the work in the same run until verification is complete.
6. Start the isolated browser profile.
7. Verify the live Chromium process includes:
   - `--user-data-dir=...openclaw...`
   - `--remote-debugging-port=...`
   - `--disable-extensions-except=<ABSOLUTE_PATH_TO_EXTRACTED_LOBSTERLINK_DIRECTORY>`
   - `--load-extension=<ABSOLUTE_PATH_TO_EXTRACTED_LOBSTERLINK_DIRECTORY>`
8. Verify the extension is actually loaded by checking at least one of:
   - isolated profile Preferences or extension settings
   - CDP `/json/list` extension service worker or page targets
9. Discover the extension ID. Options, in order of reliability:
   - Query CDP `/json/list` for targets with URLs starting `chrome-extension://` and read the ID from the URL.
   - Read the isolated profile's `Preferences` file (`<user-data-dir>/Default/Preferences`) and find the LobsterLink entry under `extensions.settings`; the key is the ID.
   - Open `chrome://extensions` in the isolated profile with Developer mode enabled and read the ID from the LobsterLink card.
10. Construct and note the full bridge URL: `chrome-extension://<EXTENSION_ID>/bridge.html`.
11. Update the local LobsterLink skill file used by this runtime so its bridge URL placeholder is replaced with the real bridge URL from step 10.
    - If both a repo copy and an installed/runtime copy exist, update the runtime copy that the agent will actually load.
    - Do not leave the placeholder unresolved after install.
    - In the same skill file, also set `INSTALLED = true` and record the extension ID and install date so future runs skip the install flow entirely.
12. Report the exact config fields changed and the exact skill file path you updated.

### Required final answer

Your final answer must include:

- A clear statement that setup is complete only after the post-restart verification passes.
- Extension source path.
- Whether config was updated.
- Whether OpenClaw/browser was restarted.
- Extension ID.
- Bridge URL.
- Proof that Chromium was launched with the extension flags.
- Proof that the extension is loaded in the isolated profile.
- Whether the LobsterLink skill was updated, and which file/path was patched.

Do the work, do not just describe it.

## Other runtimes

If you're not running in OpenClaw, the shape is the same:

1. Download and unzip the LobsterLink repo.
2. Launch Chromium with:
   - `--disable-extensions-except=<absolute-path-to-extracted-directory>`
   - `--load-extension=<absolute-path-to-extracted-directory>`
3. Verify the extension loaded by checking CDP `/json/list` for the extension service worker target.
4. Report the extension ID and full bridge URL back to the human. The most reliable source is CDP `/json/list` — look for targets with URLs starting `chrome-extension://` and read the ID from the URL.

## After install

Open the recorded bridge URL `chrome-extension://<extension-id>/bridge.html` and follow the numbered Agent Steps on that page. The bridge has everything you need: target tab picker, start/stop host, current peer ID, show-hosted-tab button. Record that full URL in the LobsterLink skill during install so future runs can open it directly without rediscovering the extension ID.
