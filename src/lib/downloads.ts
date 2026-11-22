import { resolveDownloadUrl } from './download-policy';
import { SITE_CONFIG } from './site-config';

const { downloads } = SITE_CONFIG;
export const DOWNLOAD_URLS = {
  ios: resolveDownloadUrl(downloads.ios, 'ios'),
  android: resolveDownloadUrl(downloads.android, 'android'),
  h5: resolveDownloadUrl(downloads.h5, 'h5'),
} as const;

/* 官网使用与最新中文稿同版的英文白皮书，随静态站点发布。 */
export const WHITEPAPER = {
  url: '/documents/uvel-whitepaper-v1.3-en.pdf',
  version: '1.3',
  pages: 22,
  language: 'en',
} as const;
