import { describe, expect, it } from 'vitest';
import { publishedSiteUrl } from '../src/lib/published-site';

describe('published site links', () => {
  it.each([
    ['http://localhost:5175', 'http://localhost:8787'],
    ['http://127.0.0.1:5175', 'http://127.0.0.1:8787'],
    ['http://[::1]:5175', 'http://[::1]:8787'],
    ['http://localhost:8787', 'http://localhost:8787'],
    ['https://nexgrid.example', 'https://nexgrid.example'],
    ['http://192.0.2.10:5175', 'http://192.0.2.10:5175'],
  ])('resolves public pages and bypass paths from %s', (origin, published) => {
    expect(publishedSiteUrl('/', origin)).toBe(published + '/');
    expect(publishedSiteUrl('/api/bypass?token=a%2Bb%2Fc&next=%2Fzh%2F#preview', origin))
      .toBe(published + '/api/bypass?token=a%2Bb%2Fc&next=%2Fzh%2F#preview');
  });

  it.each(['https://external.example/api/bypass', '//external.example/', 'javascript:alert(1)', 'https://operator@site.example/'])
    ('rejects a destination outside the published origin: %s', (path) => {
      expect(() => publishedSiteUrl(path, 'https://site.example')).toThrow();
    });
});
