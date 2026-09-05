import { describe, expect, it } from 'vitest';
import { retainPostSubmit } from '../src/lib/async-state';

describe('retainPostSubmit', () => {
  it('removes only values from the submitted patch and keeps edits typed while the request was pending', () => {
    const submitted = {
      home: { title: { en: 'first' }, description: { en: 'saved description' } },
    };
    const current = {
      home: { title: { en: 'second' }, description: { en: 'saved description' } },
      learn: { title: { zh: '后来新增' } },
    };

    expect(retainPostSubmit(current, submitted, {})).toEqual({
      home: { title: { en: 'second' } },
      learn: { title: { zh: '后来新增' } },
    });
  });

  it('keeps an explicit edit back to the pre-submit base value after the server base becomes the submitted value', () => {
    const oldBase = 'before@example.com';
    const submitted = { footer: { contactEmail: 'submitted@example.com' } };
    const current = { footer: { contactEmail: oldBase } };

    expect(retainPostSubmit(current, submitted, {})).toEqual({ footer: { contactEmail: oldBase } });
  });

  it('clears an unchanged submitted patch', () => {
    const submitted = { footer: { contactEmail: 'ops@example.com' } };
    expect(retainPostSubmit(structuredClone(submitted), submitted, {})).toEqual({});
  });

  it('keeps the latest full-array work copy when it changed after submit', () => {
    const submitted = [{ id: 'faq-1', q: 'first' }];
    const current = [{ id: 'faq-1', q: 'second' }];
    expect(retainPostSubmit(current, submitted, null)).toEqual(current);
  });
});
