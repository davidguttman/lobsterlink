# Vipsee Install Prompt for OpenClaw

```text
You are on an OpenClaw host. Install and configure the unpacked Vipsee Chrome extension for the isolated OpenClaw-managed browser profile (`openclaw`), then verify it is really loaded.

Extension folder on disk:
<ABSOLUTE_PATH_TO_CLONED_VIPSEE_REPO>

Goal:
Load this unpacked extension into the isolated `openclaw` browser via config so it survives browser restarts and can be used later by the agent.

Requirements:
- Use the isolated `openclaw` profile, not the human's real browser.
- Configure extension loading through OpenClaw browser config, not manual one-off clicks.
- Preserve unrelated browser settings.
- Verify with evidence, do not assume.

What to inspect first:
1. Browser config schema for:
   - `browser`
   - `browser.extraArgs`
2. Current browser config.
3. Current browser plugin availability.

Config goals:
- `browser.defaultProfile = "openclaw"`
- `browser.headless = false`
- `browser.extraArgs` must include:
  - `--disable-extensions-except=<ABSOLUTE_PATH_TO_CLONED_VIPSEE_REPO>`
  - `--load-extension=<ABSOLUTE_PATH_TO_CLONED_VIPSEE_REPO>`

Example patch target:
{
  "browser": {
    "defaultProfile": "openclaw",
    "headless": false,
    "extraArgs": [
      "--disable-extensions-except=<ABSOLUTE_PATH_TO_CLONED_VIPSEE_REPO>",
      "--load-extension=<ABSOLUTE_PATH_TO_CLONED_VIPSEE_REPO>"
    ]
  }
}

Execution steps:
1. Inspect the current config schema and current config.
2. Patch config safely.
3. Restart OpenClaw if needed so browser launch args refresh.
4. Start the isolated browser profile.
5. Verify the live Chromium process includes:
   - `--user-data-dir=...openclaw...`
   - `--remote-debugging-port=...`
   - `--load-extension=<ABSOLUTE_PATH_TO_CLONED_VIPSEE_REPO>`
6. Verify the extension is actually loaded by checking at least one of:
   - isolated profile Preferences or extension settings
   - CDP `/json/list` extension service worker or page targets
7. Discover and report the extension ID.
8. Report the exact config fields changed.

Final answer must include:
- whether config was updated
- whether OpenClaw/browser was restarted
- extension ID
- extension source path
- proof that Chromium was launched with the extension flags
- proof that the extension is loaded in the isolated profile

Do the work, do not just describe it.
```
