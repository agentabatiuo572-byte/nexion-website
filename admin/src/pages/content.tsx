/* 文案树编辑器(CON04 ⑤⑥):18 组分组 · 三语并排 · 缺译黄旗 · 禁用词即时红(词表与站上门同一份)
   · 占位符守恒即时校验 · 行级「查看线上值/撤销」 · 乐观锁冲突条。
   faq 问答与设备标语为集合背书(各自模块页管理),本页对应组只读跳转——每 key 唯一编辑面(⑦)。 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
// @ts-expect-error 禁用词单源(站上门同文件)
import { scanForbidden } from '../../../scripts/forbidden-patterns.mjs';
import { tokensOf, useDraft, type SiteConfigView } from '../lib/use-draft';
import { AutoTextarea } from '../lib/auto-textarea';
import { COPY_GROUPS } from '../lib/human-path';
import { useFocusField } from '../lib/use-focus-field';

/* 分组名单源在 lib/human-path 的 COPY_GROUPS —— 发布页翻译红项路径时用的是同一份。
   两处各写各的必漂:实测发布页此前根本翻不出组名,因为那张表只在这个页面里。 */
const GROUPS: Array<[string, string]> = Object.entries(COPY_GROUPS);
const SENSITIVE_GROUPS = new Set(['trust', 'legal']);
const SENSITIVE_KEYS = ['footer.legalLine'];
const COLLECTION_NOTE: Record<string, ReactNode> = {
  faq: <>问答条目在 <Link to="/content/faq" style={{ color: 'var(--brand)' }}>FAQ 模块</Link> 管理;本组只含板块标题。</>,
  devices: <>各设备标语随 <Link to="/content/skus" style={{ color: 'var(--brand)' }}>产品卡</Link> 编辑;本组为板块文案。</>,
};

type Hit = { label: string; match: string };
const scan = scanForbidden as (t: string) => Hit[];

export default function ContentPage() {
  useFocusField(); // 「去修复」带来的 ?focus=<字段> 由它定位并高亮
  const { draft, live, saving, conflict, clearConflict, save, reload } = useDraft();
  const [group, setGroup] = useState('hero');
  const [q, setQ] = useState('');
  const [edits, setEdits] = useState<Record<string, Partial<Record<'en' | 'vi' | 'zh', string>>>>({});
  const [confirmRevert, setConfirmRevert] = useState<string | null>(null); // 撤销两步确认(PRD ④,T11-P3)
  const [showLive, setShowLive] = useState<Record<string, boolean>>({}); // 行内线上值展开(PRD ⑥,T11-P4)

  /* 🔴 搜索**跨全部 18 组**(2026-09-01 第十轮独立验收 P2-12):
     上一版先按当前组过滤、再按关键词过滤,于是运营记得站上有句话要改、
     却不知道它属于哪一组时,搜索完全帮不上忙,只能逐组点开再搜。
     现在:没输关键词 = 看当前组(默认行为不变);输了关键词 = 全局搜,
     并在每条上标出它属于哪一组,点组名可以切过去。 */
  const searching = q.trim().length > 0;
  const matches = (k: string) =>
    k.toLowerCase().includes(q.toLowerCase()) || (['en', 'vi', 'zh'] as const).some((l) => (val(draft!, l, k) ?? '').toLowerCase().includes(q.toLowerCase()));
  const keys = useMemo(() => {
    if (!draft) return [];
    const all = Object.keys(draft.copy.en);
    return searching ? all.filter(matches) : all.filter((k) => k.startsWith(group + '.'));
  }, [draft, group, q, searching]);

  if (!draft) return <section><h2>文案树</h2><div className="grid"><div className="skl" /><div className="skl" style={{ width: '70%' }} /></div></section>;

  function val(d: SiteConfigView, loc: 'en' | 'vi' | 'zh', k: string): string {
    return edits[k]?.[loc] ?? d.copy[loc][k] ?? '';
  }
  const dirtyCount = Object.keys(edits).length;
  // CON04-E2(保存级硬拦,与服务端同判):任何键任一译文占位符缺失 → 保存禁用
  const placeholderBlocked = Object.keys(edits).some((k) => {
    const en = val(draft, 'en', k);
    return (['vi', 'zh'] as const).some((loc) => {
      const v = val(draft, loc, k);
      return v && tokensOf(en).some((t) => !tokensOf(v).includes(t));
    });
  });

  async function saveAll() {
    const ok = await save((d) => {
      for (const [k, m] of Object.entries(edits)) for (const [loc, v] of Object.entries(m)) d.copy[loc as 'en'][k] = v as string;
    }, `已保存 ${dirtyCount} 处到草稿 · 未发布`);
    if (ok) setEdits({});
  }

  const groupDirty = (g: string) => Object.keys(edits).filter((k) => k.startsWith(g + '.')).length;

  return (
    <section>
      <h2>文案树 · 三语编辑</h2>
      {conflict && (
        <div className="note bad">草稿已在别处更新(另一个标签页?)。为不覆盖那边的改动,本次保存被拒——
          <button className="btn ghost sm" onClick={() => { setEdits({}); clearConflict(); reload(); }}>刷新后重试(本页未保存改动将丢弃)</button>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: 14 }}>
        <div className="card" style={{ padding: 10, alignSelf: 'start' }}>
          {GROUPS.map(([g, label]) => (
            <button key={g} className={`nav ${group === g ? 'on' : ''}`} onClick={() => setGroup(g)}>
              <span className="lbl">{label}</span>
              {SENSITIVE_GROUPS.has(g) && <span className="pill warn">高敏</span>}
              {groupDirty(g) > 0 && <span className="pill brand">{groupDirty(g)}</span>}
            </button>
          ))}
        </div>
        <div>
          <div className="row" style={{ marginBottom: 10 }}>
            <input placeholder="搜索文案(全部 18 组)…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
            <span className="spacer" />
            <span className="kv">{placeholderBlocked ? '有占位符缺失,保存被拦' : dirtyCount ? `本页未保存 ${dirtyCount} 处` : '无未保存改动'}</span>
            <button className="btn primary sm" disabled={!dirtyCount || saving || placeholderBlocked} onClick={saveAll}>{saving ? '保存中…' : '保存草稿'}</button>
          </div>
          {COLLECTION_NOTE[group] && <div className="note info">{COLLECTION_NOTE[group]}</div>}
          {keys.length === 0 && <div className="card"><p className="kv">没有匹配的文案 {q && <button className="btn ghost sm" onClick={() => setQ('')}>清空过滤</button>}</p></div>}
          {keys.map((k) => {
            const en = val(draft, 'en', k);
            const enTokens = tokensOf(en);
            const sensitive = SENSITIVE_GROUPS.has(group) || SENSITIVE_KEYS.includes(k);
            const liveDiff = live && ['en', 'vi', 'zh'].some((l) => (draft.copy[l as 'en'][k] ?? '') !== (live.copy[l as 'en'][k] ?? ''));
            return (
              /* 「去修复」落点。文案红项形如 `copy.zh.hero.title`,而这一页按**组**渲染,
                 组内才有 key。三语共用同一条 key,所以三种语言都标到同一张卡上。 */
              <div className="card" key={k} style={{ marginBottom: 10 }} data-field={`copy.${k}`}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <b className="mono" style={{ fontSize: 12.5 }}>{k}</b>
                  {searching && (
                    <button className="pill" style={{ cursor: 'pointer' }} title="切到这一组" onClick={() => { setGroup(k.split('.')[0]); setQ(''); }}>
                      {COPY_GROUPS[k.split('.')[0]] ?? k.split('.')[0]}
                    </button>
                  )}
                  {sensitive && <span className="pill warn">高敏 · 发布须理由</span>}
                  {(edits[k] || liveDiff) && <span className="pill">已改未发布</span>}
                  <span className="spacer" />
                  {live && (
                    <button className="btn ghost sm" onClick={() => setShowLive((s) => ({ ...s, [k]: !s[k] }))}>
                      {showLive[k] ? '收起线上值' : '查看线上值'}
                    </button>
                  )}
                  {live && (edits[k] || liveDiff) && (
                    confirmRevert === k ? (
                      <button
                        className="btn sm" style={{ background: 'var(--bad-soft)', color: 'var(--bad)' }}
                        onClick={() => {
                          setEdits((s) => ({ ...s, [k]: { en: live.copy.en[k] ?? '', vi: live.copy.vi[k] ?? '', zh: live.copy.zh[k] ?? '' } }));
                          setConfirmRevert(null);
                        }}
                      >
                        确认撤销为线上值?
                      </button>
                    ) : (
                      <button className="btn ghost sm" onClick={() => setConfirmRevert(k)}>撤销为线上值</button>
                    )
                  )}
                </div>
                {showLive[k] && live && (
                  <div className="note info" style={{ margin: '0 0 8px' }}>
                    <div className="kv" style={{ marginBottom: 4 }}>线上值(与草稿对照;发布前站上实际显示的内容)</div>
                    {(['en', 'vi', 'zh'] as const).map((loc) => (
                      <div key={loc} style={{ display: 'flex', gap: 8 }}>
                        <span className="tag" style={{ flex: 'none', width: 20 }}>{loc}</span>
                        <span style={(live.copy[loc][k] ?? '') !== val(draft, loc, k) ? { color: 'var(--warn)' } : {}}>
                          {live.copy[loc][k] || <i className="kv">(空)</i>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
                  {(['en', 'vi', 'zh'] as const).map((loc) => {
                    const v = val(draft, loc, k);
                    const hits = v ? scan(v) : [];
                    const missing = !v.trim();
                    const missTokens = loc !== 'en' && v ? enTokens.filter((t) => !tokensOf(v).includes(t)) : [];
                    return (
                      <div className="field" key={loc} style={{ margin: 0 }}>
                        {/* 缺译黄旗**可点**(CON04-⑥ 点击流矩阵写着「缺译黄旗 → 聚焦该空栏」)。
                            上一版是个纯 span:光标是默认箭头、没有点击行为 ——
                            界面上每个看起来能点的东西,要么真能点,要么别让它看起来能点(第十轮 P2-10)。 */}
                        <label>
                          {loc}{loc === 'en' && '(源)'}
                          {missing && (
                            <button
                              className="pill warn" style={{ marginLeft: 6, cursor: 'pointer' }} title="点击定位到这一栏"
                              onClick={(ev) => {
                                const box = (ev.currentTarget.closest('.field') as HTMLElement | null)?.querySelector('textarea');
                                box?.focus();
                                box?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                              }}
                            >
                              缺译
                            </button>
                          )}
                        </label>
                        <AutoTextarea
                          value={v}
                          style={hits.length || missTokens.length ? { borderColor: 'var(--bad)' } : {}}
                          onChange={(e) => setEdits((s) => ({ ...s, [k]: { ...s[k], [loc]: e.target.value } }))}
                        />
                        {hits.map((h, i) => (
                          <div className="kv" style={{ color: 'var(--bad)' }} key={i}>合规拦截 [{h.label}]:「{h.match}」——可存草稿,发布将被拒</div>
                        ))}
                        {missTokens.length > 0 && <div className="kv" style={{ color: 'var(--bad)' }}>占位符缺失:{missTokens.join(' ')}——保存被拦(缺了站上会渲染残缺)</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
