import { safeDownloadUrl, type DownloadPlatform } from './distribution';

export interface DownloadEntry {
  url: string;
  enabled: boolean;
}

export function resolveDownloadUrl(config: DownloadEntry, platform: DownloadPlatform): string {
  return config.enabled ? safeDownloadUrl(config.url, platform) : '';
}
