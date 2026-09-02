#!/usr/bin/env node
/* 种子生成器(CON16):从站仓现内容反向生成 SiteConfig 种子 + 文案清单。
   种子=控制台首次运行的 live/draft 初值;等价性基线(gate-equivalence)以它为输入。
   用法:node build-seed.mjs [--write](--write 落盘 seed/site-config.seed.json + seed/copy-manifest.json)
   依赖 node ≥22.12 的 TS 直跑(本机 24);站 TS 模块(skus/stats)与 schema TS 直接 import。 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, isCollectionBacked, flatten } from '../schema/src/manifest.ts';
import { SiteConfigSchema, SEO_PAGE_IDS } from '../schema/src/site-config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(here, '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function buildSeed() {
  const en = readJson(path.join(SITE, 'src/i18n/en.json'));
  const vi = readJson(path.join(SITE, 'src/i18n/vi.json'));
  const zh = readJson(path.join(SITE, 'src/i18n/zh.json'));
  const manifest = buildManifest(en, vi, zh);

  /* 非文案域(stats/skus 事实字段/downloads/公告/seo/footer/legal)自 2026-08-31 CON16 接管起
     真源=配置本身:从既有种子延续,不再反读站 TS(站 TS 已是配置的消费者,反读=循环)。
     文案域(copy/faq 问答/sku 标语)仍从 i18n 反读——i18n 文件是物化产物,内容与配置恒等
     (等价性门守),反读它 = 读上一轮配置,且能吸收「代码新增 key」的种子化(CON04-③)。 */
  const seedPath = path.join(here, 'seed/site-config.seed.json');
  if (!existsSync(seedPath)) {
    console.error('✗ 缺 seed/site-config.seed.json(非文案域的延续源)。首次引导已在 2026-08-31 完成并入库;若真丢了,从 git 恢复。');
    process.exit(2);
  }
  const prev = readJson(seedPath);

  const copyOf = (nested) => Object.fromEntries(flatten(nested).filter(([p]) => !isCollectionBacked(p)));
  const tri = (nested, pathStr) => pathStr.split('.').reduce((o, s) => o?.[s], nested) ?? '';

  const faqCount = manifest.en.paths.filter((p) => /^faq\.q\d+$/.test(p)).length;
  const faqItems = Array.from({ length: faqCount }, (_, i) => ({
    id: `q${i + 1}`,
    q: { en: tri(en, `faq.q${i + 1}`), vi: tri(vi, `faq.q${i + 1}`), zh: tri(zh, `faq.q${i + 1}`) },
    a: { en: tri(en, `faq.a${i + 1}`), vi: tri(vi, `faq.a${i + 1}`), zh: tri(zh, `faq.a${i + 1}`) },
    sort: i + 1,
    visible: true,
  }));

  const skus = prev.skus.map((s) => ({
    ...s,
    tagline: {
      en: tri(en, `devices.tagline.${s.id}`) || s.tagline.en,
      vi: tri(vi, `devices.tagline.${s.id}`) || s.tagline.vi,
      zh: tri(zh, `devices.tagline.${s.id}`) || s.tagline.zh,
    },
  }));

  const seoPage = (title, desc) => ({ title, description: desc });
  const triKey = (k) => ({ en: tri(en, k), vi: tri(vi, k), zh: tri(zh, k) });
  const joinTri = (a, b) => ({ en: `${a.en} — ${b.en}`, vi: `${a.vi} — ${b.vi}`, zh: `${a.zh} — ${b.zh}` });
  const seoPages = Object.fromEntries(
    SEO_PAGE_IDS.map((pid) => {
      switch (pid) {
        case 'home':
          return [pid, seoPage(joinTri(triKey('site.name'), triKey('site.tagline')), triKey('site.description'))];
        case 'learn':
          return [pid, seoPage(triKey('learn.title'), triKey('learn.subtitle'))];
        case 'nex':
          return [pid, seoPage(triKey('nex.teaserTitle'), triKey('nex.pageLead'))];
        default:
          return [pid, seoPage(triKey('site.name'), triKey('site.description'))];
      }
    }),
  );

  const config = {
    copy: { en: copyOf(en), vi: copyOf(vi), zh: copyOf(zh) },
    downloads: prev.downloads,
    stats: prev.stats,
    skus,
    faq: { items: faqItems },
    announcement: prev.announcement,
    seo: { pages: seoPages },
    footer: prev.footer,
    legal: prev.legal,
  };
  const parsed = SiteConfigSchema.safeParse(config);
  if (!parsed.success) {
    console.error('✗ 种子不合 schema:', JSON.stringify(parsed.error.issues.slice(0, 5), null, 1));
    process.exit(2);
  }
  return { config: parsed.data, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { config, manifest } = buildSeed();
  if (process.argv.includes('--write')) {
    const dir = path.join(here, 'seed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'site-config.seed.json'), JSON.stringify(config, null, 2) + '\n');
    writeFileSync(path.join(dir, 'copy-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const { materializeSiteJson } = await import('../schema/src/materialize.ts');
    mkdirSync(path.join(SITE, 'src/config'), { recursive: true });
    writeFileSync(path.join(SITE, 'src/config/site.json'), materializeSiteJson(config));
    console.log(`✓ 种子已写:seed/*.json + src/config/site.json(copy ${Object.keys(config.copy.en).length} 键 ×3 语,faq ${config.faq.items.length},sku ${config.skus.length})`);
  } else {
    console.log(`✓ 种子构建 OK(--write 落盘)`);
  }
}
