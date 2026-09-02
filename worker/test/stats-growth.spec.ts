/* 平台数字线性增长公式(主人 2026-09-01 拍板:全后台模拟、不接真实数据,但要会自己长)。
   钉的是**承诺**:今天该显示多少、关掉时不长、以及「构建期算过一次之后不许再加一遍」。 */
import { describe, expect, it } from 'vitest';
import { daysSince, grownValue, type StatsGrowth } from '../../schema/src/stats-growth';

const G: StatsGrowth = {
  enabled: true,
  since: '2026-01-01',
  daily: { activeDevices: 12, activeJobs: 3, nodes: 0.5, countries: 0 },
};
const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

describe('平台数字线性增长', () => {
  it('按整天数增长,起算日当天不加', () => {
    expect(daysSince('2026-01-01', at('2026-01-01'))).toBe(0);
    expect(daysSince('2026-01-01', at('2026-01-11'))).toBe(10);
    expect(grownValue(1000, 'activeDevices', G, at('2026-01-01'))).toBe(1000);
    expect(grownValue(1000, 'activeDevices', G, at('2026-01-11'))).toBe(1120); // +12×10
  });

  it('小数日增量四舍五入到整数(设备数不能显示半台)', () => {
    expect(grownValue(100, 'nodes', G, at('2026-01-08'))).toBe(104); // +0.5×7 = 103.5 → 104
  });

  it('日增量为 0 的字段不动', () => {
    expect(grownValue(47, 'countries', G, at('2027-01-01'))).toBe(47);
  });

  it('关掉增长 / 没配 → 原样返回基准值', () => {
    expect(grownValue(1000, 'activeDevices', { ...G, enabled: false }, at('2027-01-01'))).toBe(1000);
    expect(grownValue(1000, 'activeDevices', undefined, at('2027-01-01'))).toBe(1000);
  });

  it('起算日在未来 → 按 0 天算,不倒着减', () => {
    expect(grownValue(1000, 'activeDevices', G, at('2025-06-01'))).toBe(1000);
  });

  it('起算日写坏 → 不抛异常、按 0 天算(站上宁可显示基准值也不能崩)', () => {
    expect(grownValue(1000, 'activeDevices', { ...G, since: '不是日期' }, at('2027-01-01'))).toBe(1000);
  });

  /* 🔴 这条钉的是页内脚本那段反推:构建期已经算过一次,脚本必须**从基准值重算**,
     不能在已增长的值上再加一遍 —— 那会让数字随访问时间越滚越离谱。 */
  it('构建期算过之后,按同一公式重算得到同一个数(不二次累加)', () => {
    const base = 1000;
    const buildDay = at('2026-03-01');
    const builtValue = grownValue(base, 'activeDevices', G, buildDay); // 构建那天的值
    const builtDays = daysSince(G.since, buildDay);
    // 页内脚本做的事:从 data-target 反推基准值,再按今天重算
    const recovered = builtValue - G.daily.activeDevices * builtDays;
    expect(recovered).toBe(base);
    const today = at('2026-03-11');
    expect(grownValue(recovered, 'activeDevices', G, today)).toBe(grownValue(base, 'activeDevices', G, today));
  });
});

/* 校验器对「模拟配置本身站不站得住」的三条判据(替代已撤除的 mock-anchor)。
   它们是这轮唯一挡在运营和一个坏配置之间的东西 —— 必须钉住它们真会报。 */
describe('自动增长的配置校验', () => {
  // manifest 就是那份落盘的 copy-manifest.json(与服务端 config.ts 同一个取法)
  const load = async () => {
    const [{ validateConfig }, manifest, seed] = await Promise.all([
      import('../../schema/src/validators'),
      import('../seed/copy-manifest.json'),
      import('../seed/site-config.seed.json'),
    ]);
    return { validateConfig, manifest: manifest.default as never, seed: seed.default as never };
  };
  const rulesOf = async (mut: (s: Record<string, unknown>) => void) => {
    const { validateConfig, manifest, seed } = await load();
    const c = structuredClone(seed) as Record<string, unknown>;
    mut(c);
    return validateConfig(c as never, manifest).warnings.map((w) => w.rule);
  };

  it('种子自身的增长配置不报警', async () => {
    expect(await rulesOf(() => {})).not.toContain('growth-noop');
  });

  it('开了增长却一个增量都没配 → 报「开关不起作用」', async () => {
    const rules = await rulesOf((c) => {
      (c.stats as { growth: { daily: Record<string, number> } }).growth.daily = { activeDevices: 0, activeJobs: 0, nodes: 0, countries: 0 };
    });
    expect(rules).toContain('growth-noop');
  });

  it('起算日在未来 → 报「要等到那天才开始长」', async () => {
    const rules = await rulesOf((c) => {
      (c.stats as { growth: { since: string } }).growth.since = '2099-01-01';
    });
    expect(rules).toContain('growth-future');
  });

  it('日增量大到约 20 天翻倍 → 报「是不是多打了一个零」', async () => {
    const rules = await rulesOf((c) => {
      const s = c.stats as { activeDevices: number; growth: { daily: Record<string, number> } };
      s.growth.daily.activeDevices = Math.ceil(s.activeDevices * 0.06);
    });
    expect(rules).toContain('growth-too-fast');
  });

  it('关掉增长 → 三条一条都不报(不该对着一个关掉的开关唠叨)', async () => {
    const rules = await rulesOf((c) => {
      const g = (c.stats as { growth: { enabled: boolean; since: string; daily: Record<string, number> } }).growth;
      g.enabled = false;
      g.since = '2099-01-01';
      g.daily.activeDevices = 999999;
    });
    expect(rules.filter((r) => r.startsWith('growth-'))).toEqual([]);
  });
});
