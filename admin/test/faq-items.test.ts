import { describe, expect, it } from 'vitest';
import { appendMintedFaqItem, type FaqItemValue } from '../src/lib/faq-items';

const item = (question: string): FaqItemValue => ({
  id: 'faq-1',
  q: { en: question, vi: '', zh: '' },
  a: { en: 'answer', vi: '', zh: '' },
  sort: 1,
  visible: true,
});

describe('appendMintedFaqItem', () => {
  it('appends to the latest work copy instead of the copy captured before the slow request', () => {
    const beforeRequest = [item('before')];
    const editedWhileWaiting = [item('edited while waiting')];
    const next = appendMintedFaqItem(editedWhileWaiting, beforeRequest, 'faq-2');

    expect(next[0]?.q.en).toBe('edited while waiting');
    expect(next[1]).toMatchObject({ id: 'faq-2', sort: 2, visible: true });
  });
});
