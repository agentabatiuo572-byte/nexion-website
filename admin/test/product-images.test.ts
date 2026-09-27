import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCT_IMAGES } from '../../src/lib/product-images';

// Approved 2026-09-27 final/manifest.json: these originals must not be re-encoded or swapped.
const APPROVED = {
  'cloud-share': '879ba27d315d2ba444343892d0af31307eed2a7cb2acf2c15080ab527a34c339',
  s1: '247322fe2330c20e12268298a89afc0bcca995872896aad7a8afbda0bf57e178',
  pro: '914b25c04666fe6ad6507ba7141ec048b359f4467b06808ab85698f8265e172a',
  'pro-v2': '5eb63d326764fda7c8bb3d96082ef7852ca625133e9cb2df0a8ade78439bab80',
  'rack-p1': '43427d42556d714bc7fa5273f43f3d974c3e62f2e3e1e66e5b9159047d4c9fa8',
  'rack-p2': '23d30faca8701c1211726ce47edbc8619fafab191e72737842fe53cfde3572c7',
};

describe('approved product artwork', () => {
  it.each(Object.entries(APPROVED))('preserves the final %s pixels and square dimensions', (id, hash) => {
    const asset = PRODUCT_IMAGES[id];
    expect(asset).toBeDefined();
    const bytes = readFileSync(new URL('../../public' + asset, import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1254, 1254]);
  });

  it('retains Phone and does not introduce a Genesis product slot', () => {
    expect(PRODUCT_IMAGES.phone).toBe('/devices/phone.webp');
    expect(Object.keys(PRODUCT_IMAGES).sort()).toEqual(['phone', ...Object.keys(APPROVED)].sort());
    expect(PRODUCT_IMAGES.genesis).toBeUndefined();
  });
});
