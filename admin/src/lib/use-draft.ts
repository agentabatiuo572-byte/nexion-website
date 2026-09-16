/* 草稿编辑公共钩子:overview(shell 已拉)+ 局部改写 → 保存(乐观锁 409 处理)→ 刷新。
   所有编辑页共用一个口径(单源:改 payload 的方式只有 saveDraft 一条路)。 */
import { useRef, useState } from 'react';
import { ApiError, api, toast } from '../api';
import { useShell, useUnsavedChanges } from '../shell';
import type { Locale } from '../../../schema/src/locales';
import type { SiteConfig } from '../../../schema/src/site-config';
import { createDraftPatch, enumerateDraftFields } from '../../../schema/src/draft-fields';
export { pointer } from '../../../schema/src/draft-fields';
import manifest from '../../../worker/seed/copy-manifest.json';

// SiteConfig 的结构由 schema 包权威定义;控制台按使用面收窄声明,字段名与 §5.1 一字不差。
export type Tri = Record<Locale, string>;
export interface SiteConfigView {
  enabledLocales: Locale[];
  copy: Record<Locale, Record<string, string>>;
  downloads: Record<'ios' | 'android' | 'h5', { url: string; enabled: boolean }>;
  stats: { activeDevices: number; activeJobs: number; nodes: number; countries: number; uptime: number; asOf: string };
  skus: Array<{ id: string; name: string; priceUSD: number; multiplier: number; status: string; free?: boolean; tagline: Tri; sort: number; visible: boolean }>;
  faq: { items: Array<{ id: string; q: Tri; a: Tri; sort: number; visible: boolean }> };
  announcement: { id: string; enabled: boolean; text: Tri; href?: string; startsAt?: string; endsAt?: string };
  seo: { pages: Record<string, { title: Tri; description: Tri }> };
  footer: { social: Array<{ id: string; url: string; enabled: boolean }>; contactEmail: string };
  legal: Record<'terms' | 'privacy' | 'appPrivacy', { md: Tri; updatedAt: string }>;
}

export function useDraft(hasUnsavedChanges = false) {
  const { overview, reload, failed } = useShell();
  useUnsavedChanges(hasUnsavedChanges);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [conflictFields, setConflictFields] = useState<Array<{ fieldId: string; current: unknown }>>([]);
  const inFlight = useRef(false);
  const baseline = useRef<{ payload: SiteConfigView; revision: number } | null>(null);

  const draft = overview?.draft.payload as SiteConfigView | undefined;
  const live = overview?.live?.payload as SiteConfigView | undefined;
  // Capture the last clean render. A poll during editing must not become the edit's baseline.
  if (draft && (!baseline.current || (!hasUnsavedChanges && !inFlight.current))) {
    baseline.current = { payload: structuredClone(draft), revision: overview!.draft.draftRev };
  }

  /** mutate:拿草稿深拷贝改完交回;成功后 shell 全局刷新(状态条计数同步) */
  async function save(mutate: (d: SiteConfigView) => void, okMsg = '草稿已保存 · 未发布', manualFields: string[] = []): Promise<boolean> {
    if (!overview || !draft || !baseline.current || inFlight.current) return false;
    inFlight.current = true;
    setSaving(true);
    setConflict(false);
    setConflictFields([]);
    try {
      const started = baseline.current;
      const next = structuredClone(started.payload);
      mutate(next);
      const operations = createDraftPatch(started.payload as SiteConfig, next as SiteConfig, manifest);
      const beforeFields = new Map(enumerateDraftFields(started.payload as SiteConfig, manifest).map((field) => [field.fieldId, field.value]));
      const afterFields = new Map(enumerateDraftFields(next as SiteConfig, manifest).map((field) => [field.fieldId, field.value]));
      for (const fieldId of new Set(manualFields)) {
        if (beforeFields.has(fieldId) && afterFields.has(fieldId) && !operations.some((operation) => operation.op === 'set' && operation.fieldId === fieldId)) {
          operations.push({ op: 'set', fieldId, before: beforeFields.get(fieldId), after: afterFields.get(fieldId) });
        }
      }
      const res = await api<{ sanitized?: number; draftRev: number }>('/api/config/draft', {
        method: 'PATCH',
        body: JSON.stringify({ operations, baseRevision: started.revision }),
      });
      // Retained full working copies still contain pre-poll fields. Advance to the submitted
      // working copy, not the server's extra AI fields, so the second save carries only new intent.
      baseline.current = { payload: next, revision: res.draftRev };
      // T14 验收 P-4:剥离提示用真实计数,不用「(如有)」泛化文案
      const refreshed = await reload();
      if (!refreshed) {
        toast('草稿已经保存，但最新状态读取失败；本页改动已保留，请刷新确认');
        return false;
      }
      toast(res.sanitized ? `已剥离 ${res.sanitized} 处危险内容并保存 · 未发布` : okMsg);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true);
        if (Array.isArray(e.body.conflicts)) setConflictFields(e.body.conflicts.filter((field): field is { fieldId: string; current: unknown } => !!field && typeof field === 'object' && typeof field.fieldId === 'string'));
      } else if (e instanceof ApiError && e.status === 400) {
        toast('保存被拒:数据结构不合法');
      } else {
        toast('网络异常,保存失败,请重试');
      }
      return false;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return { draft, live, editingBase: baseline.current?.payload, saving, conflict, conflictFields, clearConflict: () => { setConflict(false); setConflictFields([]); }, save, reload, loadFailed: failed, draftRev: overview?.draft.draftRev };
}

export const PLACEHOLDER_RE = /\{[a-zA-Z][a-zA-Z0-9_]*\}/g;
export const tokensOf = (s: string): string[] => s.match(PLACEHOLDER_RE) ?? [];
