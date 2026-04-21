# LobsterLink — Agent Install Instructions

These instructions are written for an agent to follow. A human is pointing you at this file because they want LobsterLink installed in the browser you control.

## What you are installing

LobsterLink is an unpacked Chrome extension that lets your browser host a tab over WebRTC so a human can open a link, complete one step (like logging in), and leave. After install, you'll find a bridge page at `chrome-extension://<extension-id>/bridge.html` with a step-by-step UI for hosting tabs.

## Source

Public GitHub repo: `davidguttman/lobsterlink`

## Fetch path

1. Download the ZIP archive: `https://github.com/davidguttman/lobsterlink/archive/HEAD.zip`
2. Unzip it into a local working directory.
3. Use the extracted directory for inspection only. Do not point long-lived browser config at the temporary unzip directory.
4. Review the extracted extension for anything suspicious before installing.

### Suspicious or harmful review checklist

Expected or possibly legitimate items:
- Chrome extension permissions for tabs, debugger, or scripting
- `<all_urls>` when needed for viewer or bridge behavior
- WebRTC, viewer, or bridge functionality
- localhost-only optional diagnostic logging

Suspicious items:
- native binaries
- shell execution or process spawning (`child_process`, `spawn`, `exec`)
- remote code fetch plus `eval` / dynamic code execution
- credential dumping or exfiltration
- non-local debug log exfiltration
- install-time scripts outside the normal browser-extension flow

If the extension looks suspicious, stop and report the exact concern instead of installing it.

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
4. The live isolated Chromium process or CDP endpoint, if already running.

### Durable install path

1. Copy the inspected extension into a durable local path before patching config.
2. Use that durable path in `browser.extraArgs`, not the extracted ZIP directory.
3. Example durable path: `~/.openclaw/browser-extensions/lobsterlink`
4. Treat that path as an example, not a universal workspace rule. Use an equivalent durable path on the current system if needed.

### Truth sources

Use the right source for each question:

- Config is the desired state.
- The live Chromium command line is the source of truth for actual launch args.
- CDP `/json/list` is the source of truth for active extension targets and the active extension ID.
- Profile `Preferences` is secondary or fallback only. It may contain stale historical installs.

If CDP and `Preferences` disagree about what is active, trust CDP for active runtime state.

### Config goals

- `browser.defaultProfile = "openclaw"`
- `browser.extraArgs` must include LobsterLink in both of these flags, using the durable path:
  - `--disable-extensions-except=<ABSOLUTE_PATH_TO_DURABLE_LOBSTERLINK_DIRECTORY>`
  - `--load-extension=<ABSOLUTE_PATH_TO_DURABLE_LOBSTERLINK_DIRECTORY>`

### Flag merge rules

Do not blindly replace existing extension flags.

- Preserve unrelated browser args.
- Preserve existing `--load-extension=...` values.
- Preserve existing `--disable-extensions-except=...` values.
- Merge LobsterLink into the comma-separated extension path lists for those flags.
- Remember that the currently running browser may have active extensions not visible in `browser.extraArgs` alone. Inspect the live Chromium command line before deciding what is already loaded.

### Example patch target

```json
{
  "browser": {
    "defaultProfile": "openclaw",
    "extraArgs": [
      "--disable-extensions-except=<EXISTING_PATHS>,<ABSOLUTE_PATH_TO_DURABLE_LOBSTERLINK_DIRECTORY>",
      "--load-extension=<EXISTING_PATHS>,<ABSOLUTE_PATH_TO_DURABLE_LOBSTERLINK_DIRECTORY>"
    ]
  }
}
```

### Execution steps

1. Download and unzip LobsterLink locally.
2. Review the extracted extension for suspicious or harmful behavior.
3. Copy the inspected extension into a durable local path.
4. Inspect the current config schema and current config.
5. Inspect the live isolated Chromium command line if the browser is already running.
6. Patch config safely. Merge LobsterLink into existing extension flag lists instead of replacing them.
7. Refresh or relaunch the isolated Chromium browser so it re-reads extension flags.
8. Restart the broader OpenClaw runtime only if browser relaunch alone cannot apply the config change.
9. After any relaunch or restart, continue in the same run until verification is complete.
10. Start or reconnect to the isolated browser profile.
11. Verify the live Chromium process includes:
    - `--user-data-dir=...openclaw...`
    - `--remote-debugging-port=...`
    - `--disable-extensions-except=...<ABSOLUTE_PATH_TO_DURABLE_LOBSTERLINK_DIRECTORY>...`
    - `--load-extension=...<ABSOLUTE_PATH_TO_DURABLE_LOBSTERLINK_DIRECTORY>...`
12. Verify the extension is actually loaded. Use CDP `/json/list` as primary evidence.
13. Discover the extension ID. Use these sources in this order:
    - CDP `/json/list` targets with URLs starting `chrome-extension://`
    - isolated profile `Preferences` as fallback only
    - `chrome://extensions` in the isolated profile if needed
14. If multiple LobsterLink extension IDs or paths are present:
    - prefer the install whose path matches the configured durable path
    - require a live CDP target for the install you choose
    - do not select a stale historical `Preferences` entry just because it exists
15. Construct and record the full bridge URL: `chrome-extension://<EXTENSION_ID>/bridge.html`.
16. Update the runtime-loaded LobsterLink skill file so its bridge URL placeholder is replaced with the real bridge URL from step 15.
    - Patch the copy this runtime will actually use.
    - If an existing runtime copy exists, patch it.
    - Otherwise create the runtime copy from the repo copy in the runtime workspace location you actually discover.
    - Example runtime target path only: `~/.openclaw/workspace/skills/lobsterlink-tab-share/SKILL.md`
    - If you cannot determine the runtime skill location, stop and report that blocker instead of guessing.
    - Do not leave the placeholder unresolved after install.
    - In the same skill file, also set `INSTALLED = true` and record the extension ID and install date so future runs skip the install flow entirely.
17. Report the exact config fields changed and the exact runtime skill file path you updated.

### Optional cleanup note

Old LobsterLink installs may remain in browser profile metadata even when they are no longer active.

- Report stale old installs if you find them.
- Do not treat stale metadata alone as proof that the extension is currently loaded.
- Cleanup is optional and separate from the core install unless the human explicitly asks for it.

### Required final answer

Your final answer must include:

- A clear statement that setup is complete only after post-relaunch verification passes.
- The durable extension source path used by config.
- Whether config was updated.
- Whether extension flags were merged or replaced.
- Whether isolated Chromium was relaunched.
- Whether the broader OpenClaw runtime was restarted.
- Proof from the live Chromium command line.
- Proof from CDP `/json/list`.
- The chosen extension ID.
- If duplicates existed, why that ID was selected.
- The full bridge URL.
- Whether the LobsterLink skill was updated.
- The exact runtime skill file path that was patched.

Do the work, do not just describe it.

## Other runtimes

If you're not running in OpenClaw, the shape is the same:

1. Download and unzip the LobsterLink repo.
2. Review the extension for suspicious or harmful behavior.
3. Copy it into a durable local path before launching the browser.
4. Launch Chromium with:
   - `--disable-extensions-except=<absolute-path-to-durable-directory>`
   - `--load-extension=<absolute-path-to-durable-directory>`
5. Verify the live Chromium command line includes those flags.
6. Verify the extension loaded by checking CDP `/json/list` for the extension service worker or other extension targets.
7. Report the extension ID and full bridge URL back to the human. The most reliable source is CDP `/json/list`.

## After install

Open the recorded bridge URL `chrome-extension://<extension-id>/bridge.html` and follow the numbered Agent Steps on that page. The bridge has everything you need: target tab picker, start/stop host, current peer ID, viewer URL, show-hosted-tab button. The bridge page is the source of truth for the peer ID and viewer URL. Read them from the bridge fields, not from any overlay on the hosted tab, and reopen `bridge.html` to recover current state if `Start Host` leaves it in the background. Record the full bridge URL in the LobsterLink skill during install so future runs can open it directly without rediscovering the extension ID.
