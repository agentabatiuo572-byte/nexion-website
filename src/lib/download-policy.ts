import { safeDownloadUrl } from './distribution';

export interface DownloadEntry {
  url: string;
  enabled: boolean;
}

export function resolveDownloadUrl(config: DownloadEntry): string {
  return config.enabled ? safeDownloadUrl(config.url) : '';
}
