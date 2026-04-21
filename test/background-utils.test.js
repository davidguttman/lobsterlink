import { describe, it, expect } from 'vitest';
import { getCaptureSize } from '../lib/background-utils.js';

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
