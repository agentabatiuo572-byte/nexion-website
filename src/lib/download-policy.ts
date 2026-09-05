export interface DownloadEntry {
  url: string;
  enabled: boolean;
}

/** enabled 是最终开关；只有开启时才允许使用配置 URL 或过渡期环境兜底。 */
export function resolveDownloadUrl(config: DownloadEntry, environmentUrl: string | undefined): string {
  if (!config.enabled) return '';
  return config.url.trim() || (environmentUrl ?? '').trim();
}
