// Native download entries resolve the current production A3 URL on each click.
// Keep package URLs out of static builds; Web App uses the h5-lite-main deployment.
export const DOWNLOAD_URLS = {
  ios: '/api/app-download/ios',
  android: '/api/app-download/android',
  h5: 'https://app.uvel.ai/h5/',
} as const;

/* 官网使用与最新中文稿同版的英文白皮书，随静态站点发布。 */
export const WHITEPAPER = {
  url: '/documents/uvel-whitepaper-v1.3-en.pdf',
  version: '1.3',
  pages: 21,
  language: 'en',
} as const;
