/* 草稿编辑公共钩子:overview(shell 已拉)+ 局部改写 → 保存(乐观锁 409 处理)→ 刷新。
   所有编辑页共用一个口径(单源:改 payload 的方式只有 saveDraft 一条路)。 */
import { useState } from 'react';
import { ApiError, api, toast } from '../api';
import { useShell } from '../shell';

// SiteConfig 的结构由 schema 包权威定义;控制台按使用面收窄声明,字段名与 §5.1 一字不差。
export interface Tri {
  en: string;
  vi: string;
  zh: string;
}
export interface SiteConfigView {
  copy: { en: Record<string, string>; vi: Record<string, string>; zh: Record<string, string> };
  downloads: Record<'ios' | 'android' | 'h5', { url: string; enabled: boolean }>;
  stats: { activeDevices: number; activeJobs: number; nodes: number; countries: number; uptime: number; asOf: string };
  skus: Array<{ id: string; name: string; priceUSD: number; multiplier: number; status: string; free?: boolean; tagline: Tri; sort: number; visible: boolean }>;
  faq: { items: Array<{ id: string; q: Tri; a: Tri; sort: number; visible: boolean }> };
  announcement: { id: string; enabled: boolean; text: Tri; href?: string; startsAt?: string; endsAt?: string };
  seo: { pages: Record<string, { title: Tri; description: Tri }> };
  footer: { social: Array<{ id: string; url: string; enabled: boolean }>; contactEmail: string };
  legal: Record<'terms' | 'privacy' | 'appPrivacy', { md: Tri; updatedAt: string }>;
}

export function useDraft() {
  const { overview, reload, failed } = useShell();
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const draft = overview?.draft.payload as SiteConfigView | undefined;
  const live = (overview as unknown as { live?: { payload: SiteConfigView } })?.live?.payload;

  /** mutate:拿草稿深拷贝改完交回;成功后 shell 全局刷新(状态条计数同步) */
  async function save(mutate: (d: SiteConfigView) => void, okMsg = '草稿已保存 · 未发布'): Promise<boolean> {
    if (!overview || !draft) return false;
    setSaving(true);
    setConflict(false);
    try {
      const next = structuredClone(draft);
      mutate(next);
      const res = await api<{ sanitized?: number }>('/api/config/draft', {
        method: 'PUT',
        body: JSON.stringify({ payload: next, baseRevision: overview.draft.draftRev }),
      });
      // T14 验收 P-4:剥离提示用真实计数,不用「(如有)」泛化文案
      toast(res.sanitized ? `已剥离 ${res.sanitized} 处危险内容并保存 · 未发布` : okMsg);
      reload();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true); // CON04-E3:不静默覆盖,唯一出口=刷新后重试
      } else if (e instanceof ApiError && e.status === 400) {
        toast('保存被拒:数据结构不合法');
      } else {
        toast('网络异常,保存失败,请重试');
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  return { draft, live, saving, conflict, clearConflict: () => setConflict(false), save, reload, loadFailed: failed, draftRev: overview?.draft.draftRev };
}

export const PLACEHOLDER_RE = /\{[a-zA-Z][a-zA-Z0-9_]*\}/g;
export const tokensOf = (s: string): string[] => s.match(PLACEHOLDER_RE) ?? [];
