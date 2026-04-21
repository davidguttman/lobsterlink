import { describe, it, expect } from 'vitest';
import { buildViewerUrl, pickDefaultSelectedTab } from '../lib/bridge-utils.js';

describe('buildViewerUrl', () => {
  it('returns empty string when no peerId is provided', () => {
    expect(buildViewerUrl('')).toBe('');
    expect(buildViewerUrl(null)).toBe('');
    expect(buildViewerUrl(undefined)).toBe('');
  });

  it('builds a viewer URL with the peer id as the host query param', () => {
    expect(buildViewerUrl('abc123')).toBe('https://lobsterl.ink/?host=abc123');
  });

  it('percent-encodes peer ids that contain reserved characters', () => {
    expect(buildViewerUrl('peer id/with+chars&more=')).toBe(
      'https://lobsterl.ink/?host=peer%20id%2Fwith%2Bchars%26more%3D'
    );
  });
});

describe('pickDefaultSelectedTab', () => {
  it('returns null when there are no tabs', () => {
    expect(pickDefaultSelectedTab({ tabs: [], status: null })).toBeNull();
    expect(pickDefaultSelectedTab({ tabs: [], status: {} })).toBeNull();
  });

  it('prefers the captured tab when it is present in the tabs list', () => {
    const state = {
      status: { capturedTabId: 42 },
      tabs: [
        { id: 10, active: false },
        { id: 42, active: false },
        { id: 77, active: true }
      ]
    };
    expect(pickDefaultSelectedTab(state)).toBe(42);
  });

  it('falls back to the active tab when the captured tab is not in the list', () => {
    const state = {
      status: { capturedTabId: 999 },
      tabs: [
        { id: 10, active: false },
        { id: 42, active: true },
        { id: 77, active: false }
      ]
    };
    expect(pickDefaultSelectedTab(state)).toBe(42);
  });

  it('falls back to the active tab when there is no captured tab', () => {
    const state = {
      status: {},
      tabs: [
        { id: 10, active: false },
        { id: 42, active: true }
      ]
    };
    expect(pickDefaultSelectedTab(state)).toBe(42);
  });

  it('falls back to the first tab when no tab is active', () => {
    const state = {
      status: {},
      tabs: [
        { id: 10, active: false },
        { id: 42, active: false }
      ]
    };
    expect(pickDefaultSelectedTab(state)).toBe(10);
  });

  it('tolerates a missing status object', () => {
    const state = {
      status: null,
      tabs: [
        { id: 10, active: true },
        { id: 42, active: false }
      ]
    };
    expect(pickDefaultSelectedTab(state)).toBe(10);
  });
});
