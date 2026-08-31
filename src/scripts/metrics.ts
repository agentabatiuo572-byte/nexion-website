/* [官网后台 PRD CON15] 匿名埋点 —— 契约:
   · 零 cookie / 零本地存储 / 无个人信息;DNT=1 整体不启动(E1)
   · 批量上报:5s / 满 10 条 / pagehide,sendBeacon 优先、fetch keepalive 兜底;失败静默不重试(E3)
   · 体积门:本文件产物 gzip ≤2KB(worker/gate-beacon-size.mjs)
   · 线上字段名(短键)与 worker/src/events.ts zod 契约一字不差;板块 id=站内真实锚点(§2.3 12 板块)
   · CTA 绑定:DownloadButtons 的 data-m="cta:*"(hero+收尾共用单源)/ 导航 .h5 / mailto */
const nav = navigator as Navigator & { msDoNotTrack?: string };
const DNT = nav.doNotTrack === '1' || nav.msDoNotTrack === '1';

type Ev = Record<string, string | number>;

if (!DNT) {
  const Q: Ev[] = [];
  const path = location.pathname;
  const lang = document.documentElement.lang || 'en';
  const loc = lang.startsWith('vi') ? 'vi' : lang.startsWith('zh') ? 'zh' : 'en';
  const dev = matchMedia('(max-width: 767px)').matches ? 'm' : 'd';

  const send = () => {
    while (Q.length) {
      const body = JSON.stringify({ events: Q.splice(0, 10) });
      try {
        if (!nav.sendBeacon?.('/api/e', new Blob([body], { type: 'application/json' }))) {
          fetch('/api/e', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {});
        }
      } catch {
        /* 采集永不影响站体验 */
      }
    }
  };
  const push = (e: Ev) => {
    Q.push(e);
    if (Q.length >= 10) send();
  };
  setInterval(send, 5000);
  addEventListener('pagehide', () => {
    vitFlush();
    send();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      vitFlush();
      send();
    }
  });

  // ---- pv(来源分类只留类别,不上报 referrer 原文)----
  const refHost = (() => {
    try {
      return document.referrer ? new URL(document.referrer).hostname : '';
    } catch {
      return '';
    }
  })();
  const ref = !refHost
    ? 'direct'
    : refHost === location.hostname
      ? 'internal'
      : /google\.|bing\.|duckduckgo|yandex|baidu|coccoc/.test(refHost)
        ? 'search'
        : /facebook|twitter|\bx\.com|t\.co|telegram|\bt\.me|tiktok|youtube|instagram|reddit|zalo/.test(refHost)
          ? 'social'
          : 'referral';
  const sp = new URLSearchParams(location.search);
  const u = (k: string) => (sp.get(k) || '').slice(0, 64);
  push({ t: 'pv', path, loc, dev, ref, us: u('utm_source'), um: u('utm_medium'), uc: u('utm_campaign') });

  // ---- sec:12 板块曝光 ≥50% 首次(id=站内真实锚点)----
  const SECTIONS = ['download', 'stats', 'social', 'mission', 'devices', 'how', 'path', 'trust', 'nex', 'learn-entry', 'faq', 'final-cta'];
  try {
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (e.isIntersecting) {
            push({ t: 'sec', sec: (e.target as HTMLElement).id, path });
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.5 },
    );
    for (const id of SECTIONS) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
  } catch {}

  // ---- cta:下载三键(data-m 单源)/ 导航 Web App / 联系 mailto ----
  document.addEventListener(
    'click',
    (e) => {
      const el = (e.target as HTMLElement).closest?.('a,button');
      if (!el) return;
      const m = el.getAttribute('data-m');
      const cta = m?.startsWith('cta:')
        ? m.slice(4)
        : el.classList.contains('h5')
          ? 'h5'
          : (el.getAttribute('href') || '').startsWith('mailto:')
            ? 'contact'
            : '';
      if (cta) push({ t: 'cta', cta, sec: (el.closest('[id]') as HTMLElement | null)?.id || '', loc, path });
    },
    { capture: true, passive: true },
  );

  // ---- faq:原生 details 手风琴展开(id=DOM 序 q1..qN)----
  document.querySelectorAll('#faq details').forEach((d, i) => {
    let seen = 0;
    d.addEventListener('toggle', () => {
      if ((d as HTMLDetailsElement).open && !seen++) push({ t: 'faq', faq: 'q' + (i + 1), loc });
    });
  });

  // ---- vit:LCP/CLS(p75 汇总在服务端;INP 归 V2)----
  let lcp = 0;
  let cls = 0;
  let vitSent = 0;
  try {
    new PerformanceObserver((l) => {
      const es = l.getEntries();
      const last = es[es.length - 1] as PerformanceEntry | undefined;
      if (last) lcp = last.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const en of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        if (!en.hadRecentInput) cls += en.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  const vitFlush = () => {
    if (!vitSent++ && lcp > 0) push({ t: 'vit', lcp: Math.round(lcp), cls: Math.round(cls * 1000) / 1000, path, dev });
  };

  // ---- err:JS 报错哈希计数(≤5/页,不上报内容原文之外的任何用户数据)----
  let errN = 0;
  addEventListener('error', (e) => {
    if (errN++ >= 5) return;
    const s = `${e.message}|${e.filename}|${e.lineno}`;
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    push({ t: 'err', h: (h >>> 0).toString(16), path });
  });
}
