/* 配置路径 / 字段名 → 人话。三处消费:发布页(改动列表、红项行)、平台数字页、下载入口页。
   🔴 为什么住在 lib(2026-09-01 第十轮独立验收 P2-7):这张表本来只在发布页里,
   于是平台数字页把校验报错印成「activeDevices:须为正数」、下载入口页印成
   「ios:须为 https 完整链接」—— 而同一个仓里现成就有「活跃设备」「iOS 版」的映射,
   只是别的页面够不着。表放在页面里,别的页面就只能各写各的。 */
/* 文案树的 18 个分组名(与 content.tsx 的 GROUPS 同一份,由 gate-console-copy 断言不漂)。
   🔴 少了它,`copy.*` 这一族——红项与改动里**最大的一族**——只能翻出「文案 · 中文」两个词,
   后半截仍是英文 key(第十轮独立验收 P2-8:屏幕上是「文案 · 中文 · footer · legalLine」)。 */
export const COPY_GROUPS: Record<string, string> = {
  hero: '首屏 Hero', download: '下载按钮文案', stats: '统计标签', path: '收益路径',
  how: '工作原理', devices: '设备板块', trust: '信任板块', social: '社证',
  mission: '使命', nex: 'NEX', learn: '学习中心', faq: 'FAQ 标题', final: '收尾 CTA',
  site: '站点信息(SEO 源)', nav: '导航', footer: '页脚', legal: '法务提示', notfound: '404 页',
};

/** 单个字段名 → 人话(给各内容页的校验报错用;认不出就原样返回,不隐藏) */
export const fieldName = (key: string): string => FIELD_NAME[key] ?? COPY_GROUPS[key] ?? key;

const AREA: Array<[RegExp, string]> = [
  [/^copy\.(en|vi|zh)\./, '文案'],
  [/^downloads\./, '下载入口'],
  [/^stats\./, '平台数字'],
  [/^skus\b/, '产品卡'],
  [/^faq\b/, '常见问题'],
  [/^announcement\./, '公告条'],
  [/^seo\./, 'SEO'],
  [/^footer\./, '页脚'],
  [/^legal\./, 'Legal 文本'],
];
const LOCALE_NAME: Record<string, string> = { en: '英文', vi: '越南语', zh: '中文' };
/* 字段名 → 人话。
   🔴 第一版只剥掉了区域前缀,尾巴原样保留,于是:
   `产品卡 · skus[0].priceUSD` —— **人话行和下面的原文小字一模一样,等于没翻译**;
   `平台数字 · activeDevices` 也和页面上写的「活跃设备」对不上(第八轮走查我点名请它判,它判「不够」)。
   现在逐字段真映射;认不出的尾巴保留原样(不隐藏),但至少区域和已知字段是人话。 */
const FIELD_NAME: Record<string, string> = {
  // 产品卡
  name: '名称', priceUSD: '价格', multiplier: '算力倍数', status: '状态', tagline: '标语', visible: '是否展示', sort: '排序',
  free: '是否免费档',
  // 下载入口(平台键也要译:`下载入口 · ios · 链接` 里那个 ios 是配置键,不是给人看的写法)
  url: '链接', enabled: '开关', ios: 'iOS 版', android: '安卓版', h5: '网页版',
  // 公告条 / SEO / 页脚
  text: '正文', startsAt: '开始时间', endsAt: '结束时间', title: '标题', description: '描述',
  social: '社媒链接', contactEmail: '联系邮箱', id: '编号',
  // 平台数字(与各页面上的标签一致)。走查实景抓到过「平台数字 · nodes」漏在这里
  activeDevices: '活跃设备', activeJobs: '运行中任务', countries: '覆盖国家', uptime: '在线率',
  nodes: '节点数', asOf: '数据截至',
  // FAQ / Legal
  items: '条目', q: '问题', a: '答案', md: '正文', updatedAt: '最后更新', href: '跳转链接',
  terms: '服务条款', privacy: '隐私政策', appPrivacy: 'App 隐私政策',
  // SEO 的页面 id(seo.pages 下的键就是路由名,直接摆出来运营对不上是哪一页)
  pages: '页面', home: '首页', learn: '学习页', nex: 'NEX 页',
  'legal-privacy': '隐私政策页', 'legal-terms': '服务条款页', 'legal-app-privacy': 'App 隐私政策页',
};
/** 例:`skus[0].priceUSD` → 「产品卡 · 第 1 张 · 价格」;认不出的部分保留原样,不隐藏 */
export function humanPath(path: string): string {
  const area = AREA.find(([re]) => re.test(path))?.[1];
  if (!area) return path;
  const loc = Object.keys(LOCALE_NAME).find((l) => path.startsWith(`copy.${l}.`) || path.endsWith(`.${l}`));
  const parts = path
    .replace(/^(copy\.(en|vi|zh)|[a-z]+)\.?/i, '') // 去区域前缀(含 copy.<语言>)
    .replace(/\.(en|vi|zh)$/, '') // 去尾部语言
    .split('.')
    .flatMap((seg) => {
      const m = /^([a-zA-Z_$][\w$]*)?\[(\d+)\]$/.exec(seg);
      if (m) return [m[1] ? (FIELD_NAME[m[1]] ?? m[1]) : null, `第 ${Number(m[2]) + 1} 项`].filter(Boolean) as string[];
      // copy 树的第一段是分组名(hero / footer / …),用 GROUPS 那份译名
      return seg ? [COPY_GROUPS[seg] ?? FIELD_NAME[seg] ?? seg] : [];
    });
  return [area, loc && LOCALE_NAME[loc], ...parts].filter(Boolean).join(' · ');
}

