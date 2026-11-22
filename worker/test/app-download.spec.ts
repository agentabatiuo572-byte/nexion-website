import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';

const ios = 'https://third-party.example/releases/mobile?channel=website';
const android = 'https://downloads.example/app.apk';
const downloads = {
  ios: { enabled: true, url: ios },
  android: { enabled: true, url: android },
};

async function addVersion(status: string, config: unknown) {
  await env.DB.prepare('INSERT INTO config_versions(status,payload,created_at) VALUES(?1,?2,1)')
    .bind(status, JSON.stringify({ downloads: config })).run();
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM config_versions'), env.DB.prepare('DELETE FROM config_draft')]);
});

describe('published website app downloads', () => {
  it('uses the latest published settings and ignores draft and pending changes', async () => {
    await addVersion('live', downloads);
    await env.DB.prepare('INSERT INTO config_draft(id,payload,base_revision,updated_at) VALUES(1,?1,1,1)')
      .bind(JSON.stringify({ downloads: {} })).run();
    await addVersion('publishing', {});
    for (const [platform, target] of [['ios', ios], ['android', android]]) {
      const response = await app.request(`/api/app-download/${platform}`, {}, env);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(target);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }

    const newUrl = 'https://downloads.example/new.apk';
    await addVersion('live', { ...downloads, android: { enabled: true, url: newUrl } });
    const response = await app.request('/api/app-download/android?url=https://untrusted.example', { method: 'HEAD' }, env);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(newUrl);
    expect(await response.text()).toBe('');
  });

  it('returns unavailable for missing, disabled, invalid or unsupported published destinations', async () => {
    const request = () => app.request('/api/app-download/ios', {}, env);
    expect((await request()).status).toBe(503);
    for (const entry of [
      { enabled: false, url: ios }, { enabled: true, url: '' }, { enabled: true, url: null },
      { enabled: true, url: 'http://third-party.example/install' },
      { enabled: true, url: 'https://user:pass@apps.apple.com/app/id123456789' },
    ]) {
      await addVersion('live', { ios: entry });
      const response = await request();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'download-unavailable' });
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('retry-after')).toBe('5');
    }
    await addVersion('live', downloads);
    expect((await request()).status).toBe(302);
  });

  it('rejects writes and unknown platforms', async () => {
    const write = await app.request('/api/app-download/ios', { method: 'POST', body: 'ignored' }, env);
    expect(write.status).toBe(405);
    expect(write.headers.get('allow')).toBe('GET, HEAD');
    expect((await app.request('/api/app-download/windows', {}, env)).status).toBe(404);
  });
});
