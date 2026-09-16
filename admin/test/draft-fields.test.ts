import { expect, it } from 'vitest';
import seed from '../../worker/seed/site-config.seed.json';
import manifest from '../../worker/seed/copy-manifest.json';
import type { SiteConfig } from '../../schema/src/site-config';
import { applyDraftPatch, createDraftPatch, type DraftCollection } from '../../schema/src/draft-fields';

type Row = { id: string; [key: string]: unknown };
const rows = (config: SiteConfig, collection: DraftCollection): Row[] => (collection === '/faq/items' ? config.faq.items : collection === '/skus' ? config.skus : config.footer.social);
const collections: DraftCollection[] = ['/faq/items', '/skus', '/footer/social'];
const orders = [['new', 'a', 'b', 'c'], ['a', 'new', 'b', 'c'], ['a', 'b', 'c', 'new'], ['new', 'c', 'a'], ['c', 'new', 'a']];

it.each(collections.flatMap((collection) => orders.map((order) => ({ collection, order }))))('$collection preserves requested add/remove/order combination $order', ({ collection, order }) => {
  const before = structuredClone(seed) as SiteConfig;
  const list = rows(before, collection);
  const template = structuredClone(list[0]!);
  list.splice(0, list.length, ...['a', 'b', 'c'].map((id) => ({ ...structuredClone(template), id })));
  const after = structuredClone(before);
  const byId = new Map(rows(after, collection).map((item) => [item.id, item]));
  rows(after, collection).splice(0, list.length, ...order.map((id) => byId.get(id) ?? { ...structuredClone(template), id }));
  const patch = createDraftPatch(before, after, manifest);
  const result = applyDraftPatch(before, patch, manifest);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('patch unexpectedly rejected');
  expect(rows(result.config, collection)).toEqual(rows(after, collection));
  expect(rows(before, collection).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  // Applying the same structural intent again is idempotent.
  const repeated = applyDraftPatch(result.config, patch, manifest);
  expect(repeated.ok).toBe(true);
  if (repeated.ok) expect(rows(repeated.config, collection)).toEqual(rows(after, collection));
});

it('inserts a FAQ before a surviving item without replacing that item’s new AI text', () => {
  const before = structuredClone(seed) as SiteConfig, after = structuredClone(before), current = structuredClone(before);
  after.faq.items.unshift({ ...structuredClone(after.faq.items[0]!), id: 'new-question' });
  current.faq.items[0]!.a.fr = 'Fresh AI translation';
  const result = applyDraftPatch(current, createDraftPatch(before, after, manifest), manifest);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.config.faq.items[0]!.id).toBe('new-question');
    expect(result.config.faq.items[1]!.a.fr).toBe('Fresh AI translation');
  }
});
