'use strict';

// LobsterLink background (service worker) pure helpers.
// Loaded via importScripts() in background.js, and via CommonJS in Vitest.

const SCREENCAST_MAX_WIDTH = 3840;
const SCREENCAST_MAX_HEIGHT = 2160;

function getCaptureSize(width, height, devicePixelRatio = 1) {
  if (!width || !height) {
    return {
      width: SCREENCAST_MAX_WIDTH,
      height: SCREENCAST_MAX_HEIGHT
    };
  }

  const scaleFactor = Math.max(1, Number(devicePixelRatio) || 1);
  const targetWidth = Math.max(1, Math.round(width * scaleFactor));
  const targetHeight = Math.max(1, Math.round(height * scaleFactor));

  const scale = Math.min(
    1,
    SCREENCAST_MAX_WIDTH / targetWidth,
    SCREENCAST_MAX_HEIGHT / targetHeight
  );

  return {
    width: Math.max(1, Math.round(targetWidth * scale)),
    height: Math.max(1, Math.round(targetHeight * scale))
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getCaptureSize,
    SCREENCAST_MAX_WIDTH,
    SCREENCAST_MAX_HEIGHT
  };
}
