import { describe, it, expect } from 'vitest';
import {
  buildViewerTabList,
  getCaptureSize,
  createSwitchSerializer,
  getOpenerAutoFollowDecision,
  getViewerTabListQueryInfo
} from '../lib/background-utils.js';

const MAX_W = 3840;
const MAX_H = 2160;

describe('getCaptureSize', () => {
  it('returns the max capture size when width or height is missing', () => {
    expect(getCaptureSize(0, 1080)).toEqual({ width: MAX_W, height: MAX_H });
    expect(getCaptureSize(1920, 0)).toEqual({ width: MAX_W, height: MAX_H });
    expect(getCaptureSize(undefined, undefined)).toEqual({ width: MAX_W, height: MAX_H });
  });

  it('returns the dpr-scaled size unchanged when it fits within the cap', () => {
    expect(getCaptureSize(1280, 720, 1)).toEqual({ width: 1280, height: 720 });
    expect(getCaptureSize(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
  });

  it('uses a dpr floor of 1 for sub-1 values', () => {
    expect(getCaptureSize(1280, 720, 0.5)).toEqual({ width: 1280, height: 720 });
  });

  it('scales down proportionally when the scaled size exceeds the cap', () => {
    const result = getCaptureSize(1920, 1080, 4);
    // scaled raw = 7680x4320. cap scale = min(3840/7680, 2160/4320) = 0.5
    expect(result).toEqual({ width: 3840, height: 2160 });
  });

  it('scales down based on the more restrictive axis', () => {
    const result = getCaptureSize(1000, 3000, 1);
    // 1000 x 3000 -> scale = min(3840/1000, 2160/3000) = 0.72
    expect(result).toEqual({ width: 720, height: 2160 });
  });

  it('never returns values smaller than 1', () => {
    const result = getCaptureSize(1, 1, 1);
    expect(result.width).toBeGreaterThanOrEqual(1);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });
});


describe('viewer tab list helpers', () => {
  it('queries all windows for viewer tab switcher candidates', () => {
    expect(getViewerTabListQueryInfo()).toEqual({});
  });

  it('includes capturable tabs from multiple windows and marks the captured tab active', () => {
    const tabs = [
      { id: 1, windowId: 10, title: 'Main', url: 'https://example.com', favIconUrl: 'https://example.com/favicon.ico' },
      { id: 2, windowId: 20, title: 'Amazon Auth', url: 'https://www.amazon.com/ap/signin' },
      { id: 3, windowId: 20, title: 'Settings', url: 'chrome://settings' }
    ];

    expect(buildViewerTabList(tabs, 2)).toEqual([
      {
        id: 1,
        title: 'Main',
        url: 'https://example.com',
        favIconUrl: 'https://example.com/favicon.ico',
        active: false
      },
      {
        id: 2,
        title: 'Amazon Auth',
        url: 'https://www.amazon.com/ap/signin',
        favIconUrl: '',
        active: true
      }
    ]);
  });
});


describe('switch serialization helpers', () => {
  it('serializes overlapping switches and revalidates stale opener auto-follow inside the switch boundary', async () => {
    const runSwitch = createSwitchSerializer();
    const events = [];
    const state = { capturedTabId: 7 };
    let releaseManual;
    let markManualStarted;
    const manualStarted = new Promise((resolve) => { markManualStarted = resolve; });

    const manualSwitch = runSwitch({
      beforeSwitch: () => {
        events.push('manual:guard');
        return true;
      },
      switchFn: async () => {
        events.push('manual:start');
        markManualStarted();
        await new Promise((resolve) => { releaseManual = resolve; });
        state.capturedTabId = 99;
        events.push('manual:done');
      }
    });

    const autoFollowSwitch = runSwitch({
      beforeSwitch: () => {
        events.push(`auto:guard:${state.capturedTabId}`);
        return state.capturedTabId === 7;
      },
      switchFn: async () => {
        events.push('auto:switched');
        state.capturedTabId = 42;
      }
    });

    await manualStarted;
    expect(events).toEqual(['manual:guard', 'manual:start']);

    releaseManual();

    await expect(manualSwitch).resolves.toBe(true);
    await expect(autoFollowSwitch).resolves.toBe(false);
    expect(state.capturedTabId).toBe(99);
    expect(events).toEqual([
      'manual:guard',
      'manual:start',
      'manual:done',
      'auto:guard:99'
    ]);
  });
});


describe('opener auto-follow helpers', () => {
  it('waits for an opener-created about:blank tab, then switches once it becomes capturable', () => {
    const pendingEntry = { tabId: 42, openerTabId: 7, attempts: 0 };

    expect(getOpenerAutoFollowDecision(
      { id: 42, openerTabId: 7, url: 'about:blank' },
      pendingEntry,
      { maxAttempts: 5 }
    )).toEqual({ action: 'wait', reason: 'transient-uncapturable' });

    expect(getOpenerAutoFollowDecision(
      { id: 42, openerTabId: 7, url: 'https://www.amazon.com/ap/signin' },
      { ...pendingEntry, attempts: 1 },
      { maxAttempts: 5 }
    )).toEqual({ action: 'switch', reason: 'capturable' });
  });

  it('cancels opener auto-follow for permanently forbidden tabs', () => {
    expect(getOpenerAutoFollowDecision(
      { id: 42, openerTabId: 7, url: 'chrome://settings' },
      { tabId: 42, openerTabId: 7, attempts: 0 },
      { maxAttempts: 5 }
    )).toEqual({ action: 'cancel', reason: 'forbidden' });
  });

  it('cancels opener auto-follow when capture has moved away from the opener', () => {
    expect(getOpenerAutoFollowDecision(
      { id: 42, openerTabId: 7, url: 'https://www.amazon.com/ap/signin' },
      { tabId: 42, openerTabId: 7, attempts: 0 },
      { capturedTabId: 99 }
    )).toEqual({ action: 'cancel', reason: 'opener-no-longer-captured' });
  });

  it('keeps delayed transient opener tabs pending beyond retry attempts until the max age', () => {
    const pendingEntry = {
      tabId: 42,
      openerTabId: 7,
      attempts: 9,
      createdAt: 1_000
    };

    expect(getOpenerAutoFollowDecision(
      { id: 42, openerTabId: 7, url: '', pendingUrl: 'https://www.amazon.com/ap/signin' },
      pendingEntry,
      { maxAttempts: 5, maxPendingAgeMs: 30_000, now: 10_000 }
    )).toEqual({ action: 'wait', reason: 'transient-uncapturable' });

    expect(getOpenerAutoFollowDecision(
      { id: 42, openerTabId: 7, url: 'https://www.amazon.com/ap/signin' },
      { ...pendingEntry, attempts: 10 },
      { maxAttempts: 5, maxPendingAgeMs: 30_000, now: 10_300 }
    )).toEqual({ action: 'switch', reason: 'capturable' });
  });

  it('cancels transient opener auto-follow after the bounded max age', () => {
    expect(getOpenerAutoFollowDecision(
      { id: 42, openerTabId: 7, url: '' },
      { tabId: 42, openerTabId: 7, attempts: 5, createdAt: 1_000 },
      { maxAttempts: 5, maxPendingAgeMs: 30_000, now: 31_001 }
    )).toEqual({ action: 'cancel', reason: 'max-age-exceeded' });
  });
});
