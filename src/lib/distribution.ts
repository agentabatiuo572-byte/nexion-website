/** Website and QR entry policy. Only configured destinations can be opened. */
export type DownloadPlatform = 'ios' | 'android' | 'h5';
export type DownloadRequest = DownloadPlatform | 'auto';
export type DeviceOS = 'ios' | 'android' | 'desktop' | 'unknown';
export type DownloadUrls = Record<DownloadPlatform, string>;
export type DistributionDecision = {
  kind: 'qr' | 'choose' | 'mismatch' | 'unavailable' | 'browser' | 'navigate';
  platform: DownloadPlatform;
  url: string;
};

export function detectDevice(userAgent: string, platform = '', maxTouchPoints = 0): DeviceOS {
  if (/Windows Phone|Windows Mobile/i.test(userAgent)) return 'unknown';
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPad|iPhone|iPod/i.test(userAgent) || (/Mac/i.test(platform || userAgent) && maxTouchPoints > 1)) return 'ios';
  if (/Mobile|HarmonyOS/i.test(userAgent)) return 'unknown';
  if (/Windows NT|Macintosh|X11|CrOS|Linux/i.test(userAgent)) return 'desktop';
  return 'unknown';
}

export function isEmbeddedBrowser(userAgent: string): boolean {
  return /MicroMessenger|\bQQ\/|Weibo|FBAN|FBAV|Instagram|DingTalk/i.test(userAgent);
}

export function parseDownloadRequest(value: string | null | undefined): DownloadRequest {
  return value === 'ios' || value === 'android' || value === 'h5' ? value : 'auto';
}

/** Relative same-site URLs and HTTPS are supported; arbitrary protocols and credentials are rejected. */
export function safeDownloadUrl(value: string | undefined): string {
  const url = (value ?? '').trim();
  if (!url || /[\u0000-\u001f\u007f\\]/.test(url)) return '';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : '';
  } catch { return ''; }
}

export function decideDownload(
  requested: DownloadRequest,
  device: DeviceOS,
  urls: DownloadUrls,
  embedded: boolean,
  source: 'button' | 'scan' = 'button',
): DistributionDecision {
  const detected = device === 'ios' || device === 'android' ? device : null;
  const platform = requested === 'h5' ? 'h5'
    : source === 'button' && detected ? detected
    : requested === 'auto' ? detected ?? 'android' : requested;
  const url = safeDownloadUrl(urls[platform]);
  if (platform !== 'h5') {
    if (device === 'desktop') return { kind: 'qr', platform, url };
    if (requested === 'auto' && !detected) return { kind: 'choose', platform, url };
    if (source === 'scan' && detected && platform !== detected) return { kind: 'mismatch', platform, url: '' };
  }
  if (!url) return { kind: 'unavailable', platform, url: '' };
  if (embedded) return { kind: 'browser', platform, url };
  return { kind: 'navigate', platform, url };
}

export function distributionPath(locale: string, platform: DownloadRequest = 'auto'): string {
  return `${locale === 'en' ? '' : `/${locale}`}/download/?platform=${platform}`;
}
