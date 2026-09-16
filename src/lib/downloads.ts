/* 下载/H5 链接单源(官网后台 PRD CON05,R45 裁决「下载 URL 归后台配置」落地):
   控制台配置优先;构建环境变量 PUBLIC_*_URL 保兜底(Phase C 上线切换前的过渡链)。
   空值 = 按钮 coming-soon 降级 / H5 键隐藏,零死链契约不变(WEB02)。 */
import { SITE_CONFIG as site } from './site-config';
import { resolveDownloadUrl } from './download-policy';

export const DOWNLOAD_URLS = {
  ios: resolveDownloadUrl(site.downloads.ios, import.meta.env.PUBLIC_IOS_URL),
  android: resolveDownloadUrl(site.downloads.android, import.meta.env.PUBLIC_ANDROID_URL),
  h5: resolveDownloadUrl(site.downloads.h5, import.meta.env.PUBLIC_H5_URL),
} as const;

/* 官网使用与最新中文稿同版的英文白皮书，随静态站点发布。 */
export const WHITEPAPER = {
  url: '/documents/nexgrid-whitepaper-v1.2-en.pdf',
  version: '1.2',
  pages: 21,
  language: 'en',
} as const;
