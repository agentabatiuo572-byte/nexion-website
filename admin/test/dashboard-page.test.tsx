// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api }));

import Dashboard from '../src/pages/dashboard';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const response = {
  range: 7,
  from: '2026-09-01',
  to: '2026-09-07',
  overview: {
    traffic: { error: true },
    downloads: { ctaClicks: 3, byCta: [{ cta_id: 'ios', clicks: 3 }], deltaCta: null },
    conversion: { ctaVisitors: 1, starRate: 0.5, starRatePrev: null },
  },
  trend: { error: true },
  funnel: { error: true },
  locales: { error: true },
  dims: {
    sources: { error: true },
    countries: [{ k: 'VN', uv: 2, pv: 4 }],
    devices: [],
  },
  content: {
    pages: { error: true }, faq: { error: true }, learn: { error: true }, sections: { error: true },
  },
  quality: { error: true },
  health: { error: true },
  todayLive: { pv: 0, uv: 2, cta: 1, blocked: 0 },
};

function card(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title });
  const element = heading.closest('.card');
  if (!element) throw new Error(`card not found: ${title}`);
  return element as HTMLElement;
}

describe('dashboard card failure isolation', () => {
  it('keeps downloads, conversion and today-live visible when only the traffic card fails', async () => {
    mocks.api.mockResolvedValue(response);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByRole('heading', { name: '今日实时' });

    expect(within(card('独立访客 UV')).getByText('本卡数据查询失败', { exact: false })).toBeTruthy();
    expect(within(card('下载点击')).getByText('3')).toBeTruthy();
    expect(within(card('下载点击')).getByText('iOS 3')).toBeTruthy();
    expect(within(card('下载转化率')).getByText('50.0%')).toBeTruthy();
    expect(within(card('今日实时')).getByText('2')).toBeTruthy();
    expect(within(card('今日实时')).getByText(/点击 1/)).toBeTruthy();
  });

  it('shows a source error without hiding healthy country and device cards', async () => {
    mocks.api.mockResolvedValue(response);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByRole('heading', { name: '今日实时' });

    expect(within(card('流量来源')).getByText('本卡数据查询失败', { exact: false })).toBeTruthy();
    expect(within(card('国家/地区 Top')).getByText(/VN/)).toBeTruthy();
    expect(within(card('设备端')).getByText('暂无数据')).toBeTruthy();
  });
});

const healthy = {
  ...response,
  overview: {
    traffic: { pv: 4, uv: 2, sessions: 2, deltaUv: null, hasData: true },
    downloads: response.overview.downloads,
    conversion: response.overview.conversion,
  },
  trend: [], funnel: { uv: 2, download: 1, trust: 1, cta: 1 }, locales: [],
  dims: { sources: [], countries: [], devices: [] },
  content: { pages: [], faq: [], learn: [], sections: [] },
  quality: { latest: null, errors: null, notFound: [], notFoundTotal: null },
  health: { probes: [], botShare: null, botLegacy: false, botDays: { covered: 0, total: 0 }, blocked: 0, blockedShare: null, blockedTop: [], geo: null, lastPublish: null },
};

it.each([
  ['overview', 'traffic', '独立访客 UV'], ['overview', 'downloads', '下载点击'],
  ['overview', 'conversion', '下载转化率'], ['', 'todayLive', '今日实时'],
  ['', 'funnel', '转化漏斗'], ['', 'locales', '分语言转化'], ['', 'trend', '按日趋势'],
  ['dims', 'sources', '流量来源'], ['dims', 'countries', '国家/地区 Top'], ['dims', 'devices', '设备端'],
  ['content', 'pages', '页面 PV 榜'], ['content', 'sections', '板块曝光'],
  ['content', 'faq', 'FAQ 展开榜'], ['content', 'learn', '学习中心阅读榜'],
  ['', 'quality', '性能与质量'], ['', 'health', '运营健康'],
])('isolates failure of %s.%s without losing any of the 16 cards', async (group, key, title) => {
  const payload = structuredClone(healthy) as Record<string, any>;
  (group ? payload[group] : payload)[key] = { error: true };
  mocks.api.mockResolvedValue(payload);
  const { container } = render(<MemoryRouter><Dashboard /></MemoryRouter>);
  await screen.findByRole('heading', { name: '今日实时' });
  expect(container.querySelectorAll('.card')).toHaveLength(16);
  expect(container.querySelectorAll('.note.bad')).toHaveLength(1);
  expect(within(card(title)).getByText(/查询失败/)).toBeTruthy();
});

describe('dashboard range requests', () => {
  it.each(['resolve', 'reject'] as const)('ignores a late %s from an older range', async (outcome) => {
    let olderResolve!: (value: unknown) => void;
    let olderReject!: (reason: Error) => void;
    mocks.api.mockImplementationOnce(() => new Promise((resolve, reject) => { olderResolve = resolve; olderReject = reject; }));
    mocks.api.mockResolvedValueOnce({ ...healthy, range: 30, from: '2026-08-09' });
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '近 30 天' }));
    await screen.findByRole('heading', { name: '今日实时' });
    expect(screen.getByText('2026-08-09 — 2026-09-07')).toBeTruthy();
    await act(async () => {
      if (outcome === 'resolve') olderResolve(healthy);
      else olderReject(new Error('older range failed'));
    });
    expect(screen.getByText('2026-08-09 — 2026-09-07')).toBeTruthy();
    expect(screen.queryByText('数据获取失败')).toBeNull();
    expect(screen.getByRole('button', { name: '近 30 天' }).getAttribute('aria-pressed')).toBe('true');
    expect(mocks.api).toHaveBeenNthCalledWith(2, '/api/dash?range=30');
  });

  it('keeps range controls usable after failure and supports retry', async () => {
    mocks.api.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(healthy);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: '近 90 天' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByRole('heading', { name: '今日实时' });
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });
});

describe('honest trend display', () => {
  it('does not invent a zero curve or a total when no daily records exist', async () => {
    mocks.api.mockResolvedValue({ ...healthy, overview: { ...healthy.overview, traffic: { ...healthy.overview.traffic, hasData: false } } });
    const { container } = render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByRole('heading', { name: '按日趋势' });
    expect(within(card('按日趋势')).getByText('—')).toBeTruthy();
    expect(within(card('独立访客 UV')).getByText('—')).toBeTruthy();
    expect(container.querySelector('[data-trend-line]')).toBeNull();
    expect(container.querySelectorAll('.dash-chart-point')).toHaveLength(0);
    expect(screen.getByText('这段时间还没有访问数据')).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: '运营快捷入口' })).getByRole('link', { name: /检查下载入口/ }).getAttribute('href')).toBe('/content/downloads');
  });

  it('shows all supplied dates, leaves missing days disconnected and switches metrics without another request', async () => {
    const rows = [
      { date: '2026-09-01', uv: 2, pv: 6, cta: 1 },
      { date: '2026-09-02', uv: 4, pv: 10, cta: 2 },
      { date: '2026-09-04', uv: 3, pv: 9, cta: 0 },
      { date: '2026-09-05', uv: 5, pv: 15, cta: 3 },
    ];
    mocks.api.mockResolvedValue({ ...healthy, trend: rows });
    const { container } = render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByRole('heading', { name: '按日趋势' });
    expect(container.querySelectorAll('[data-trend-line]')).toHaveLength(2);
    expect(container.querySelectorAll('.dash-chart-point')).toHaveLength(4);
    expect(container.querySelector('.dash-trend-summary strong')?.textContent).toBe('14');
    fireEvent.click(within(card('按日趋势')).getByRole('button', { name: 'PV', exact: true }));
    expect(container.querySelector('.dash-trend-summary strong')?.textContent).toBe('40');
    fireEvent.click(within(card('按日趋势')).getByRole('button', { name: '点击', exact: true }));
    expect(container.querySelector('.dash-trend-summary strong')?.textContent).toBe('6');
    const dates = screen.getByRole('combobox', { name: '查看日期' });
    expect(within(dates).getAllByRole('option')).toHaveLength(4);
    fireEvent.change(dates, { target: { value: '2026-09-01' } });
    expect(container.querySelector('.dash-chart-readout')?.textContent).toContain('2026-09-01UV 2PV 6点击 1');
    fireEvent.click(screen.getByText('查看每日明细', { exact: false }));
    const table = screen.getByRole('table', { name: '每日访问数据' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(within(table).queryByText('2026-09-03')).toBeNull();
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it('keeps a recorded zero distinct from missing records', async () => {
    mocks.api.mockResolvedValue({ ...healthy, trend: [{ date: '2026-09-01', uv: 0, pv: 0, cta: 0 }] });
    const { container } = render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByRole('heading', { name: '按日趋势' });
    expect(container.querySelector('.dash-trend-summary strong')?.textContent).toBe('0');
    expect(container.querySelectorAll('.dash-chart-point')).toHaveLength(1);
    expect((container.querySelector('.dash-chart-point') as HTMLElement).style.top).toBe('100%');
    expect(screen.queryByText('暂未收到这段时间的汇总数据')).toBeNull();
  });

  it('keeps axis labels outside the scaled drawing and preserves exact large values in the readout', async () => {
    mocks.api.mockResolvedValue({ ...healthy, trend: [{ date: '2026-09-01', uv: 12000000, pv: 12000001, cta: 0 }] });
    const { container } = render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByRole('heading', { name: '按日趋势' });
    expect(container.querySelector('.dash-chart text')).toBeNull();
    expect(container.querySelector('.dash-chart-y-axis')?.firstElementChild?.textContent).toBe('1200万');
    expect(container.querySelector('.dash-chart-y-axis')?.firstElementChild?.getAttribute('title')).toBe('12,000,000');
    expect(container.querySelector('.dash-chart-x-axis')?.textContent).toBe('09-0109-07');
    const dates = screen.getByRole('combobox', { name: '查看日期' });
    expect(dates.tagName).toBe('SELECT');
    fireEvent.change(dates, { target: { value: '2026-09-01' } });
    expect(container.querySelector('.dash-chart-readout')?.textContent).toBe('2026-09-01UV 12,000,000PV 12,000,001点击 0');
  });

  it.each([180, 240, 480, 900])('selects every day in a flat 90-day curve at plot width %ipx, including both edges', async (width) => {
    const rows = Array.from({ length: 90 }, (_, index) => ({ date: new Date(Date.UTC(2026, 5, 10 + index)).toISOString().slice(0, 10), uv: 10, pv: 20, cta: 3 }));
    mocks.api.mockResolvedValue({ ...healthy, range: 90, from: rows[0].date, to: rows[89].date, trend: rows });
    const { container } = render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByRole('heading', { name: '按日趋势' });
    const plot = container.querySelector('.dash-chart-plot') as HTMLElement;
    const hit = container.querySelector('.dash-chart-hit') as HTMLElement;
    vi.spyOn(plot, 'getBoundingClientRect').mockReturnValue({ left: 37.5, width } as DOMRect);
    expect(plot.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('.dash-chart-point')).toHaveLength(90);
    const dates = screen.getByRole('combobox', { name: '查看日期' }) as HTMLSelectElement;
    for (let index = 0; index < rows.length; index++) {
      fireEvent.click(hit, { clientX: 37.5 + width * index / 89 });
      expect(container.querySelector('.dash-chart-readout time')?.textContent).toBe(rows[index].date);
      expect(dates.value).toBe(rows[index].date);
    }
    fireEvent.click(hit, { clientX: 33.5 });
    expect(dates.value).toBe(rows[0].date);
    fireEvent.click(hit, { clientX: 41.5 + width });
    expect(dates.value).toBe(rows[89].date);
    fireEvent.change(dates, { target: { value: rows[30].date } });
    expect(container.querySelector('.dash-chart-readout time')?.textContent).toBe(rows[30].date);
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it('selects the nearest supplied date when the pointer is over a missing day', async () => {
    mocks.api.mockResolvedValue({ ...healthy, trend: [{ date: '2026-09-01', uv: 1, pv: 2, cta: 0 }, { date: '2026-09-07', uv: 3, pv: 4, cta: 1 }] });
    const { container } = render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByRole('heading', { name: '按日趋势' });
    const plot = container.querySelector('.dash-chart-plot') as HTMLElement;
    vi.spyOn(plot, 'getBoundingClientRect').mockReturnValue({ left: 10, width: 600 } as DOMRect);
    fireEvent.mouseMove(plot, { clientX: 250 });
    expect(container.querySelector('.dash-chart-readout time')?.textContent).toBe('2026-09-01');
    fireEvent.click(plot, { clientX: 410 });
    expect(container.querySelector('.dash-chart-readout time')?.textContent).toBe('2026-09-07');
    expect(container.querySelectorAll('[data-trend-line]')).toHaveLength(0);
  });
});
