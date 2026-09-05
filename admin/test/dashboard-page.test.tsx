// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
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
    expect(within(card('北极星转化率')).getByText('50.0%')).toBeTruthy();
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
  ['overview', 'conversion', '北极星转化率'], ['', 'todayLive', '今日实时'],
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
