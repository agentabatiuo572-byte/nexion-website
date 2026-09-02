import type { Env } from './env';

/* 日汇总引擎(PRD CON03-③ 口径字典 + §5.3 九表)。幂等:先删该日再写(可重跑/可回填)。
   口径要点:Bot 不入流量只入占比;blocked 独立分桶;会话=同 uid 事件间隔 ≤30 分钟;
   learn 阅读由 pv 路径派生(/learn/<slug>,三语前缀通吃)——§5.2 的 learn 行以此落地。
   ponytail: 聚合用 JS 单趟遍历(正确性直白);当日事件量到十万级再换 SQL 窗口函数,路径已知。 */

const SESSION_GAP_MS = 30 * 60_000;
const RETENTION_DAYS = 90;

interface RawRow {
  ts: number;
  type: string;
  uid: string | null;
  payload: string;
}

function dayRangeUtc(day: string): { from: number; to: number } {
  const from = Date.parse(`${day}T00:00:00.000Z`);
  return { from, to: from + 86_400_000 };
}

/** nearest-rank p75:sorted[ceil(0.75·n)-1](与测试同式,防两处各算各的) */
export function p75(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.75 * s.length) - 1)]!;
}

export async function runDailyRollup(db: D1Database, day: string): Promise<void> {
  const { from, to } = dayRangeUtc(day);
  const rows = (
    await db.prepare('SELECT ts, type, uid, payload FROM raw_events WHERE ts >= ?1 AND ts < ?2 ORDER BY uid, ts').bind(from, to).all<RawRow>()
  ).results;

  // ---- 单趟累加器 ----
  const traffic = new Map<string, { pv: number; uv: Set<string>; sessions: number }>(); // key: loc|country|dev|ref
  const lastTsByUid = new Map<string, number>();
  const uidDims = new Map<string, string>(); // 会话按该 uid 首事件维度归属
  const cta = new Map<string, { clicks: number; uniq: Set<string> }>(); // key: cta|loc
  const sec = new Map<string, Set<string>>();
  const faq = new Map<string, number>();
  const learn = new Map<string, number>();
  const errs = new Map<string, number>();
  const blocked = new Map<string, number>();
  const page = new Map<string, { pv: number; uv: Set<string> }>(); // key: path|locale(CON03 页面榜)
  const notfound = new Map<string, number>(); // 404 命中(服务端计数,CON03 质量卡)
  const lcps: number[] = [];
  const clss: number[] = [];
  let vitN = 0;
  let pvHuman = 0;
  let pvBot = 0;

  for (const r of rows) {
    const p = JSON.parse(r.payload) as Record<string, unknown>;
    const isBot = p.bot === 1;
    const uid = r.uid ?? '';
    switch (r.type) {
      case 'pv': {
        if (isBot) {
          pvBot++;
          break;
        }
        pvHuman++;
        const key = `${p.loc}|${p.country}|${p.dev}|${p.ref}`;
        let t = traffic.get(key);
        if (!t) traffic.set(key, (t = { pv: 0, uv: new Set(), sessions: 0 }));
        t.pv++;
        t.uv.add(uid);
        if (!uidDims.has(uid)) uidDims.set(uid, key);
        const prev = lastTsByUid.get(uid);
        if (prev === undefined || r.ts - prev > SESSION_GAP_MS) {
          traffic.get(uidDims.get(uid)!)!.sessions++;
        }
        lastTsByUid.set(uid, r.ts);
        const m = /^(?:\/(?:vi|zh))?\/learn\/([^/]+)\/?$/.exec(String(p.path ?? ''));
        if (m) learn.set(m[1]!, (learn.get(m[1]!) ?? 0) + 1);
        {
          const pk = `${String(p.path ?? '/')}|${String(p.loc ?? 'en')}`;
          let pg = page.get(pk);
          if (!pg) page.set(pk, (pg = { pv: 0, uv: new Set() }));
          pg.pv++;
          pg.uv.add(uid);
        }
        break;
      }
      case 'sec': {
        if (isBot) break;
        const id = String(p.sec);
        if (!sec.has(id)) sec.set(id, new Set());
        sec.get(id)!.add(uid);
        break;
      }
      case 'cta': {
        if (isBot) break;
        const key = `${p.cta}|${p.loc}`;
        let x = cta.get(key);
        if (!x) cta.set(key, (x = { clicks: 0, uniq: new Set() }));
        x.clicks++;
        x.uniq.add(uid);
        break;
      }
      case 'faq':
        if (!isBot) faq.set(String(p.faq), (faq.get(String(p.faq)) ?? 0) + 1);
        break;
      case 'vit':
        if (!isBot) {
          vitN++;
          lcps.push(Number(p.lcp));
          clss.push(Number(p.cls));
        }
        break;
      case 'err':
        errs.set(String(p.h), (errs.get(String(p.h)) ?? 0) + 1);
        break;
      case 'blocked':
        blocked.set(String(p.c ?? 'XX'), (blocked.get(String(p.c ?? 'XX')) ?? 0) + 1);
        break;
      case 'e404':
        notfound.set(String(p.path ?? '/'), (notfound.get(String(p.path ?? '/')) ?? 0) + 1);
        break;
    }
  }

  // ---- 幂等写入:该日先删后插,单个 batch 原子提交 ----
  const stmts: D1PreparedStatement[] = [
    ...['daily_traffic', 'daily_cta', 'daily_section', 'daily_faq', 'daily_learn', 'daily_vitals', 'daily_errors', 'daily_blocked', 'daily_bot', 'daily_page', 'daily_notfound'].map(
      (t) => db.prepare(`DELETE FROM ${t} WHERE date = ?1`).bind(day),
    ),
  ];
  for (const [key, v] of page) {
    const [pth, loc] = key.split('|');
    stmts.push(db.prepare('INSERT INTO daily_page (date, path, locale, pv, uv) VALUES (?1,?2,?3,?4,?5)').bind(day, pth, loc, v.pv, v.uv.size));
  }
  for (const [pth, n] of notfound) stmts.push(db.prepare('INSERT INTO daily_notfound (date, path, hits) VALUES (?1,?2,?3)').bind(day, pth, n));
  for (const [key, v] of traffic) {
    const [loc, country, devC, ref] = key.split('|');
    stmts.push(
      db
        .prepare('INSERT INTO daily_traffic (date, locale, country, device, ref_class, pv, uv, sessions) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
        .bind(day, loc, country, devC, ref, v.pv, v.uv.size, v.sessions),
    );
  }
  for (const [key, v] of cta) {
    const [id, loc] = key.split('|');
    stmts.push(db.prepare('INSERT INTO daily_cta (date, cta_id, locale, clicks, uniq) VALUES (?1,?2,?3,?4,?5)').bind(day, id, loc, v.clicks, v.uniq.size));
  }
  for (const [id, uids] of sec) stmts.push(db.prepare('INSERT INTO daily_section (date, section_id, uniq) VALUES (?1,?2,?3)').bind(day, id, uids.size));
  for (const [id, n] of faq) stmts.push(db.prepare('INSERT INTO daily_faq (date, faq_id, opens) VALUES (?1,?2,?3)').bind(day, id, n));
  for (const [slug, n] of learn) stmts.push(db.prepare('INSERT INTO daily_learn (date, slug, reads) VALUES (?1,?2,?3)').bind(day, slug, n));
  if (vitN > 0) stmts.push(db.prepare('INSERT INTO daily_vitals (date, lcp_p75, cls_p75, n) VALUES (?1,?2,?3,?4)').bind(day, p75(lcps), p75(clss), vitN));
  for (const [h, n] of errs) stmts.push(db.prepare('INSERT INTO daily_errors (date, msg_hash, count) VALUES (?1,?2,?3)').bind(day, h, n));
  for (const [cn, n] of blocked) stmts.push(db.prepare('INSERT INTO daily_blocked (date, country, hits) VALUES (?1,?2,?3)').bind(day, cn, n));
  if (pvHuman + pvBot > 0)
    // 存分子分母:期间占比必须按请求加权算,不能对各日 bot_share 求平均(验收 P1-3)
    stmts.push(
      db.prepare('INSERT INTO daily_bot (date, bot_share, bot_pv, human_pv) VALUES (?1, ?2, ?3, ?4)')
        .bind(day, Math.round((pvBot / (pvHuman + pvBot)) * 1000) / 1000, pvBot, pvHuman),
    );
  await db.batch(stmts);
}

/** 原始事件 90 天滚动清理(PRD §5.3) */
export async function pruneRawEvents(db: D1Database, now: number): Promise<number> {
  const r = await db.prepare('DELETE FROM raw_events WHERE ts < ?1').bind(now - RETENTION_DAYS * 86_400_000).run();
  return r.meta.changes ?? 0;
}

/** cron 入口:汇总昨日(UTC)+ 清理 */
export async function dailyJob(env: Env, now = Date.now()): Promise<void> {
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
  await runDailyRollup(env.DB, yesterday);
  await pruneRawEvents(env.DB, now);
}
