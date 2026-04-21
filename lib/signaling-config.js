'use strict';

// LobsterLink signaling-config helper.
// Shared across the service worker (importScripts), the offscreen document,
// the bridge page, the options page, and the viewer client — plus Vitest.
// Defines normalization, URL-param round-tripping, and viewer URL building
// so host/viewer stay aligned when pointed at self-hosted infrastructure.

const DEFAULT_SIGNALING_CONFIG = {
  viewerUrlBase: 'https://lobsterl.ink/',
  peerJsHost: '0.peerjs.com',
  peerJsPort: 443,
  peerJsPath: '/',
  peerJsSecure: true
};

const SIGNALING_STORAGE_KEYS = Object.freeze([
  'viewerUrlBase',
  'peerJsHost',
  'peerJsPort',
  'peerJsPath',
  'peerJsSecure'
]);

function coerceString(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function coercePort(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.trunc(n);
  if (int < 1 || int > 65535) return fallback;
  return int;
}

function coerceBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

function coercePath(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  return trimmed.startsWith('/') ? trimmed : '/' + trimmed;
}

function coerceViewerUrlBase(value, fallback) {
  const str = coerceString(value, null);
  if (!str) return fallback;
  try {
    const parsed = new URL(str);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    return str;
  } catch (e) {
    return fallback;
  }
}

function normalizeSignalingConfig(input) {
  const src = input || {};
  return {
    viewerUrlBase: coerceViewerUrlBase(src.viewerUrlBase, DEFAULT_SIGNALING_CONFIG.viewerUrlBase),
    peerJsHost: coerceString(src.peerJsHost, DEFAULT_SIGNALING_CONFIG.peerJsHost),
    peerJsPort: coercePort(src.peerJsPort, DEFAULT_SIGNALING_CONFIG.peerJsPort),
    peerJsPath: coercePath(src.peerJsPath, DEFAULT_SIGNALING_CONFIG.peerJsPath),
    peerJsSecure: coerceBool(src.peerJsSecure, DEFAULT_SIGNALING_CONFIG.peerJsSecure)
  };
}

function ensureTrailingSlash(base) {
  if (!base) return base;
  return base.endsWith('/') ? base : base + '/';
}

function buildViewerUrl(peerId, inputConfig) {
  if (!peerId) return '';
  const config = normalizeSignalingConfig(inputConfig);
  let url;
  try {
    url = new URL(ensureTrailingSlash(config.viewerUrlBase));
  } catch (e) {
    url = new URL(DEFAULT_SIGNALING_CONFIG.viewerUrlBase);
  }
  url.searchParams.set('host', peerId);
  if (config.peerJsHost !== DEFAULT_SIGNALING_CONFIG.peerJsHost) {
    url.searchParams.set('peerJsHost', config.peerJsHost);
  }
  if (config.peerJsPort !== DEFAULT_SIGNALING_CONFIG.peerJsPort) {
    url.searchParams.set('peerJsPort', String(config.peerJsPort));
  }
  if (config.peerJsPath !== DEFAULT_SIGNALING_CONFIG.peerJsPath) {
    url.searchParams.set('peerJsPath', config.peerJsPath);
  }
  if (config.peerJsSecure !== DEFAULT_SIGNALING_CONFIG.peerJsSecure) {
    url.searchParams.set('peerJsSecure', config.peerJsSecure ? 'true' : 'false');
  }
  return url.toString();
}

function parseSignalingConfigFromParams(params) {
  if (!params || typeof params.get !== 'function') {
    return normalizeSignalingConfig({});
  }
  return normalizeSignalingConfig({
    peerJsHost: params.get('peerJsHost'),
    peerJsPort: params.get('peerJsPort'),
    peerJsPath: params.get('peerJsPath'),
    peerJsSecure: params.get('peerJsSecure')
  });
}

function peerJsOptionsFromConfig(inputConfig) {
  const config = normalizeSignalingConfig(inputConfig);
  return {
    host: config.peerJsHost,
    port: config.peerJsPort,
    path: config.peerJsPath,
    secure: config.peerJsSecure
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_SIGNALING_CONFIG,
    SIGNALING_STORAGE_KEYS,
    normalizeSignalingConfig,
    buildViewerUrl,
    parseSignalingConfigFromParams,
    peerJsOptionsFromConfig
  };
}
