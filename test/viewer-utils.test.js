import { describe, it, expect } from 'vitest';
import { diffMobileKeyboardText } from '../lib/viewer-utils.js';

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
