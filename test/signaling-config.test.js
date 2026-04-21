import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SIGNALING_CONFIG,
  SIGNALING_STORAGE_KEYS,
  normalizeSignalingConfig,
  buildViewerUrl,
  parseSignalingConfigFromParams,
  peerJsOptionsFromConfig
} from '../lib/signaling-config.js';

describe('DEFAULT_SIGNALING_CONFIG', () => {
  it('has the documented default values', () => {
    expect(DEFAULT_SIGNALING_CONFIG).toEqual({
      viewerUrlBase: 'https://lobsterl.ink/',
      peerJsHost: '0.peerjs.com',
      peerJsPort: 443,
      peerJsPath: '/',
      peerJsSecure: true
    });
  });

  it('exports every default key in SIGNALING_STORAGE_KEYS', () => {
    expect([...SIGNALING_STORAGE_KEYS].sort()).toEqual(
      Object.keys(DEFAULT_SIGNALING_CONFIG).sort()
    );
  });
});

describe('normalizeSignalingConfig', () => {
  it('returns defaults for undefined/null/empty input', () => {
    expect(normalizeSignalingConfig()).toEqual(DEFAULT_SIGNALING_CONFIG);
    expect(normalizeSignalingConfig(null)).toEqual(DEFAULT_SIGNALING_CONFIG);
    expect(normalizeSignalingConfig({})).toEqual(DEFAULT_SIGNALING_CONFIG);
  });

  it('trims string fields and rejects empty strings', () => {
    const result = normalizeSignalingConfig({
      viewerUrlBase: '  https://vier:9000/  ',
      peerJsHost: ' vier ',
      peerJsPath: '   '
    });
    expect(result.viewerUrlBase).toBe('https://vier:9000/');
    expect(result.peerJsHost).toBe('vier');
    expect(result.peerJsPath).toBe('/');
  });

  it('rejects non-http(s) viewerUrlBase and falls back to default', () => {
    expect(normalizeSignalingConfig({ viewerUrlBase: 'ftp://example.com/' }).viewerUrlBase)
      .toBe(DEFAULT_SIGNALING_CONFIG.viewerUrlBase);
    expect(normalizeSignalingConfig({ viewerUrlBase: 'not a url' }).viewerUrlBase)
      .toBe(DEFAULT_SIGNALING_CONFIG.viewerUrlBase);
  });

  it('coerces port strings to integers and rejects out-of-range', () => {
    expect(normalizeSignalingConfig({ peerJsPort: '9001' }).peerJsPort).toBe(9001);
    expect(normalizeSignalingConfig({ peerJsPort: 0 }).peerJsPort).toBe(443);
    expect(normalizeSignalingConfig({ peerJsPort: 70000 }).peerJsPort).toBe(443);
    expect(normalizeSignalingConfig({ peerJsPort: 'nope' }).peerJsPort).toBe(443);
  });

  it('normalizes peerJsPath to start with a slash', () => {
    expect(normalizeSignalingConfig({ peerJsPath: 'myapp' }).peerJsPath).toBe('/myapp');
    expect(normalizeSignalingConfig({ peerJsPath: '/myapp/' }).peerJsPath).toBe('/myapp/');
  });

  it('coerces peerJsSecure from various truthy/falsy representations', () => {
    expect(normalizeSignalingConfig({ peerJsSecure: 'false' }).peerJsSecure).toBe(false);
    expect(normalizeSignalingConfig({ peerJsSecure: 'true' }).peerJsSecure).toBe(true);
    expect(normalizeSignalingConfig({ peerJsSecure: false }).peerJsSecure).toBe(false);
    expect(normalizeSignalingConfig({ peerJsSecure: '0' }).peerJsSecure).toBe(false);
    expect(normalizeSignalingConfig({ peerJsSecure: 'gibberish' }).peerJsSecure).toBe(true);
  });
});

describe('buildViewerUrl', () => {
  it('returns empty string when no peerId is provided', () => {
    expect(buildViewerUrl('')).toBe('');
    expect(buildViewerUrl(null)).toBe('');
    expect(buildViewerUrl(undefined)).toBe('');
  });

  it('uses defaults when no config is given', () => {
    expect(buildViewerUrl('abc123')).toBe('https://lobsterl.ink/?host=abc123');
  });

  it('omits signaling params when they match defaults (clean URLs)', () => {
    expect(buildViewerUrl('abc123', DEFAULT_SIGNALING_CONFIG))
      .toBe('https://lobsterl.ink/?host=abc123');
  });

  it('includes only the signaling params that differ from defaults', () => {
    const url = buildViewerUrl('abc', {
      viewerUrlBase: 'http://vier:9000/',
      peerJsHost: 'vier',
      peerJsPort: 9001,
      peerJsPath: '/',
      peerJsSecure: false
    });
    expect(url).toBe(
      'http://vier:9000/?host=abc&peerJsHost=vier&peerJsPort=9001&peerJsSecure=false'
    );
  });

  it('adds a trailing slash to a bare viewerUrlBase', () => {
    const url = buildViewerUrl('abc', { viewerUrlBase: 'http://vier:9000' });
    expect(url.startsWith('http://vier:9000/?host=abc')).toBe(true);
  });

  it('preserves a path on viewerUrlBase', () => {
    const url = buildViewerUrl('abc', { viewerUrlBase: 'https://example.com/ll/' });
    expect(url.startsWith('https://example.com/ll/?host=abc')).toBe(true);
  });

  it('falls back to the default viewerUrlBase when input is invalid', () => {
    const url = buildViewerUrl('abc', { viewerUrlBase: 'ftp://bad/' });
    expect(url).toBe('https://lobsterl.ink/?host=abc');
  });
});

describe('parseSignalingConfigFromParams', () => {
  it('returns defaults when no signaling params are present', () => {
    const params = new URLSearchParams('host=abc');
    expect(parseSignalingConfigFromParams(params)).toEqual(DEFAULT_SIGNALING_CONFIG);
  });

  it('parses partial signaling overrides and keeps other defaults', () => {
    const params = new URLSearchParams(
      'host=abc&peerJsHost=vier&peerJsPort=9001&peerJsSecure=false'
    );
    const result = parseSignalingConfigFromParams(params);
    expect(result.peerJsHost).toBe('vier');
    expect(result.peerJsPort).toBe(9001);
    expect(result.peerJsSecure).toBe(false);
    expect(result.peerJsPath).toBe(DEFAULT_SIGNALING_CONFIG.peerJsPath);
  });

  it('tolerates non-params input', () => {
    expect(parseSignalingConfigFromParams(null)).toEqual(DEFAULT_SIGNALING_CONFIG);
    expect(parseSignalingConfigFromParams({})).toEqual(DEFAULT_SIGNALING_CONFIG);
  });

  it('round-trips via buildViewerUrl', () => {
    const source = {
      viewerUrlBase: 'http://vier:9000/',
      peerJsHost: 'vier',
      peerJsPort: 9001,
      peerJsPath: '/peerjs',
      peerJsSecure: false
    };
    const url = buildViewerUrl('abc', source);
    const parsed = parseSignalingConfigFromParams(new URL(url).searchParams);
    expect(parsed.peerJsHost).toBe('vier');
    expect(parsed.peerJsPort).toBe(9001);
    expect(parsed.peerJsPath).toBe('/peerjs');
    expect(parsed.peerJsSecure).toBe(false);
  });
});

describe('peerJsOptionsFromConfig', () => {
  it('maps defaults to the PeerJS cloud options', () => {
    expect(peerJsOptionsFromConfig()).toEqual({
      host: '0.peerjs.com',
      port: 443,
      path: '/',
      secure: true
    });
  });

  it('maps a self-hosted config to PeerJS constructor options', () => {
    expect(peerJsOptionsFromConfig({
      peerJsHost: 'vier',
      peerJsPort: 9001,
      peerJsPath: '/peerjs',
      peerJsSecure: false
    })).toEqual({
      host: 'vier',
      port: 9001,
      path: '/peerjs',
      secure: false
    });
  });
});
