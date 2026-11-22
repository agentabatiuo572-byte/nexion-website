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

export function safeDownloadUrl(value: string | undefined): string {
  const url = (value ?? '').trim();
  if (!/^https:\/\//i.test(url) || /[\u0000-\u0020\u007f\\]/.test(url)) return '';
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return '';
    return parsed.href;
  } catch { return ''; }
}

export function decideDownload(
  requested: DownloadRequest,
  device: DeviceOS,
  urls: DownloadUrls,
  embedded: boolean,
  source: 'button' | 'scan' | 'preview' = 'button',
): DistributionDecision {
  const detected = device === 'ios' || device === 'android' ? device : null;
  const platform = requested === 'auto' ? detected ?? (urls.android || !urls.ios ? 'android' : 'ios') : requested;
  const url = safeDownloadUrl(urls[platform]);
  if (!url) return { kind: 'unavailable', platform, url: '' };
  if (platform !== 'h5') {
    if (device === 'desktop' && (source !== 'button' || requested === 'auto')) return { kind: 'qr', platform, url };
    if (requested === 'auto' && !detected) return { kind: 'choose', platform, url };
    if (source === 'scan' && detected && platform !== detected) return { kind: 'mismatch', platform, url: '' };
  }
  if (embedded) return { kind: 'browser', platform, url };
  return { kind: 'navigate', platform, url };
}

export function distributionPath(locale: string, platform: DownloadRequest = 'auto'): string {
  return `${locale === 'en' ? '' : `/${locale}`}/download/?platform=${platform}`;
}
