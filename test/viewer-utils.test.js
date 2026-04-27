import { describe, it, expect } from 'vitest';
import { diffMobileKeyboardText, parseViewerArgs } from '../lib/viewer-utils.js';

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
