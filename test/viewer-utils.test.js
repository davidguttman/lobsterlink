import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  applyHostStoppedState,
  createMobilePasteForwardState,
  diffMobileKeyboardText,
  evaluateMobilePasteForward,
  evaluateMobilePasteTargetInput,
  evaluateMobilePasteTargetPaste,
  getHostStoppedMessage,
  getMobilePasteButtonState,
  parseViewerArgs,
  resetMobilePasteForwardState
} from '../lib/viewer-utils.js';
import * as hostedViewerUtils from '../client/lib/viewer-utils.js';

const viewerHtmlPaths = ['client/viewer/index.html', 'viewer.html'];

describe('diffMobileKeyboardText', () => {
  it('returns empty strings when nothing changed', () => {
    expect(diffMobileKeyboardText('hello', 'hello')).toEqual({
      removedText: '',
      insertedText: ''
    });
  });

  it('detects pure appends', () => {
    expect(diffMobileKeyboardText('hel', 'hello')).toEqual({
      removedText: '',
      insertedText: 'lo'
    });
  });

  it('detects pure deletions from the end', () => {
    expect(diffMobileKeyboardText('hello', 'hel')).toEqual({
      removedText: 'lo',
      insertedText: ''
    });
  });

  it('detects substitutions in the middle', () => {
    expect(diffMobileKeyboardText('abXYZcd', 'ab123cd')).toEqual({
      removedText: 'XYZ',
      insertedText: '123'
    });
  });

  it('detects a prefix insertion', () => {
    expect(diffMobileKeyboardText('world', 'hello world')).toEqual({
      removedText: '',
      insertedText: 'hello '
    });
  });

  it('handles transitions from empty to non-empty', () => {
    expect(diffMobileKeyboardText('', 'typed')).toEqual({
      removedText: '',
      insertedText: 'typed'
    });
  });

  it('handles transitions from non-empty to empty', () => {
    expect(diffMobileKeyboardText('typed', '')).toEqual({
      removedText: 'typed',
      insertedText: ''
    });
  });

  it('handles repeated characters around the edit site', () => {
    // Prefix match is "a"; shared suffix is "aa"; the remaining middle 'a'
    // is replaced by 'X'.
    expect(diffMobileKeyboardText('aaaa', 'aXaa')).toEqual({
      removedText: 'a',
      insertedText: 'X'
    });
  });
});

describe('parseViewerArgs', () => {
  it('reads host and debug args from the hash', () => {
    expect(parseViewerArgs('', '#host=abc123&debug=true')).toEqual({
      hostPeerId: 'abc123',
      debugEnabled: true
    });
  });

  it('prefers hash args over backward-compatible query args', () => {
    expect(parseViewerArgs('?host=query-host&debug=false', '#host=hash-host&debug=true')).toEqual({
      hostPeerId: 'hash-host',
      debugEnabled: true
    });
  });

  it('falls back to query args for old viewer links', () => {
    expect(parseViewerArgs('?host=legacy-host&debug=true', '')).toEqual({
      hostPeerId: 'legacy-host',
      debugEnabled: true
    });
  });

  it('accepts hash args that start with a question mark', () => {
    expect(parseViewerArgs('', '#?host=hash-query-host')).toEqual({
      hostPeerId: 'hash-query-host',
      debugEnabled: false
    });
  });
});


describe('host stopped viewer state', () => {
  it('uses timeout copy for timed-out shares', () => {
    expect(getHostStoppedMessage('timeout')).toBe('Share timed out. Ask the agent to start a new share.');
  });

  it('uses ended copy for manual and unknown stopped shares', () => {
    expect(getHostStoppedMessage('manual')).toBe('Share ended. Ask the agent to start a new share.');
    expect(getHostStoppedMessage('something-else')).toBe('Share ended. Ask the agent to start a new share.');
    expect(getHostStoppedMessage()).toBe('Share ended. Ask the agent to start a new share.');
  });

  it('suppresses reconnect intent and returns inactive-share UI state', () => {
    expect(applyHostStoppedState({
      connectedPeerId: 'host-peer',
      reconnectAttempts: 7,
      overlayHidden: true
    }, 'timeout')).toEqual({
      connectedPeerId: null,
      reconnectAttempts: 0,
      shouldClearReconnectTimer: true,
      shouldReconnect: false,
      overlayHidden: false,
      overlayMessage: 'Share timed out. Ask the agent to start a new share.',
      overlayError: '',
      statusText: 'Share timed out',
      statusClass: 'error'
    });
  });
});

describe('hosted viewer helper copy', () => {
  it('exports host-stopped helpers with behavior matching the extension viewer helpers', () => {
    expect(hostedViewerUtils.getHostStoppedMessage).toBeTypeOf('function');
    expect(hostedViewerUtils.applyHostStoppedState).toBeTypeOf('function');

    for (const reason of ['timeout', 'manual', undefined]) {
      expect(hostedViewerUtils.getHostStoppedMessage(reason)).toBe(getHostStoppedMessage(reason));
      expect(hostedViewerUtils.applyHostStoppedState({
        connectedPeerId: 'host-peer',
        reconnectAttempts: 3,
        overlayHidden: true
      }, reason)).toEqual(applyHostStoppedState({
        connectedPeerId: 'host-peer',
        reconnectAttempts: 3,
        overlayHidden: true
      }, reason));
    }
  });
});

describe('mobile paste forwarding', () => {
  it('disables the mobile paste button while disconnected', () => {
    expect(getMobilePasteButtonState(false)).toEqual({
      disabled: true,
      title: 'Connect to a remote browser before pasting'
    });
  });

  it('enables the mobile paste button while connected', () => {
    expect(getMobilePasteButtonState(true)).toEqual({
      disabled: false,
      title: 'Paste to remote'
    });
  });

  it('ignores empty text without creating a send action', () => {
    const result = evaluateMobilePasteForward(createMobilePasteForwardState(), '');

    expect(result.sendAction).toBeNull();
  });

  it('preserves exact paste text in the send action', () => {
    const pastedText = 'p@ss w0rd! $ymbols\nsecond line\t✓';
    const result = evaluateMobilePasteForward(createMobilePasteForwardState(), pastedText);

    expect(result.sendAction).toEqual({
      type: 'clipboard',
      action: 'pasteText',
      text: pastedText
    });
  });

  it('deduplicates paste and input double-fire for the same value', () => {
    const pastedText = 'same pasted value';
    let result = evaluateMobilePasteForward(createMobilePasteForwardState(), pastedText);

    expect(result.sendAction).toEqual({ type: 'clipboard', action: 'pasteText', text: pastedText });

    result = evaluateMobilePasteForward(result.state, pastedText);

    expect(result.sendAction).toBeNull();
  });

  it('allows different later values to send separately', () => {
    let result = evaluateMobilePasteForward(createMobilePasteForwardState(), 'first');

    expect(result.sendAction).toEqual({ type: 'clipboard', action: 'pasteText', text: 'first' });

    result = evaluateMobilePasteForward(result.state, 'second');

    expect(result.sendAction).toEqual({ type: 'clipboard', action: 'pasteText', text: 'second' });
  });

  it('allows the same value again after reset', () => {
    const pastedText = 'repeat after close';
    let result = evaluateMobilePasteForward(createMobilePasteForwardState(), pastedText);

    expect(result.sendAction).toEqual({ type: 'clipboard', action: 'pasteText', text: pastedText });

    const resetState = resetMobilePasteForwardState(result.state);
    result = evaluateMobilePasteForward(resetState, pastedText);

    expect(result.sendAction).toEqual({ type: 'clipboard', action: 'pasteText', text: pastedText });
  });


  it('input fallback clears duplicate non-empty local text even when nothing is sent', () => {
    const first = evaluateMobilePasteTargetInput(createMobilePasteForwardState(), 'password text', true);
    const duplicate = evaluateMobilePasteTargetInput(first.state, 'password text', true);

    expect(duplicate).toEqual({
      state: first.state,
      sendAction: null,
      shouldClearLocalText: true,
      shouldCloseSheet: false
    });
  });

  it('input fallback clears non-empty local text when disconnected without sending', () => {
    const result = evaluateMobilePasteTargetInput(createMobilePasteForwardState(), 'password text', false);

    expect(result).toEqual({
      state: createMobilePasteForwardState(),
      sendAction: null,
      shouldClearLocalText: true,
      shouldCloseSheet: false
    });
  });

  it('input fallback sends, clears, and closes non-empty text while connected', () => {
    const result = evaluateMobilePasteTargetInput(createMobilePasteForwardState(), 'password text', true);

    expect(result.sendAction).toEqual({ type: 'clipboard', action: 'pasteText', text: 'password text' });
    expect(result.shouldClearLocalText).toBe(true);
    expect(result.shouldCloseSheet).toBe(true);
    expect(result.state.lastForwardedPasteFingerprint).not.toBe('');
  });

  it('input fallback ignores empty text without clearing or closing', () => {
    const state = createMobilePasteForwardState();
    const result = evaluateMobilePasteTargetInput(state, '', true);

    expect(result).toEqual({
      state,
      sendAction: null,
      shouldClearLocalText: false,
      shouldCloseSheet: false
    });
  });

  it('prevents and clears any non-empty local paste even when disconnected', () => {
    const result = evaluateMobilePasteTargetPaste(createMobilePasteForwardState(), 'password text', false);

    expect(result).toEqual({
      state: createMobilePasteForwardState(),
      sendAction: null,
      shouldPreventDefault: true,
      shouldStopPropagation: true,
      shouldClearLocalText: true,
      shouldCloseSheet: false
    });
  });

  it('forwards, prevents, clears, and closes a non-empty paste while connected', () => {
    const result = evaluateMobilePasteTargetPaste(createMobilePasteForwardState(), 'password text', true);

    expect(result.sendAction).toEqual({ type: 'clipboard', action: 'pasteText', text: 'password text' });
    expect(result.shouldPreventDefault).toBe(true);
    expect(result.shouldStopPropagation).toBe(true);
    expect(result.shouldClearLocalText).toBe(true);
    expect(result.shouldCloseSheet).toBe(true);
    expect(result.state.lastForwardedPasteFingerprint).not.toBe('');
  });

  it('prevents and clears duplicate non-empty local pastes even when nothing is sent', () => {
    const first = evaluateMobilePasteTargetPaste(createMobilePasteForwardState(), 'password text', true);
    const duplicate = evaluateMobilePasteTargetPaste(first.state, 'password text', true);

    expect(duplicate).toEqual({
      state: first.state,
      sendAction: null,
      shouldPreventDefault: true,
      shouldStopPropagation: true,
      shouldClearLocalText: true,
      shouldCloseSheet: false
    });
  });
});

describe('mobile viewer controls', () => {
  it.each(viewerHtmlPaths)('%s exposes separate mobile keyboard and paste controls', (htmlPath) => {
    const html = readFileSync(htmlPath, 'utf8');

    expect(html).toContain('id="btn-mobile-keyboard"');
    expect(html).toContain('id="btn-mobile-paste"');
    expect(html).toContain('id="mobile-keyboard-input"');
    expect(html).toContain('id="mobile-paste-input"');
    expect(html).toMatch(/id="btn-mobile-keyboard"[^>]*aria-label="Open mobile keyboard"/);
    expect(html).toMatch(/id="btn-mobile-paste"[^>]*aria-label="Paste text to remote browser"/);
  });

  it('wires the mobile keyboard separately from the paste sheet', () => {
    const source = readFileSync('client/viewer.js', 'utf8');

    expect(source).toContain("document.getElementById('btn-mobile-keyboard')");
    expect(source).toContain("document.getElementById('mobile-keyboard-input')");
    expect(source).toContain("mobileKeyboardInput.addEventListener('beforeinput'");
    expect(source).toContain('diffMobileKeyboardText(previousText, nextText)');
    expect(source).toContain('openMobilePasteSheet()');
  });
});
