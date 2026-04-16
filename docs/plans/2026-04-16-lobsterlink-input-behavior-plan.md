# LobsterLink input behavior plan

_2026-04-16_

## Scope

This plan covers the non-viewport input issues for the agent pathway:
- focused-element awareness
- host-to-viewer focus metadata
- Enter / submit behavior
- verification

It does not cover viewport resizing itself.

## Goals

- Make the viewer aware of what the host currently has focused.
- Make Enter behavior match normal browser behavior for native form controls.
- Stop treating every `contenteditable` or multiline target as the same thing.
- Keep the decision point on the host, where the real focused element and form context exist.

## Plan

### 1. Add focused-element descriptors on the host

Have `host-agent.js` derive a compact descriptor from the current effective keyboard target and send it upstream when focus changes.

Descriptor fields:
- `tagName`
- `inputType`
- `isContentEditable`
- `hasForm`
- `isTextControl`
- `isMultiline`
- `role`
- `ariaMultiline`
- `enterBehavior` as a coarse classification: `submit`, `newline`, or `app-handled`

This should be based on the same target selection logic already used for keyboard handling so the reported state and actual behavior stay aligned.

### 2. Sync host focus metadata to the viewer

Route the descriptor through `background.js` to the viewer over the existing data channel.

Viewer behavior:
- store latest focus metadata
- expose it in the debug panel
- optionally surface a tiny status hint later, but start with debug only

This gives us observability first without changing visible UI too much.

### 3. Tighten Enter behavior for native controls

Keep native browser semantics as the baseline:
- single-line `<input>` targets should submit through `requestSubmit()` when appropriate
- `<textarea>` should keep newline behavior
- `form.submit()` should not be the primary path because it skips normal submit behavior

`triggerFormSubmit()` should prefer the true submit flow and only fall back when there is no better native path.

### 4. Add conservative heuristics for rich editors

For `contenteditable` and similar custom inputs, do not globally map Enter to newline.

Start with conservative host-side classification:
- likely multiline editor -> newline
- likely chat/composer -> submit on Enter, newline on Shift+Enter
- unknown -> preserve current safe behavior until proven otherwise

Signals can include:
- `aria-multiline`
- `role="textbox"`
- presence of a form
- known composer-like structure near the focused element

Keep this heuristic narrow at first. We want fewer obvious misfires, not magic.

## Verification matrix

Test these cases after implementation:
- normal single-line `<input>` inside a form
- `<textarea>` inside a form
- custom `contenteditable` chat composer
- true multiline rich editor
- desktop typing path
- mobile keyboard bridge path

For each case verify:
- what the host reports as focused
- whether Enter submits or inserts newline
- whether Shift+Enter preserves newline where expected
