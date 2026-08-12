// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { VERSION } from '../version';

export const isRunningInBrowser = () => {
  return (
    // @ts-ignore
    typeof window !== 'undefined' &&
    // @ts-ignore
    typeof window.document !== 'undefined' &&
    // @ts-ignore
    typeof navigator !== 'undefined'
  );
};

type DetectedPlatform = 'cloudflare' | 'deno' | 'node' | 'edge' | 'unknown';

type RuntimeEnvironment = {
  deno?: any;
  edgeRuntime?: unknown;
  navigator?: { userAgent?: string };
  process?: any;
};

function getRuntimeEnvironment(): RuntimeEnvironment {
  return {
    deno: typeof Deno === 'undefined' ? undefined : Deno,
    edgeRuntime: typeof EdgeRuntime === 'undefined' ? undefined : EdgeRuntime,
    navigator: typeof navigator === 'undefined' ? undefined : navigator,
    process:
      typeof (globalThis as any).process === 'undefined' ? undefined : (globalThis as any).process,
  };
}

/**
 * Note this does not detect 'browser'; for that, use getBrowserInfo().
 */
function getDetectedPlatform(environment: RuntimeEnvironment): DetectedPlatform {
  if (environment.deno?.build != null) {
    return 'deno';
  }
  if (environment.edgeRuntime !== undefined) {
    return 'edge';
  }
  // Cloudflare Workers can expose a Node-compatible `process` global. Detect
  // the runtime's stable user agent before checking for Node so nodejs_compat
  // does not cause Workers requests to be reported as Node.js.
  if (environment.navigator?.userAgent === 'Cloudflare-Workers') {
    return 'cloudflare';
  }
  if (
    Object.prototype.toString.call(environment.process === undefined ? 0 : environment.process) ===
    '[object process]'
  ) {
    return 'node';
  }
  return 'unknown';
}

declare const Deno: any;
declare const EdgeRuntime: any;
type Arch = 'x32' | 'x64' | 'arm' | 'arm64' | `other:${string}` | 'unknown';
type PlatformName =
  | 'MacOS'
  | 'Linux'
  | 'Windows'
  | 'FreeBSD'
  | 'OpenBSD'
  | 'iOS'
  | 'Android'
  | `Other:${string}`
  | 'Unknown';
type Browser = 'ie' | 'edge' | 'chrome' | 'firefox' | 'safari';
type PlatformProperties = {
  'X-Stainless-Lang': 'js';
  'X-Stainless-Package-Version': string;
  'X-Stainless-OS': PlatformName;
  'X-Stainless-Arch': Arch;
  'X-Stainless-Runtime': 'node' | 'deno' | 'edge' | `browser:${Browser}` | 'unknown';
  'X-Stainless-Runtime-Version': string;
};
export const getPlatformProperties = (
  environment: RuntimeEnvironment = getRuntimeEnvironment(),
): PlatformProperties => {
  const detectedPlatform = getDetectedPlatform(environment);
  if (detectedPlatform === 'deno') {
    return {
      'X-Stainless-Lang': 'js',
      'X-Stainless-Package-Version': VERSION,
      'X-Stainless-OS': normalizePlatform(environment.deno.build.os),
      'X-Stainless-Arch': normalizeArch(environment.deno.build.arch),
      'X-Stainless-Runtime': 'deno',
      'X-Stainless-Runtime-Version':
        typeof environment.deno.version === 'string' ?
          environment.deno.version
        : environment.deno.version?.deno ?? 'unknown',
    };
  }
  if (detectedPlatform === 'edge') {
    return {
      'X-Stainless-Lang': 'js',
      'X-Stainless-Package-Version': VERSION,
      'X-Stainless-OS': 'Unknown',
      'X-Stainless-Arch': `other:${String(environment.edgeRuntime)}`,
      'X-Stainless-Runtime': 'edge',
      'X-Stainless-Runtime-Version': environment.process?.version ?? 'unknown',
    };
  }
  if (detectedPlatform === 'cloudflare') {
    return {
      'X-Stainless-Lang': 'js',
      'X-Stainless-Package-Version': VERSION,
      'X-Stainless-OS': 'Unknown',
      'X-Stainless-Arch': 'unknown',
      'X-Stainless-Runtime': 'edge',
      // Cloudflare deliberately exposes a stable product user agent without a
      // runtime version. Do not substitute the Node compatibility version.
      'X-Stainless-Runtime-Version': 'unknown',
    };
  }
  // Check if Node.js
  if (detectedPlatform === 'node') {
    return {
      'X-Stainless-Lang': 'js',
      'X-Stainless-Package-Version': VERSION,
      'X-Stainless-OS': normalizePlatform(environment.process.platform ?? 'unknown'),
      'X-Stainless-Arch': normalizeArch(environment.process.arch ?? 'unknown'),
      'X-Stainless-Runtime': 'node',
      'X-Stainless-Runtime-Version': environment.process.version ?? 'unknown',
    };
  }

  const browserInfo = getBrowserInfo(environment.navigator?.userAgent);
  if (browserInfo) {
    return {
      'X-Stainless-Lang': 'js',
      'X-Stainless-Package-Version': VERSION,
      'X-Stainless-OS': 'Unknown',
      'X-Stainless-Arch': 'unknown',
      'X-Stainless-Runtime': `browser:${browserInfo.browser}`,
      'X-Stainless-Runtime-Version': browserInfo.version,
    };
  }

  return {
    'X-Stainless-Lang': 'js',
    'X-Stainless-Package-Version': VERSION,
    'X-Stainless-OS': 'Unknown',
    'X-Stainless-Arch': 'unknown',
    'X-Stainless-Runtime': 'unknown',
    'X-Stainless-Runtime-Version': 'unknown',
  };
};

type BrowserInfo = {
  browser: Browser;
  version: string;
};

declare const navigator: { userAgent: string } | undefined;

// Note: modified from https://github.com/JS-DevTools/host-environment/blob/b1ab79ecde37db5d6e163c050e54fe7d287d7c92/src/isomorphic.browser.ts
function getBrowserInfo(
  userAgent = typeof navigator === 'undefined' ? undefined : navigator?.userAgent,
): BrowserInfo | null {
  if (!userAgent) {
    return null;
  }

  // NOTE: The order matters here!
  const browserPatterns = [
    { key: 'edge' as const, pattern: /Edge(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: 'ie' as const, pattern: /MSIE(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: 'ie' as const, pattern: /Trident(?:.*rv\:(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: 'chrome' as const, pattern: /Chrome(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: 'firefox' as const, pattern: /Firefox(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: 'safari' as const, pattern: /(?:Version\W+(\d+)\.(\d+)(?:\.(\d+))?)?(?:\W+Mobile\S*)?\W+Safari/ },
  ];

  // Find the FIRST matching browser
  for (const { key, pattern } of browserPatterns) {
    const match = pattern.exec(userAgent);
    if (match) {
      const major = match[1] || 0;
      const minor = match[2] || 0;
      const patch = match[3] || 0;

      return { browser: key, version: `${major}.${minor}.${patch}` };
    }
  }

  return null;
}

const normalizeArch = (arch: string): Arch => {
  // Node docs:
  // - https://nodejs.org/api/process.html#processarch
  // Deno docs:
  // - https://doc.deno.land/deno/stable/~/Deno.build
  if (arch === 'x32') return 'x32';
  if (arch === 'x86_64' || arch === 'x64') return 'x64';
  if (arch === 'arm') return 'arm';
  if (arch === 'aarch64' || arch === 'arm64') return 'arm64';
  if (arch) return `other:${arch}`;
  return 'unknown';
};

const normalizePlatform = (platform: string): PlatformName => {
  // Node platforms:
  // - https://nodejs.org/api/process.html#processplatform
  // Deno platforms:
  // - https://doc.deno.land/deno/stable/~/Deno.build
  // - https://github.com/denoland/deno/issues/14799

  platform = platform.toLowerCase();

  // NOTE: this iOS check is untested and may not work
  // Node does not work natively on IOS, there is a fork at
  // https://github.com/nodejs-mobile/nodejs-mobile
  // however it is unknown at the time of writing how to detect if it is running
  if (platform.includes('ios')) return 'iOS';
  if (platform === 'android') return 'Android';
  if (platform === 'darwin') return 'MacOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'freebsd') return 'FreeBSD';
  if (platform === 'openbsd') return 'OpenBSD';
  if (platform === 'linux') return 'Linux';
  if (platform) return `Other:${platform}`;
  return 'Unknown';
};

let _platformHeaders: PlatformProperties;
export const getPlatformHeaders = () => {
  return (_platformHeaders ??= getPlatformProperties());
};
